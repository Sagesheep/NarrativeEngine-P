// ─────────────────────────────────────────────────────────────────────────────
// WO-11 — Dynamic Elevation.
//
// When the player references a synopsis-tier memory, its scenes surface verbatim
// below the cache boundary for that turn only. Elevation is a new scoped retrieval
// path BESIDE the RRF retriever (recall.ts / scoring.ts / idf.ts are READ-ONLY).
//
// Flow:
//   1. computeSynopsisScope — derive synopsis-tier scene IDs from the WO-08 LOD
//      tier map (renderLodChapters is the single source of truth; the algorithm
//      is NOT duplicated).
//   2. runDynamicElevation — scoped vector search (WO-10) + verbatim fetch.
//   3. gatherDynamicElevation — tier gate + step 1 + step 2 + chapter-ID attach.
//   4. dedupElevatedScenes — skip scenes already in this turn's regular recall.
//
// Timeout/failure → empty result, never blocks the turn.
// ─────────────────────────────────────────────────────────────────────────────

import type { ArchiveChapter, ArchiveIndexEntry, ChatMessage, ArchiveScene } from '../../types';
import type { TurnState } from '../turn/turnOrchestrator';
import type { HostFacade } from '../turn/hostFacade';
import { API_BASE as API } from '../../lib/apiBase';
import { fetchArchiveScenes } from '../archiveMemory';
import { renderLodChapters, type LodConfig } from '../payload/lodRenderer';
import { tierAllows } from '../turn/aiTier';

export type ElevatedScene = ArchiveScene & {
    chapterId: string;
};

export type DynamicElevationResult = {
    scenes: ArchiveScene[];
    /** Scene IDs in ranked order from the scoped vector search (before fetch). */
    rankedSceneIds: string[];
};

const ELEVATION_TIMEOUT_MS = 5000;

/**
 * Step 1: compute synopsis-tier scene IDs from the WO-08 tier map.
 *
 * Calls `renderLodChapters` with a huge budget so the cascade is a no-op — we
 * want the natural tier assignment (summary vs synopsis) without budget-driven
 * demotions/drops. Chapters whose final tier is 'synopsis' contribute their
 * scene IDs to the elevation scope. This is the single source of truth: the
 * tier algorithm is NOT duplicated.
 */
export function computeSynopsisScope(params: {
    chapters: ArchiveChapter[];
    archiveIndex: ArchiveIndexEntry[];
    onStageNpcIds: string[];
    condensedUpToIndex: number;
    messages: ChatMessage[];
    config: LodConfig;
}): { scopeSceneIds: string[]; sceneIdToChapterId: Map<string, string> } {
    const { chapters, archiveIndex, onStageNpcIds, condensedUpToIndex, messages, config } = params;

    const lodResult = renderLodChapters({
        chapters,
        archiveIndex,
        onStageNpcIds,
        condensedUpToIndex,
        messages,
        budgetTokens: Number.MAX_SAFE_INTEGER,
        config,
    });

    const scopeSceneIds: string[] = [];
    const sceneIdToChapterId = new Map<string, string>();
    for (const ch of chapters) {
        if (lodResult.tierByChapterId[ch.chapterId] === 'synopsis') {
            for (const sid of ch.sceneIds) {
                scopeSceneIds.push(sid);
                sceneIdToChapterId.set(sid, ch.chapterId);
            }
        }
    }

    return { scopeSceneIds, sceneIdToChapterId };
}

/**
 * Step 2: scoped vector search (WO-10) + verbatim fetch.
 *
 * Calls the archive semantic-candidates endpoint with `scopeSceneIds` to
 * restrict recall to synopsis-tier scenes. The server returns scene IDs in
 * ranked order (cosine similarity, best-first) — the order IS the ranking
 * (the endpoint does not return explicit score values). Takes the top `limit`
 * IDs and fetches verbatim content via the existing scene-fetch path.
 *
 * Timeout/failure → empty result, never blocks the turn.
 *
 * WO-11b Correction 3: the five-second race timer is cleared when the scoped
 * search wins or fails before the deadline so no late false timeout warning
 * occurs after a successful early resolution.
 */
export async function runDynamicElevation(params: {
    campaignId: string;
    queries: string[];
    scopeSceneIds: string[];
    limit: number;
    signal?: AbortSignal;
}): Promise<DynamicElevationResult> {
    const { campaignId, queries, scopeSceneIds, limit, signal } = params;
    const empty: DynamicElevationResult = { scenes: [], rankedSceneIds: [] };

    if (!campaignId || scopeSceneIds.length === 0) return empty;
    const query = queries.find(q => q.trim()) ?? '';
    if (!query) return empty;
    if (limit <= 0) return empty;

    // WO-11b Correction 3: hold the timer handle so it can be cleared when the
    // search wins or fails before the deadline. Without this, a fast successful
    // result leaves a pending 5s timer that later fires the false timeout warning.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<DynamicElevationResult>(resolve => {
        timer = setTimeout(() => {
            console.warn('[DynamicElevation] timeout — returning empty');
            resolve(empty);
        }, ELEVATION_TIMEOUT_MS);
    });

    try {
        const searchPromise = doScopedSearch(campaignId, queries, scopeSceneIds, limit, signal);
        const result = await Promise.race([searchPromise, timeoutPromise]);
        // Clear the timer so a fast win/loss does not emit a late false timeout warning.
        if (timer) clearTimeout(timer);
        return result;
    } catch (err) {
        if (timer) clearTimeout(timer);
        console.warn('[DynamicElevation] failed:', err);
        return empty;
    }
}

async function doScopedSearch(
    campaignId: string,
    queries: string[],
    scopeSceneIds: string[],
    limit: number,
    signal?: AbortSignal,
): Promise<DynamicElevationResult> {
    const empty: DynamicElevationResult = { scenes: [], rankedSceneIds: [] };

    const queryBody = queries.length > 1 ? { queries } : { query: queries[0] };
    const body = { ...queryBody, scopeSceneIds };

    const res = await fetch(`${API}/campaigns/${campaignId}/archive/semantic-candidates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        console.warn('[DynamicElevation] scoped search returned', res.status);
        return empty;
    }

    const data = await res.json();
    if (data.pending) {
        // Model warming up or bulk embed in flight — fall back gracefully.
        return empty;
    }
    const rankedSceneIds: string[] = data.sceneIds ?? [];
    if (rankedSceneIds.length === 0) return empty;

    const topSceneIds = rankedSceneIds.slice(0, Math.max(0, limit));
    if (topSceneIds.length === 0) return empty;

    const scenes = await fetchArchiveScenes(campaignId, topSceneIds, 3000);
    return { scenes, rankedSceneIds };
}

/**
 * Wrapper: tier gate + scope computation + scoped search + chapter-ID attach.
 *
 * This is the entry point `contextGatherer` calls. Returns `ElevatedScene[]`
 * (scenes with `chapterId` attached for the labeled rendering in world.ts).
 *
 * Tier gate: `lodDynamicElevation` — lite false, pro true, max true.
 * Expanded queries: not reachable from contextGatherer (gatherSemanticCandidates
 * does query expansion internally but does not expose the expanded queries).
 * Uses the raw user message (`state.input`) as the single query. Reported.
 */
export async function gatherDynamicElevation(
    state: TurnState,
    deps: { chapters: ArchiveChapter[] },
    signal?: AbortSignal,
    facade?: HostFacade,
): Promise<{ scenes: ElevatedScene[]; rankedSceneIds: string[] }> {
    const empty = { scenes: [] as ElevatedScene[], rankedSceneIds: [] as string[] };

    const data = facade?.data;
    const config = facade?.config;
    const campaignId = data?.activeCampaignId ?? state.activeCampaignId;
    if (!campaignId) return empty;
    if (!tierAllows(config?.aiTier ?? state.settings.aiTier, 'lodDynamicElevation')) return empty;

    const archiveIndex = data?.archiveIndex ?? state.archiveIndex;
    const onStageNpcIds = data?.onStageNpcIds ?? state.onStageNpcIds ?? [];
    const condenser = data?.condenser ?? state.condenser;
    const messages = data?.messages ?? state.messages;
    const input = data?.input ?? state.input;
    const chapters = deps.chapters;
    if (chapters.length === 0 || archiveIndex.length === 0) return empty;
    if (condenser.condensedUpToIndex === undefined || condenser.condensedUpToIndex < 0) return empty;

    const { scopeSceneIds, sceneIdToChapterId } = computeSynopsisScope({
        chapters,
        archiveIndex,
        onStageNpcIds,
        condensedUpToIndex: condenser.condensedUpToIndex,
        messages,
        config: {
            summaryChapters: config?.lodSummaryChapters ?? state.settings.lodSummaryChapters ?? 7,
            importanceBonus: config?.lodImportanceBonus ?? state.settings.lodImportanceBonus ?? 2,
        },
    });

    if (scopeSceneIds.length === 0) return empty;

    const limit = config?.lodElevateScenes ?? state.settings.lodElevateScenes ?? 2;
    const result = await runDynamicElevation({
        campaignId,
        queries: [input],
        scopeSceneIds,
        limit,
        signal,
    });

    const elevatedScenes: ElevatedScene[] = result.scenes.map(s => ({
        ...s,
        chapterId: sceneIdToChapterId.get(s.sceneId) ?? 'unknown',
    }));

    return { scenes: elevatedScenes, rankedSceneIds: result.rankedSceneIds };
}

/**
 * Dedup helper: skip scenes already present in this turn's regular recall.
 * Called by world.ts at render time.
 */
export function dedupElevatedScenes(
    elevated: ElevatedScene[],
    regularRecallIds: Set<string>,
): ElevatedScene[] {
    return elevated.filter(s => !regularRecallIds.has(s.sceneId));
}