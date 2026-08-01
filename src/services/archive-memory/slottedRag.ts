// ─────────────────────────────────────────────────────────────────────────────
// WO-12 / WO-12b — Slotted RAG.
//
// Synopsis-tier scenes with search hits that did NOT get elevated (WO-11)
// contribute one-line verbatim snippets, witness-filtered. Reuses WO-11's
// scoped search results — NO second vector search. One search, two consumers:
// WO-11 elevates the top-N scenes verbatim; WO-12 renders one-line snippets
// from the remaining hits.
//
// Flow:
//   1. buildSlottedRagSnippets — pure: takes WO-11's rankedSceneIds minus the
//      elevated set, applies the strict on-stage witness filter, caps at 4
//      scenes, and builds one verbatim snippet per scene from the archive
//      index's `userSnippet` field.
//   2. gatherSlottedRag — tier gate + state extraction + step 1.
//   3. renderSlottedRagBlock — [FABLE-AUTHORED] render format.
//
// No async, no fetch, no search — pure computation from WO-11's results +
// the archive index. Failure-safe: returns empty on any missing input.
//
// WO-12b Corrections:
//   1. Strict on-stage witness authorization — the allowed set is built from
//      `onStageNpcIds` ONLY (not every non-archived ledger NPC). A witnessed
//      scene passes only if at least one witness ID is in `onStageNpcIds`.
//      `npcLedger` remains the ID-to-display-name lookup; it is NOT an
//      authorization source. `witnessedBy` carries only the matching on-stage
//      witness names, in the archive entry's witness order.
//   2. Verbatim index snippets only — the sole snippet candidate is the
//      trimmed `ArchiveIndexEntry.userSnippet` (capped at 200 chars).
//      `SceneEvent.text` and other extracted/generated metadata are NOT
//      authorized snippet sources. Blank `userSnippet` → skip the scene.
//      Under the current archive-index schema, at most one snippet line per
//      scene is emitted. `lodSlottedMaxPerScene` is kept for forward
//      compatibility if the index later gains multiple verbatim fragments.
// ─────────────────────────────────────────────────────────────────────────────

import type { ArchiveChapter, ArchiveIndexEntry, NPCEntry } from '../../types';
import type { TurnState } from '../turn/turnOrchestrator';
import type { HostFacade } from '../turn/hostFacade';
import { tierAllows } from '../turn/aiTier';

export type SlottedRagSnippet = {
    sceneId: string;
    chapterId: string;
    snippet: string;
    witnessedBy: string[] | 'all';
};

export type SlottedRagResult = {
    snippets: SlottedRagSnippet[];
};

const MAX_SCENES = 4;
const SNIPPET_MAX_CHARS = 200;

/**
 * Build slotted RAG snippets from WO-11's scoped search results.
 *
 * Pure function: no async, no side effects. Takes WO-11's `rankedSceneIds`
 * (all search hits, best-first) minus the elevated scene IDs, applies the
 * strict on-stage witness filter, caps at `maxScenes` scenes, and builds one
 * verbatim snippet per scene from the archive index's `userSnippet` field.
 *
 * Witness filter (WO-12b Correction 1 — strict on-stage authorization):
 *   - The authorization set is `onStageNpcIds` ONLY. `npcLedger` is NOT an
 *     authorization source — an off-stage but non-archived NPC does NOT
 *     authorize a flash.
 *   - A scene with no witnesses (broadcast) passes.
 *   - A scene with witnesses passes only if at least one witness ID is in
 *     `onStageNpcIds`. If no NPC is on stage, every witnessed scene is
 *     dropped; broadcast scenes still pass.
 *   - For a passing witnessed scene, `witnessedBy` contains ONLY the matching
 *     on-stage witness names, in the archive entry's witness order. Off-stage
 *     witnesses are NOT attributed in the rendered flash.
 *   - The filter only applies when some scene in the index carries witness
 *     data (mirrors `world.ts` guard — avoids filtering when no witness data
 *     exists, so broadcast-only indexes pass through unchanged).
 *
 * Snippet source (WO-12b Correction 2 — verbatim index text only):
 *   - The sole snippet candidate is trimmed `ArchiveIndexEntry.userSnippet`
 *     (capped at 200 chars). The index's `userSnippet` is populated from
 *     `userContent.slice(0, 120)` at archive-write and scene-edit time
 *     (`server/services/archiveService.js:123,600`) — it is the available
 *     index-provided verbatim source.
 *   - `SceneEvent.text` and other extracted/generated metadata are NOT
 *     authorized snippet sources. Event text is summary metadata, not
 *     verbatim scene text.
 *   - Blank `userSnippet` → skip the scene (no snippet available).
 *   - Under the current archive-index schema, at most one snippet line per
 *     scene is emitted. `maxPerScene` is kept as an off switch
 *     (`maxPerScene <= 0` → no snippets) and for forward compatibility if
 *     the index later gains multiple verbatim fragments; for any positive
 *     value, the one available verbatim candidate may render.
 */
export function buildSlottedRagSnippets(params: {
    rankedSceneIds: string[];
    elevatedSceneIds: Set<string>;
    archiveIndex: ArchiveIndexEntry[];
    chapters: ArchiveChapter[];
    npcLedger: NPCEntry[];
    onStageNpcIds: string[];
    maxScenes?: number;
    maxPerScene?: number;
}): SlottedRagResult {
    const {
        rankedSceneIds,
        elevatedSceneIds,
        archiveIndex,
        chapters,
        npcLedger,
        onStageNpcIds,
        maxScenes = MAX_SCENES,
        maxPerScene = 2,
    } = params;

    if (rankedSceneIds.length === 0 || maxScenes <= 0 || maxPerScene <= 0) {
        return { snippets: [] };
    }

    // Build scene → chapter mapping from chapters' sceneIds.
    const sceneIdToChapterId = new Map<string, string>();
    for (const ch of chapters) {
        for (const sid of ch.sceneIds) {
            sceneIdToChapterId.set(sid, ch.chapterId);
        }
    }

    // Archive index lookup.
    const indexMap = new Map(archiveIndex.map(e => [e.sceneId, e]));

    // WO-12b Correction 1: the authorization set is `onStageNpcIds` ONLY.
    // `npcLedger` is NOT an authorization source — an off-stage but non-archived
    // NPC does NOT authorize a flash. `npcLedger` remains the ID-to-display-name
    // lookup for the rendered "witnessed by" attribution.
    const onStageSet = new Set(onStageNpcIds);

    // NPC id → name lookup for the "witnessed by" label.
    const npcNameMap = new Map(npcLedger.map(n => [n.id, n.name]));

    // Only apply the witness filter if some scene in the index has witness data
    // (mirrors world.ts guard — avoids filtering when no witness data exists).
    const hasWitnessData = archiveIndex.some(e => e.witnesses && e.witnesses.length > 0);

    const snippets: SlottedRagSnippet[] = [];
    let sceneCount = 0;

    for (const sceneId of rankedSceneIds) {
        if (sceneCount >= maxScenes) break;
        if (elevatedSceneIds.has(sceneId)) continue;

        const entry = indexMap.get(sceneId);
        if (!entry) continue;

        // WO-12b Correction 1: strict on-stage witness authorization.
        //   - Broadcast (no witnesses) passes.
        //   - Witnessed scenes pass only if at least one witness ID is in
        //     `onStageNpcIds`. If no NPC is on stage, every witnessed scene
        //     is dropped; broadcast scenes still pass.
        //   - For a passing witnessed scene, `witnessedBy` carries ONLY the
        //     matching on-stage witness names, in archive entry witness order.
        let witnessedBy: string[] | 'all';
        if (hasWitnessData) {
            const witnesses = entry.witnesses;
            if (witnesses && witnesses.length > 0) {
                // Keep only the on-stage witnesses, in archive entry order.
                const onStageWitnessIds = witnesses.filter(w => onStageSet.has(w));
                if (onStageWitnessIds.length === 0) continue; // no on-stage witness — drop
                witnessedBy = onStageWitnessIds
                    .map(w => npcNameMap.get(w) ?? w)
                    .filter(Boolean);
                // If every name resolved to empty via the lookup (unknown IDs),
                // fall back to the raw IDs so the attribution is not silently empty.
                if (witnessedBy.length === 0) witnessedBy = onStageWitnessIds.slice();
            } else {
                witnessedBy = 'all'; // broadcast
            }
        } else {
            witnessedBy = 'all'; // no witness data anywhere — treat as broadcast
        }

        // WO-12b Correction 2: verbatim index snippets only. The sole snippet
        // candidate is trimmed `ArchiveIndexEntry.userSnippet` (capped at 200
        // chars). `SceneEvent.text` and other extracted/generated metadata are
        // NOT authorized snippet sources. Blank `userSnippet` → skip the scene.
        const userSnippet = (entry.userSnippet ?? '').trim();
        if (!userSnippet) continue; // no verbatim snippet available — skip scene

        const snippet = userSnippet.length > SNIPPET_MAX_CHARS
            ? userSnippet.slice(0, SNIPPET_MAX_CHARS)
            : userSnippet;

        const chapterId = sceneIdToChapterId.get(sceneId) ?? 'unknown';

        // Under the current archive-index schema, at most one snippet line per
        // scene is emitted. `maxPerScene` is kept for forward compatibility if
        // the index later gains multiple verbatim fragments; for any positive
        // value, the one available verbatim candidate renders.
        snippets.push({ sceneId, chapterId, snippet, witnessedBy });
        sceneCount++;
    }

    return { snippets };
}

/**
 * Tier-gated entry point for contextGatherer.
 *
 * Gate: `lodSlottedRag` — lite false, pro false, max true.
 * Synchronous (pure computation from WO-11's results + archive index — no
 * async work, no fetch, no search). Failure-safe: returns empty on any
 * missing input; never throws.
 */
export function gatherSlottedRag(
    state: TurnState,
    deps: {
        rankedSceneIds: string[];
        elevatedSceneIds: Set<string>;
        chapters: ArchiveChapter[];
    },
    facade?: HostFacade,
): SlottedRagResult {
    if (!tierAllows(facade?.config.aiTier ?? state.settings.aiTier, 'lodSlottedRag')) return { snippets: [] };

    const archiveIndex = facade?.data.archiveIndex ?? state.archiveIndex;
    const npcLedger = facade?.data.npcLedger ?? state.npcLedger;
    const onStageNpcIds = facade?.data.onStageNpcIds ?? state.onStageNpcIds ?? [];
    const maxPerScene = facade?.config.lodSlottedMaxPerScene ?? state.settings.lodSlottedMaxPerScene ?? 2;
    if (archiveIndex.length === 0) return { snippets: [] };
    if (deps.rankedSceneIds.length === 0) return { snippets: [] };

    return buildSlottedRagSnippets({
        rankedSceneIds: deps.rankedSceneIds,
        elevatedSceneIds: deps.elevatedSceneIds,
        archiveIndex,
        chapters: deps.chapters,
        npcLedger,
        onStageNpcIds,
        maxPerScene,
    });
}

/**
 * Render the [ARCHIVE FLASHES] block. [FABLE-AUTHORED] format — verbatim.
 *
 * ```
 * [ARCHIVE FLASHES]
 * - (Chapter {id}, witnessed by {names|"all"}) "{snippet}"
 * ```
 *
 * Returns '' when no snippets — the caller (world.ts) emits no block.
 */
export function renderSlottedRagBlock(snippets: SlottedRagSnippet[]): string {
    if (snippets.length === 0) return '';
    const lines = snippets.map(s => {
        const witnessedBy = s.witnessedBy === 'all'
            ? 'all'
            : s.witnessedBy.join(', ');
        return `- (Chapter ${s.chapterId}, witnessed by ${witnessedBy}) "${s.snippet}"`;
    });
    return `[ARCHIVE FLASHES]\n${lines.join('\n')}`;
}