import type { ArchiveIndexEntry, ArchiveScene, ChatMessage, NPCEntry } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { API_BASE as API } from '../../lib/apiBase';
import { safeSceneNum } from '../../utils/helpers';
import { fuseRRF } from '../retrieval/lexicalFusion';
import { computeArchiveIdf } from './idf';
import { scoreEntry, extractContextActivations, expandActivationsWithFacts, applyEventBoost } from './scoring';
import { computeDynamicMax, PLANNER_RELEVANCE_BOOST, type RecallDepth } from './dynamicMax';

/**
 * archive-memory/recall.ts
 *
 * The public recall entry points. retrieveArchiveMemory orchestrates the
 * IDF-weighted keyword ranker + the server's embedding ranker, fused via RRF,
 * with divergence scenes force-surfaced. fetchArchiveScenes pulls verbatim
 * content; recallArchiveScenes is the search+fetch convenience used pre-payload.
 */

/**
 * Search the archive index with hybrid retrieval: an IDF-weighted keyword ranker fused with
 * the server's embedding ranker via RRF. Divergence scenes are force-surfaced. Returns the
 * matched scene IDs in fused (front-loaded) order, best first.
 */
export function retrieveArchiveMemory(
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger?: NPCEntry[],
    maxScenes?: number,
    semanticFacts?: { subject: string; predicate: string; object: string; importance: number }[],
    sceneRanges?: [string, string][],
    npcPerspective?: string,
    semanticCandidateIds?: string[],
    divergenceSceneIds?: Set<string>,
    excludeSceneIds?: Set<string>,
    plannerSceneIds?: string[],
    recallDepth: RecallDepth = 'standard',
    campaignId?: string,
): string[] {
    if (!index || index.length === 0) {
        console.log('[Archive Retrieval] Index is empty — no recall.');
        return [];
    }

    const contextText = [
        userMessage,
        ...recentMessages.slice(-3).map(m => m.content || '')
    ].join('\n').toLowerCase();

    let contextActivations = extractContextActivations(userMessage, recentMessages, npcLedger);
    contextActivations = expandActivationsWithFacts(contextActivations, semanticFacts);

    // Filter to scenes within provided scene ranges (if any).
    let scopedIndex = index;
    if (sceneRanges && sceneRanges.length > 0) {
        scopedIndex = index.filter(entry => {
            const sceneNum = safeSceneNum(entry.sceneId);
            return sceneRanges.some(([start, end]) => {
                const s = safeSceneNum(start);
                const e = safeSceneNum(end);
                return sceneNum >= s && sceneNum <= e;
            });
        });
    }

    // NOTE: the old `semanticCandidateIds` hard-filter is intentionally removed. The embedding
    // ranker is now a fusion signal, not a gate (see file header). Excluded scenes are still
    // filtered out below, and the embedding ranker is scope-filtered before fusion.
    if (excludeSceneIds && excludeSceneIds.size > 0) {
        const before = scopedIndex.length;
        scopedIndex = scopedIndex.filter(entry => !excludeSceneIds.has(entry.sceneId));
        if (before !== scopedIndex.length) {
            console.log(`[Archive Retrieval] Excluded ${before - scopedIndex.length} scene(s) already in fitted history.`);
        }
    }

    const idf = computeArchiveIdf(index, campaignId);
    const totalScenes = scopedIndex.length;
    const eventBoosts = applyEventBoost(scopedIndex, userMessage, recentMessages);
    const plannerSet = plannerSceneIds && plannerSceneIds.length > 0 ? new Set(plannerSceneIds) : null;

    // ─── Keyword ranker (IDF-weighted, with mainApp signals folded into relevance) ───
    const scored = scopedIndex.map(entry => {
        const { keywordRelevance, recency, importance } = scoreEntry(
            entry, contextText, contextActivations, totalScenes, idf, npcPerspective,
        );
        let relevance = keywordRelevance;
        relevance += eventBoosts.get(entry.sceneId) ?? 0;
        if (plannerSet?.has(entry.sceneId)) relevance += PLANNER_RELEVANCE_BOOST;
        return {
            sceneId: entry.sceneId,
            relevance,
            tiebreak: (0.1 * recency) + (0.05 * importance),
        };
    });

    const keywordRelevant = scored
        .filter(s => s.relevance > 0)
        .sort((a, b) => (b.relevance + b.tiebreak) - (a.relevance + a.tiebreak));
    const keywordRanked = keywordRelevant.map(s => s.sceneId);
    const topKeywordRelevance = keywordRelevant[0]?.relevance ?? 0;

    // ─── Embedding ranker (cosine order from server), scope-filtered ───
    // Guard: filter to the post-exclude, post-range scoped scenes so excluded / out-of-range
    // scenes cannot leak back in through the embedding ranker.
    const scopedSceneIds = new Set(scopedIndex.map(e => e.sceneId));
    const embeddingRanked = (semanticCandidateIds ?? []).filter(id => scopedSceneIds.has(id));

    // ─── RRF fusion ───
    const fused = fuseRRF(keywordRanked, embeddingRanked);

    // ─── Divergence front-loading ───
    // Divergence scenes (where the story left canon) must surface for continuity even when
    // they don't match the current turn's keywords or embeddings. Matched ones keep their
    // fused order; unmatched ones are injected after, by recency.
    let ordered = fused;
    if (divergenceSceneIds && divergenceSceneIds.size > 0) {
        const fusedSet = new Set(fused);
        const divInScope = scopedIndex
            .map(e => e.sceneId)
            .filter(id => divergenceSceneIds.has(id));
        if (divInScope.length > 0) {
            const divSet = new Set(divInScope);
            const matchedDiv = fused.filter(id => divSet.has(id));
            const unmatchedDiv = divInScope
                .filter(id => !fusedSet.has(id))
                .sort((a, b) => safeSceneNum(b) - safeSceneNum(a));
            const rest = fused.filter(id => !divSet.has(id));
            ordered = [...matchedDiv, ...unmatchedDiv, ...rest];
        }
    }

    const dynamicMax = computeDynamicMax(keywordRanked, embeddingRanked, recallDepth, topKeywordRelevance, maxScenes);
    const result = ordered.slice(0, dynamicMax);

    console.log(
        `[Archive Retrieval] Hybrid over ${index.length} entries: ` +
        `${keywordRanked.length} keyword, ${embeddingRanked.length} embedding hits ` +
        `(depth=${recallDepth}, max ${dynamicMax}). Top: [${result.join(', ')}]`
    );

    return result;
}

/**
 * Fetch full verbatim scene content from the server for a set of scene IDs.
 *
 * `sceneIds` is best-first. The token budget is filled in that order and the
 * scenes that fit are returned sorted chronologically. Sorting before filling
 * the budget filled it oldest-first: with ~1,500-token scenes in a 3,000-token
 * budget, the two oldest picks always won and a better-ranked newer scene was
 * dropped (a probe about a deal made in scenes 533–534 got scenes 115, 207, 271).
 */
export async function fetchArchiveScenes(
    campaignId: string,
    sceneIds: string[],
    tokenBudget = 3000
): Promise<ArchiveScene[]> {
    if (sceneIds.length === 0) return [];

    try {
        const idsParam = sceneIds.join(',');
        const res = await fetch(`${API}/campaigns/${campaignId}/archive/scenes?ids=${idsParam}`);
        if (!res.ok) {
            console.warn('[Archive Retrieval] Failed to fetch scenes:', res.status);
            return [];
        }

        const raw: { sceneId: string; content: string }[] = await res.json();

        // The server answers in archive order; restore the caller's ranking.
        const rank = new Map(sceneIds.map((id, i) => [safeSceneNum(id), i]));
        const byRank = raw.slice().sort((a, b) =>
            (rank.get(safeSceneNum(a.sceneId)) ?? Infinity) - (rank.get(safeSceneNum(b.sceneId)) ?? Infinity));
        const selected: ArchiveScene[] = [];
        let usedTokens = 0;

        for (const scene of byRank) {
            const tokens = countTokens(scene.content);
            if (usedTokens + tokens > tokenBudget) {
                // Partially include the scene if there's a meaningful amount of budget remaining
                const remaining = tokenBudget - usedTokens;
                if (remaining > 150) {
                    // ~4 chars per token; truncate to fit remaining budget
                    const maxChars = Math.floor(remaining * 4);
                    const truncated = scene.content.slice(0, maxChars) + '\n[...scene truncated for context budget...]';
                    selected.push({ sceneId: scene.sceneId, content: truncated, tokens: remaining });
                }
                break;
            }
            selected.push({ sceneId: scene.sceneId, content: scene.content, tokens });
            usedTokens += tokens;
        }

        console.log(
            `[Archive Retrieval] Fetched ${selected.length}/${raw.length} scenes ` +
            `(${usedTokens} tokens used of ${tokenBudget} budget).`
        );

        return selected.sort((a, b) => safeSceneNum(a.sceneId) - safeSceneNum(b.sceneId));
    } catch (err) {
        console.warn('[Archive Retrieval] Error fetching scenes:', err);
        return [];
    }
}

/**
 * Convenience: search + fetch in one call.
 * Used in ChatArea before buildPayload().
 */
export async function recallArchiveScenes(
    campaignId: string,
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    tokenBudget = 3000,
    npcLedger?: NPCEntry[],
    semanticFacts?: { subject: string; predicate: string; object: string; importance: number }[],
    npcPerspective?: string,
    semanticCandidateIds?: string[],
    divergenceSceneIds?: Set<string>,
    excludeSceneIds?: Set<string>,
    plannerSceneIds?: string[],
    recallDepth: RecallDepth = 'standard',
): Promise<ArchiveScene[]> {
    const matchedIds = retrieveArchiveMemory(index, userMessage, recentMessages, npcLedger, undefined, semanticFacts, undefined, npcPerspective, semanticCandidateIds, divergenceSceneIds, excludeSceneIds, plannerSceneIds, recallDepth, campaignId);
    if (matchedIds.length === 0) return [];
    return fetchArchiveScenes(campaignId, matchedIds, tokenBudget);
}
