/**
 * archive-memory/dynamicMax.ts
 *
 * Consensus-based recall ceiling, sized for desktop. More agreement between the
 * keyword and embedding rankers → more scenes returned. This is only an upper
 * bound — the caller takes min(ceiling, scenes that actually matched), so a high
 * ceiling never pads with noise.
 *
 * mobileApp caps recall at 3/4/5 (a phone token/CPU ration). mainApp is desktop +
 * server-backed and recalls deeper; the shape (more agreement → more scenes) is
 * preserved, only the ceiling moves.
 */

export type RecallDepth = 'lean' | 'standard' | 'deep';

const DEPTH_TIERS: Record<RecallDepth, { high: number; mid: number; low: number }> = {
    lean: { high: 5, mid: 4, low: 3 },        // mobile parity
    standard: { high: 10, mid: 7, low: 5 },   // desktop default
    deep: { high: 12, mid: 9, low: 7 },
};

// Planner-selected scenes get an additive relevance nudge, scaled to IDF magnitude (~1-6),
// not the old flat +3.5 which would have swamped the keyword score.
export const PLANNER_RELEVANCE_BOOST = 2.0;

export function computeDynamicMax(
    keywordRanked: string[],
    embeddingRanked: string[],
    depth: RecallDepth,
    topKeywordRelevance: number,
    maxScenes?: number,
): number {
    if (maxScenes !== undefined) return maxScenes;
    const tiers = DEPTH_TIERS[depth];

    // Keyword-only path (no embedding ranker available): size by keyword strength so we don't
    // regress to the floor. Mirrors mainApp's pre-fusion magnitude heuristic, mapped to the
    // depth's raised tiers.
    if (embeddingRanked.length === 0) {
        if (topKeywordRelevance > 15) return tiers.high;
        if (topKeywordRelevance > 8) return tiers.mid;
        return tiers.low;
    }

    const keywordSet = new Set(keywordRanked);
    let consensus = 0;
    for (const id of embeddingRanked) {
        if (keywordSet.has(id)) consensus++;
    }
    if (consensus >= 3) return tiers.high;
    if (consensus >= 1) return tiers.mid;
    return tiers.low;
}
