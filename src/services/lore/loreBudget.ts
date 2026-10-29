/**
 * Adaptive lore budget — how many tokens of lore a turn may spend, and how
 * strict the relevance floor is.
 *
 * Works like an effort setting: `loreDepth` picks a ceiling (a share of the
 * provider's context window, clamped to a min/max), and the retriever spends
 * only what clears the relevance floor underneath it. A quiet scene uses
 * little; a scene naming several lore entries can use up to the ceiling.
 */

export type LoreDepth = 'lean' | 'balanced' | 'deep';

export const DEFAULT_LORE_DEPTH: LoreDepth = 'balanced';

type LoreDepthProfile = {
    /** Fraction of `contextLimit` the ceiling scales with. */
    pct: number;
    /** Ceiling floor, so small context windows still get usable lore. */
    min: number;
    /** Ceiling cap, so huge context windows don't flood the world block. */
    max: number;
    /**
     * Relevance floor: a chunk ranked within the top `topN` of the keyword or
     * meaning search counts as relevant on that search alone. Deeper settings
     * are more lenient.
     */
    topN: number;
};

export const LORE_DEPTH_PROFILES: Record<LoreDepth, LoreDepthProfile> = {
    lean: { pct: 0.05, min: 600, max: 2500, topN: 2 },
    // min 1200 keeps the old fixed 1200-token budget as the floor for small windows.
    balanced: { pct: 0.10, min: 1200, max: 5000, topN: 3 },
    deep: { pct: 0.15, min: 2000, max: 8000, topN: 5 },
};

export function normalizeLoreDepth(raw: unknown): LoreDepth {
    return raw === 'lean' || raw === 'balanced' || raw === 'deep' ? raw : DEFAULT_LORE_DEPTH;
}

/** Token ceiling for lore retrieval at the given context window and depth. */
export function computeLoreBudget(contextLimit: number | undefined, depth: LoreDepth = DEFAULT_LORE_DEPTH): number {
    const profile = LORE_DEPTH_PROFILES[depth] ?? LORE_DEPTH_PROFILES[DEFAULT_LORE_DEPTH];
    const limit = Number.isFinite(contextLimit) && (contextLimit as number) > 0 ? (contextLimit as number) : 8192;
    const scaled = Math.floor(limit * profile.pct);
    return Math.min(profile.max, Math.max(profile.min, scaled));
}

/** Relevance-floor leniency for the given depth. */
export function loreRelevanceTopN(depth: LoreDepth = DEFAULT_LORE_DEPTH): number {
    return (LORE_DEPTH_PROFILES[depth] ?? LORE_DEPTH_PROFILES[DEFAULT_LORE_DEPTH]).topN;
}
