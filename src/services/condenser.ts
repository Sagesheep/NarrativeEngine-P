import type { ChatMessage, GameContext, ProviderConfig } from '../types';

import { countTokens } from './tokenizer';
import { buildArchiveChunk } from './archiveMemory';
import { saveArchiveChunk } from '../store/campaignStore';

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
    provider: ProviderConfig,
    messages: ChatMessage[],
    context: GameContext,
    condensedUpToIndex: number,
    existingSummary: string,
    campaignId: string,
    npcNames: string[]
): Promise<{ summary: string; upToIndex: number }> {
    const uncondensed = messages.slice(condensedUpToIndex + 1);
    const toCondense = uncondensed.slice(0, -VERBATIM_WINDOW);

    if (toCondense.length === 0) {
        return { summary: existingSummary, upToIndex: condensedUpToIndex };
    }

    let finalExistingSummary = existingSummary;
    const url = `${provider.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

    // --- Phase 4: T3 → T4 Promotion ---
    if (finalExistingSummary && countTokens(finalExistingSummary) > META_SUMMARY_THRESHOLD) {
        console.log('[Archive Memory] Promoting T3 summary to T4 archive chunk...', { tokens: countTokens(finalExistingSummary) });
        const chunk = buildArchiveChunk(finalExistingSummary, context.headerIndex || 'Unknown Scene', npcNames);
        await saveArchiveChunk(campaignId, chunk);

        const metaPrompt = `You are a TTRPG session scribe. Compress the following older session summary into a highly condensed story-arc level summary (max 3 paragraphs). Preserve major character deaths, epic loot, unresolved plot hooks, and major quest completions.\n\nOLDER SUMMARY:\n${finalExistingSummary}`;

        const metaRes = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: provider.modelName,
                messages: [{ role: 'user', content: metaPrompt }],
                stream: false,
            }),
        });

        if (metaRes.ok) {
            const metaData = await metaRes.json();
            finalExistingSummary = metaData.choices?.[0]?.message?.content ?? '';
            console.log('[Archive Memory] T3 successfully meta-summarized.');
        } else {
            console.error('[Archive Memory] Meta-summary API failed, retaining old T3 summary.');
        }
    }

    // --- Standard Condensation ---
    const prompt = buildCondenserPrompt(
        toCondense,
        context.canonState,
        context.headerIndex,
        finalExistingSummary
    );

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: provider.modelName,
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
