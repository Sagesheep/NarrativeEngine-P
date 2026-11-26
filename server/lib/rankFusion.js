/**
 * Reciprocal rank fusion over several ranked id lists — the multi-query merge for
 * semantic candidates (query expansion sends the player's message plus rephrasings).
 *
 * The old merge appended each later query's new ids after the first query's full
 * list, so a scene only a rephrasing found landed at rank 21+, where recall's own
 * fusion and the reranker's top-30 window barely reach. RRF scores each id by
 * Σ 1/(k + rank) across the lists: an id several queries agree on rises, and each
 * query's best hits sit near the top. Ties keep first-seen order. k = 60, the
 * constant the client recall fusion uses.
 *
 * @param {string[][]} lists ranked ids, best first, one list per query
 * @param {number} [k]
 * @returns {string[]}
 */
export function reciprocalRankFusion(lists, k = 60) {
    const score = new Map();
    const firstSeen = new Map();
    let seen = 0;
    for (const list of lists) {
        list.forEach((id, rank) => {
            score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1));
            if (!firstSeen.has(id)) firstSeen.set(id, seen++);
        });
    }
    return [...score.keys()].sort((a, b) => (score.get(b) - score.get(a)) || (firstSeen.get(a) - firstSeen.get(b)));
}
