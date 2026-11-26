import type { ArchiveIndexEntry, ArchiveScene, ChatMessage, NPCEntry } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { API_BASE as API } from '../../lib/apiBase';
import { safeSceneNum } from '../../utils/helpers';
import { fuseRRF } from '../retrieval/lexicalFusion';
import { computeArchiveIdf } from './idf';
import { scoreEntry, extractContextActivations, expandActivationsWithFacts, applyEventBoost } from './scoring';
import { computeDynamicMax, DIVERGENCE_RELEVANCE_BONUS, PLANNER_RELEVANCE_BOOST, type RecallDepth } from './dynamicMax';
import { computePairIdf, computeTagIdf, countOpenHooksByPerson, deriveActiveTags, scoreOpenHooks, scorePersonTagPairs, scoreSceneTags } from './sceneTags';

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
 * the server's embedding ranker via RRF. Returns the
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
    const activeTags = deriveActiveTags(index, userMessage);
    const tagIdf = computeTagIdf(index);
    const pairIdf = computePairIdf(index);
    const hookCounts = countOpenHooksByPerson(index);

    // ─── Keyword ranker (IDF-weighted, with mainApp signals folded into relevance) ───
    const scored = scopedIndex.map(entry => {
        const { keywordRelevance, recency, importance } = scoreEntry(
            entry, contextText, contextActivations, totalScenes, idf, npcPerspective,
        );
        let relevance = keywordRelevance;
        relevance += eventBoosts.get(entry.sceneId) ?? 0;
        relevance += scoreSceneTags(entry, activeTags, tagIdf);
        relevance += scorePersonTagPairs(entry, activeTags, contextActivations, pairIdf);
        relevance += scoreOpenHooks(entry, contextActivations, hookCounts);
        if (plannerSet?.has(entry.sceneId)) relevance += PLANNER_RELEVANCE_BOOST;
        // A nudge, not a pass: only for scenes that already match this turn. The divergence
        // register itself reaches the writer separately, whichever scenes are recalled.
        if (relevance > 0 && divergenceSceneIds?.has(entry.sceneId)) relevance += DIVERGENCE_RELEVANCE_BONUS;
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

    const dynamicMax = computeDynamicMax(keywordRanked, embeddingRanked, recallDepth, topKeywordRelevance, maxScenes);
    const result = fused.slice(0, dynamicMax);

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

/** Extra tokens a short line costs in the recall block beyond its own text (bullet, witness label). */
const SHORT_LINE_OVERHEAD_TOKENS = 12;

/**
 * The one-line form of a scene for the recall block: its AI-written definition, or,
 * for a scene archived before definitions existed, its extracted events.
 */
export function recallShortForm(entry: ArchiveIndexEntry | undefined): string | undefined {
    if (!entry) return undefined;
    if (entry.definition?.trim()) return entry.definition.trim();
    const events = (entry.events ?? []).map(e => e.text.trim()).filter(Boolean);
    return events.length > 0 ? events.join(' ') : undefined;
}

/**
 * Recall in two forms, so the budget reaches far more scenes than full text alone
 * (a median scene is ~1,275 tokens, so 3,000 tokens of full text held under two).
 *
 * `sceneIds` is best-first. The best scene is always given in full (cut to fit if it
 * is huge). Every other scene gets the room its short line needs reserved; then, in
 * rank order, a scene is given in full if it still fits whole, otherwise as its short
 * line. A scene with no short form is given in full or not at all, as before. With
 * no short forms anywhere this is exactly `fetchArchiveScenes`. Returned oldest first.
 */
export function fetchRecallScenes(
    campaignId: string,
    sceneIds: string[],
    tokenBudget: number,
    index: readonly ArchiveIndexEntry[],
): Promise<ArchiveScene[]> {
    const byId = new Map(index.map(e => [e.sceneId, e]));
    const shortForms = new Map<string, string>();
    for (const id of sceneIds) {
        const line = recallShortForm(byId.get(id));
        if (line) shortForms.set(id, line);
    }
    // Not async on this path: handing back fetchArchiveScenes' own promise keeps the
    // turn's await steps, and so the base-app gate's trace, exactly as before.
    if (shortForms.size === 0) return fetchArchiveScenes(campaignId, sceneIds, tokenBudget);
    return fetchMixedRecallScenes(campaignId, sceneIds, tokenBudget, shortForms);
}

async function fetchMixedRecallScenes(
    campaignId: string,
    sceneIds: string[],
    tokenBudget: number,
    shortForms: ReadonlyMap<string, string>,
): Promise<ArchiveScene[]> {
    try {
        const res = await fetch(`${API}/campaigns/${campaignId}/archive/scenes?ids=${sceneIds.join(',')}`);
        if (!res.ok) {
            console.warn('[Archive Retrieval] Failed to fetch scenes:', res.status);
            return [];
        }
        const raw: { sceneId: string; content: string }[] = await res.json();
        const contentById = new Map(raw.map(s => [safeSceneNum(s.sceneId), s]));
        const ranked = sceneIds
            .map(id => contentById.get(safeSceneNum(id)))
            .filter((s): s is { sceneId: string; content: string } => Boolean(s));
        if (ranked.length === 0) return [];

        const lineCost = (sceneId: string): number => {
            const line = shortForms.get(sceneId);
            return line ? countTokens(line) + SHORT_LINE_OVERHEAD_TOKENS : 0;
        };
        let reserved = ranked.slice(1).reduce((sum, s) => sum + lineCost(s.sceneId), 0);
        let used = 0;
        const selected: ArchiveScene[] = [];

        ranked.forEach((scene, i) => {
            const ownLine = i === 0 ? 0 : lineCost(scene.sceneId);
            reserved -= ownLine;
            const room = tokenBudget - used - reserved;
            const tokens = countTokens(scene.content);
            if (tokens <= room) {
                selected.push({ sceneId: scene.sceneId, content: scene.content, tokens, form: 'full' });
                used += tokens;
            } else if (i === 0 && room > 150) {
                const content = scene.content.slice(0, Math.floor(room * 4)) + '\n[...scene truncated for context budget...]';
                selected.push({ sceneId: scene.sceneId, content, tokens: room, form: 'full' });
                used += room;
            } else if (ownLine > 0 && ownLine <= tokenBudget - used - reserved) {
                selected.push({ sceneId: scene.sceneId, content: shortForms.get(scene.sceneId)!, tokens: ownLine, form: 'short' });
                used += ownLine;
            }
        });

        const full = selected.filter(s => s.form === 'full').length;
        console.log(
            `[Archive Retrieval] Recall: ${full} full + ${selected.length - full} short of ${ranked.length} ` +
            `(${used} tokens of ${tokenBudget} budget).`
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
