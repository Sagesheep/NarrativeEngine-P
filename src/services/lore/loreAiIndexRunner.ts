/**
 * loreAiIndexRunner.ts
 * --------------------
 * "Run AI indexing" on the Lore tab: asks the utility model for one index line per lore entry
 * that has none (or whose text changed since), in batches. Each finished batch is handed to
 * `onBatch` so the caller can save it at once; stopping mid-run keeps what was written.
 * Prompt, parsing and freshness rules are in loreAiIndex.ts.
 */

import type { EndpointConfig, LoreChunk, ProviderConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import { buildAiIndexPrompt, chunksNeedingAiIndex, loreIndexHash, readAiIndexReply } from './loreAiIndex';

export const AI_INDEX_BATCH_SIZE = 10;

export type AiIndexProgress = { done: number; total: number; written: number; failedBatches: number };

export type AiIndexCall = (prompt: string, signal?: AbortSignal) => Promise<string>;

export function utilityAiIndexCall(endpoint: EndpointConfig | ProviderConfig): AiIndexCall {
    return (prompt, signal) => llmCall(endpoint, prompt, {
        temperature: 0.2,
        priority: 'normal',
        maxTokens: 1600,
        thinkingEffort: 'off',
        trackingLabel: 'lore-ai-index',
        timeoutMs: AI_CALL_TIMEOUT_MS,
        signal,
    });
}

export async function runAiLoreIndexing(options: {
    chunks: LoreChunk[];
    call: AiIndexCall;
    onBatch: (lines: Map<string, string>, hashes: Map<string, string>) => void;
    onProgress?: (progress: AiIndexProgress) => void;
    signal?: AbortSignal;
    batchSize?: number;
}): Promise<AiIndexProgress> {
    const todo = chunksNeedingAiIndex(options.chunks);
    const size = options.batchSize ?? AI_INDEX_BATCH_SIZE;
    const progress: AiIndexProgress = { done: 0, total: todo.length, written: 0, failedBatches: 0 };
    options.onProgress?.({ ...progress });

    for (let i = 0; i < todo.length; i += size) {
        if (options.signal?.aborted) break;
        const batch = todo.slice(i, i + size);
        try {
            const raw = await options.call(buildAiIndexPrompt(batch), options.signal);
            const { value, parseOk } = extractJsonRobust<Record<string, unknown>>(raw, {});
            if (!parseOk) throw new Error('No JSON object in the reply');
            const lines = readAiIndexReply(value, batch);
            const hashes = new Map(batch.filter(c => lines.has(c.id)).map(c => [c.id, loreIndexHash(c)]));
            if (lines.size > 0) options.onBatch(lines, hashes);
            progress.written += lines.size;
        } catch (err) {
            if (options.signal?.aborted) break;
            progress.failedBatches++;
            console.warn(`[LoreAiIndex] Batch ${i / size + 1} failed, skipping:`, err);
        }
        progress.done += batch.length;
        options.onProgress?.({ ...progress });
    }
    return progress;
}
