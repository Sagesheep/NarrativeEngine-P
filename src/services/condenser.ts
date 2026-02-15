import type { AppSettings, ChatMessage, GameContext } from '../types';

const VERBATIM_WINDOW = 5;
const CONDENSE_BUDGET_RATIO = 0.4;

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export function shouldCondense(
    messages: ChatMessage[],
    contextLimit: number,
    condensedUpToIndex: number
): boolean {
    const uncondensedMessages = messages.slice(condensedUpToIndex + 1);
    if (uncondensedMessages.length <= VERBATIM_WINDOW) return false;

    const historyTokens = estimateTokens(
        uncondensedMessages.map((m) => m.content).join('')
    );
    return historyTokens > contextLimit * CONDENSE_BUDGET_RATIO;
}

export function getVerbatimWindow(): number {
    return VERBATIM_WINDOW;
}

function buildCondenserPrompt(
    oldMessages: ChatMessage[],
    canonState: string,
    headerIndex: string,
    existingSummary: string
): string {
    const canonBlock = [canonState, headerIndex].filter(Boolean).join('\n\n');

    const turns = oldMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    const parts: string[] = [
        'You are a TTRPG session scribe. Compress the following chat turns into concise bullet points.',
        '',
        'RULES:',
        '1. Preserve ALL dice rolls, damage numbers, HP/MP changes exactly',
        '2. Preserve ALL item names, NPC names, location names EXACTLY as written',
        '3. Use the Canonical Terms below — DO NOT paraphrase, rename, or synonym-swap any proper nouns',
        '4. Keep quest/objective updates',
        '5. Drop flavour text and generic narration',
        '6. Output format: bullet points grouped by scene/event',
        '7. Be extremely concise — aim for 70% compression',
    ];

    if (canonBlock) {
        parts.push('', 'CANONICAL TERMS (use these exact strings):', canonBlock);
    }

    if (existingSummary) {
        parts.push('', 'PREVIOUS CONDENSED SUMMARY (incorporate and update):', existingSummary);
    }

    parts.push('', 'TURNS TO SUMMARIZE:', turns);

    return parts.join('\n');
}

export async function condenseHistory(
    settings: AppSettings,
    messages: ChatMessage[],
    context: GameContext,
    condensedUpToIndex: number,
    existingSummary: string
): Promise<{ summary: string; upToIndex: number }> {
    const uncondensed = messages.slice(condensedUpToIndex + 1);
    const toCondense = uncondensed.slice(0, -VERBATIM_WINDOW);

    if (toCondense.length === 0) {
        return { summary: existingSummary, upToIndex: condensedUpToIndex };
    }

    const prompt = buildCondenserPrompt(
        toCondense,
        context.canonState,
        context.headerIndex,
        existingSummary
    );

    const url = `${settings.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey) {
        headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: settings.modelName,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
        }),
    });

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Condenser API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const summary = data.choices?.[0]?.message?.content ?? existingSummary;

    const lastCondensedMsg = toCondense[toCondense.length - 1];
    const newUpToIndex = messages.indexOf(lastCondensedMsg);

    return { summary, upToIndex: newUpToIndex };
}
