import type { ChatMessage, GameContext, EndpointConfig, ProviderConfig } from '../types';

import { countTokens } from './tokenizer';

const VERBATIM_WINDOW = 8;
const CONDENSE_BUDGET_RATIO = 0.75;
const META_SUMMARY_THRESHOLD = 6000;

export function shouldCondense(
    messages: ChatMessage[],
    contextLimit: number,
    condensedUpToIndex: number
): boolean {
    const uncondensedMessages = messages.slice(condensedUpToIndex + 1);
    if (uncondensedMessages.length <= VERBATIM_WINDOW) return false;

    const historyTokens = countTokens(
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
        '4. Drop flavour text and generic narration',
        '5. EXCEPTION: Tag any memorable/dramatic moments (epic quotes, confessions, dramatic reveals, promises) with [MEMORABLE: "exact quote or moment"]. These survive future compression.',
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
    provider: EndpointConfig | ProviderConfig,
    messages: ChatMessage[],
    context: GameContext,
    condensedUpToIndex: number,
    existingSummary: string,
    _campaignId: string,
    _npcNames: string[],
    contextLimit: number,
    signal?: AbortSignal
): Promise<{ summary: string; upToIndex: number }> {
    const uncondensed = messages.slice(condensedUpToIndex + 1);
    const candidateToCondense = uncondensed.slice(0, -VERBATIM_WINDOW);

    if (candidateToCondense.length === 0) {
        return { summary: existingSummary, upToIndex: condensedUpToIndex };
    }

    let finalExistingSummary = existingSummary;
    const url = `${provider.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

    // --- Phase 4: T3 → T4 Promotion ---
    if (finalExistingSummary && countTokens(finalExistingSummary) > META_SUMMARY_THRESHOLD) {
        console.log('[Archive Memory] Promoting T3 summary to meta-summary...', { tokens: countTokens(finalExistingSummary) });
        const metaPrompt = `You are a TTRPG session scribe. Compress the following older session summary into a highly condensed story-arc level summary (max 3 paragraphs). Preserve major character deaths, epic loot, and unresolved plot hooks.\n\nOLDER SUMMARY:\n${finalExistingSummary}`;

        console.log('[Condenser] Sending T3 meta-summary request...', { promptTokens: countTokens(metaPrompt) });

        const metaRes = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: provider.modelName,
                messages: [{ role: 'user', content: metaPrompt }],
                stream: false,
            }),
            signal,
        });

        if (metaRes.ok) {
            const metaData = await metaRes.json();
            finalExistingSummary = metaData.choices?.[0]?.message?.content ?? '';
            console.log('[Archive Memory] T3 successfully meta-summarized.');
        } else {
            console.error('[Archive Memory] Meta-summary API failed, retaining old T3 summary.');
        }
    }

    // --- Standard Condensation with Budgeting ---
    const budgetLimit = Math.floor(contextLimit * CONDENSE_BUDGET_RATIO);

    // Calculate invariant prompt overhead (rules + canon + existing summary)
    const basePromptPart = buildCondenserPrompt([], context.canonState, context.headerIndex, finalExistingSummary);
    const baseTokens = countTokens(basePromptPart);

    let toCondense: ChatMessage[] = [];
    let usedTokens = baseTokens;
    let lastMsgInChunk: ChatMessage | null = null;

    for (const msg of candidateToCondense) {
        const turnText = `\n\n[${msg.role.toUpperCase()}]: ${msg.content}`;
        const cost = countTokens(turnText);

        if (usedTokens + cost > budgetLimit && toCondense.length > 0) {
            console.log(`[Condenser] Budget limit reached. Condensing chunk of ${toCondense.length} turns.`, {
                totalTokens: usedTokens,
                limit: budgetLimit
            });
            break;
        }

        toCondense.push(msg);
        usedTokens += cost;
        lastMsgInChunk = msg;
    }

    const prompt = buildCondenserPrompt(
        toCondense,
        context.canonState,
        context.headerIndex,
        finalExistingSummary
    );

    console.log('[Condenser] Sending condensation request...', {
        turns: toCondense.length,
        promptTokens: countTokens(prompt),
        budgetLimit
    });

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: provider.modelName,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
        }),
        signal,
    });

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Condenser API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const summary = data.choices?.[0]?.message?.content ?? existingSummary;

    // Use the last message that was actually included in the chunk for correct index alignment
    const newUpToIndex = lastMsgInChunk ? messages.indexOf(lastMsgInChunk) : condensedUpToIndex;

    console.log(`[Condenser] Extraction complete. Markers advanced to index: ${newUpToIndex}`);

    return { summary, upToIndex: newUpToIndex };
}
