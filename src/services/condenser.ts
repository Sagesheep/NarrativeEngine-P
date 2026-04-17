import type { ChatMessage, GameContext, EndpointConfig, ProviderConfig } from '../types';

import { countTokens } from './tokenizer';

const VERBATIM_WINDOW = 8;
const CONDENSE_BUDGET_RATIO = 0.85;
const META_SUMMARY_THRESHOLD = 6000;
const MIN_CANDIDATE_MESSAGES = 3; // minimum new messages beyond verbatim window to justify a condense pass

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
    newTurns: ChatMessage[],
    canonState: string,
    headerIndex: string
): string {
    const canonBlock = [canonState, headerIndex].filter(Boolean).join('\n\n');

    const turns = newTurns
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    const parts: string[] = [
        'You are a TTRPG session scribe. Summarize the following chat turns into concise bullet points.',
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

    parts.push('', 'TURNS TO SUMMARIZE:', turns);

    return parts.join('\n');
}

function buildMetaSummaryPrompt(combinedSummary: string): string {
    return [
        'You are a TTRPG session scribe. The following condensed session summary has grown too large and must be re-compressed to approximately 6000 tokens.',
        '',
        'RULES:',
        '1. Preserve ALL character names, Spirit Card names, location names EXACTLY',
        '2. Preserve ALL active threats, unresolved plot hooks, and character state (card loadouts, relationships, physical descriptions)',
        '3. Compress OLDER events more aggressively — keep recent events (last ~20%) more detailed',
        '4. Never merge separate events into vague statements — each scene should remain distinguishable',
        '5. Maintain the bullet-point format grouped by scene/event',
        '6. Target length: ~6000 tokens',
        '',
        'FULL SUMMARY TO COMPRESS:',
        combinedSummary,
    ].join('\n');
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

    if (candidateToCondense.length < MIN_CANDIDATE_MESSAGES) {
        return { summary: existingSummary, upToIndex: condensedUpToIndex };
    }

    const url = `${provider.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;

    // --- Step 1: Compress new turns only (no existing summary in prompt) ---
    const budgetLimit = Math.floor(contextLimit * CONDENSE_BUDGET_RATIO);
    const basePromptPart = buildCondenserPrompt([], context.canonState, context.headerIndex);
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
        context.headerIndex
    );

    console.log('[Condenser] Sending condensation request (new turns only)...', {
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
    const newChunk = data.choices?.[0]?.message?.content ?? '';

    if (!newChunk) {
        console.warn('[Condenser] LLM returned empty summary, keeping existing.');
        return { summary: existingSummary, upToIndex: condensedUpToIndex };
    }

    // --- Step 2: Append-only — never overwrite old content ---
    const combinedSummary = existingSummary
        ? existingSummary + '\n\n' + newChunk
        : newChunk;

    console.log('[Condenser] New chunk appended.', {
        existingTokens: countTokens(existingSummary || ''),
        newChunkTokens: countTokens(newChunk),
        combinedTokens: countTokens(combinedSummary)
    });

    // --- Step 3: Meta-compression if over threshold ---
    let finalSummary = combinedSummary;
    if (countTokens(combinedSummary) > META_SUMMARY_THRESHOLD) {
        console.log('[Condenser] Combined summary exceeds 6k tokens — running meta-compression...', {
            tokens: countTokens(combinedSummary)
        });

        const metaPrompt = buildMetaSummaryPrompt(combinedSummary);

        console.log('[Condenser] Sending meta-compression request...', {
            promptTokens: countTokens(metaPrompt)
        });

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
            const metaResult = metaData.choices?.[0]?.message?.content;
            if (metaResult && metaResult.length > 0) {
                finalSummary = metaResult;
                console.log('[Condenser] Meta-compression complete.', {
                    before: countTokens(combinedSummary),
                    after: countTokens(finalSummary)
                });
            } else {
                console.warn('[Condenser] Meta-compression returned empty, keeping combined summary.');
            }
        } else {
            console.error('[Condenser] Meta-compression API failed, keeping combined summary.');
        }
    }

    const newUpToIndex = lastMsgInChunk ? messages.indexOf(lastMsgInChunk) : condensedUpToIndex;

    console.log(`[Condenser] Pass complete. Markers advanced to index: ${newUpToIndex}`, {
        finalTokens: countTokens(finalSummary)
    });

    return { summary: finalSummary, upToIndex: newUpToIndex };
}
