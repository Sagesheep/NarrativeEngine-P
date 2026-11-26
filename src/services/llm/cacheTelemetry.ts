import { useSyncExternalStore } from 'react';

/**
 * Cache telemetry: a lightweight, persisted rollup of prompt-cache performance,
 * bucketed by day and by call label (e.g. "story-generation", "npc-generation").
 *
 * DeepSeek returns prompt_cache_hit_tokens / prompt_cache_miss_tokens on every
 * response; we accumulate them here so app performance is observable across
 * sessions instead of being reverse-engineered from payload diffs. Persists to
 * localStorage (sync, survives reload); prunes to the most recent N days.
 *
 * Ported from mobileApp/src/services/llm/cacheTelemetry.ts during the settings
 * tab port — mainApp had no equivalent.
 */

export interface LLMUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** DeepSeek: input tokens served from the context cache. */
    prompt_cache_hit_tokens?: number;
    /** DeepSeek: input tokens that were NOT cached (full price). */
    prompt_cache_miss_tokens?: number;
}

export interface CallStat {
    calls: number;
    hitTokens: number;
    missTokens: number;
    promptTokens: number;
    completionTokens: number;
}

/** date (YYYY-MM-DD) → call label → aggregated stats */
export type CacheRollup = Record<string, Record<string, CallStat>>;

const STORAGE_KEY = 'cacheTelemetry.v1';
const RETAIN_DAYS = 14;

let rollup: CacheRollup = load();
const listeners = new Set<() => void>();

function load(): CacheRollup {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? (JSON.parse(raw) as CacheRollup) : {};
    } catch {
        return {};
    }
}

function persist() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(rollup));
    } catch {
        /* storage unavailable / quota — telemetry is best-effort */
    }
}

function emit() {
    for (const l of listeners) l();
}

function dayKey(ts = Date.now()): string {
    return new Date(ts).toISOString().slice(0, 10);
}

function prune() {
    const days = Object.keys(rollup).sort();
    while (days.length > RETAIN_DAYS) {
        const oldest = days.shift();
        if (oldest) delete rollup[oldest];
    }
}

/**
 * Record one LLM call's token usage. No-op when the provider didn't return the
 * cache split (non-DeepSeek), so only cache-capable calls affect the ratio.
 */
export function recordCacheUsage(label: string, usage: LLMUsage | undefined): void {
    if (!usage) return;
    const hasCacheSplit =
        usage.prompt_cache_hit_tokens !== undefined ||
        usage.prompt_cache_miss_tokens !== undefined;
    if (!hasCacheSplit) return;

    const day = dayKey();
    const byLabel = (rollup[day] ??= {});
    const stat = (byLabel[label] ??= {
        calls: 0,
        hitTokens: 0,
        missTokens: 0,
        promptTokens: 0,
        completionTokens: 0,
    });

    stat.calls += 1;
    stat.hitTokens += usage.prompt_cache_hit_tokens ?? 0;
    stat.missTokens += usage.prompt_cache_miss_tokens ?? 0;
    stat.promptTokens += usage.prompt_tokens ?? 0;
    stat.completionTokens += usage.completion_tokens ?? 0;

    prune();
    persist();
    emit();
}

export function getCacheRollup(): CacheRollup {
    return rollup;
}

/** Hit ratio (0–1) for a stat; cache hits / total prompt input. */
export function hitRatio(stat: CallStat): number {
    const denom = stat.hitTokens + stat.missTokens;
    return denom > 0 ? stat.hitTokens / denom : 0;
}

/** Collapse a day's per-label stats into a single total. */
export function totalsForDay(day: string): CallStat | null {
    const byLabel = rollup[day];
    if (!byLabel) return null;
    return Object.values(byLabel).reduce<CallStat>(
        (acc, s) => ({
            calls: acc.calls + s.calls,
            hitTokens: acc.hitTokens + s.hitTokens,
            missTokens: acc.missTokens + s.missTokens,
            promptTokens: acc.promptTokens + s.promptTokens,
            completionTokens: acc.completionTokens + s.completionTokens,
        }),
        { calls: 0, hitTokens: 0, missTokens: 0, promptTokens: 0, completionTokens: 0 },
    );
}

export function clearCacheTelemetry(): void {
    rollup = {};
    persist();
    emit();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

let snapshotRef: CacheRollup = rollup;
listeners.add(() => { snapshotRef = { ...rollup }; });

export function useCacheTelemetry(): CacheRollup {
    return useSyncExternalStore(subscribe, () => snapshotRef, () => snapshotRef);
}