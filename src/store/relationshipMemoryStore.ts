import type { RelationshipMemoryRecord } from '../types';
import { API_BASE } from '../lib/apiBase';
import { pruneRelationshipMemoriesForScenes } from '../services/archive-memory/relationshipMemory';
import { clearRelationshipStanceCache } from '../services/npc/relationshipStance';
import { readRelationshipMemoryState, writeRelationshipMemoryState } from './relationshipMemoryState';
import { useAppStore } from './useAppStore';

export type RelationshipMemoryCollections = {
    npcToMc: RelationshipMemoryRecord[];
    npcToNpc: RelationshipMemoryRecord[];
};

/**
 * Reads both files. Throws when the server could not answer: an empty result must mean
 * "no memories yet", never "the read failed", because every save rewrites the whole file.
 */
export async function loadRelationshipMemories(campaignId: string): Promise<RelationshipMemoryCollections> {
    const [npcToMcResponse, npcToNpcResponse] = await Promise.all([
        fetch(API_BASE + '/campaigns/' + campaignId + '/relationship-memory/npc-to-mc'),
        fetch(API_BASE + '/campaigns/' + campaignId + '/relationship-memory/npc-to-npc'),
    ]);
    if (!npcToMcResponse.ok || !npcToNpcResponse.ok) throw new Error('Relationship memory load failed');
    const [npcToMc, npcToNpc] = await Promise.all([npcToMcResponse.json(), npcToNpcResponse.json()]);
    return {
        npcToMc: Array.isArray(npcToMc) ? npcToMc : [],
        npcToNpc: Array.isArray(npcToNpc) ? npcToNpc : [],
    };
}

export async function saveRelationshipMemories(
    campaignId: string,
    collections: RelationshipMemoryCollections,
): Promise<void> {
    const response = await fetch(API_BASE + '/campaigns/' + campaignId + '/relationship-memory', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(collections),
    });
    if (!response.ok) throw new Error('Relationship memory save failed');
}

// ── Single writer ──────────────────────────────────────────────────────────
// A save rewrites both files whole. Two rules keep that from losing records:
//  1. The store is changed with no `await` between reading it and writing it, so two
//     background ratings can never both start from the same list and overwrite each other.
//  2. Saves run one at a time and each sends the store as it is when the save starts, so
//     the last save on disk always matches the latest store.
// A save is refused until the campaign's files were read into the store: a store that
// was never loaded is empty, and saving it would wipe every memory on disk.

let loadedCampaignId: string | null = null;
let saveChain: Promise<void> = Promise.resolve();

/** Called by the hydrator once the campaign's memory files are in the store. */
export function markRelationshipMemoriesLoaded(campaignId: string | null): void {
    loadedCampaignId = campaignId;
}

function persistLatestRelationshipMemories(campaignId: string): Promise<void> {
    const run = saveChain.then(async () => {
        if (loadedCampaignId !== campaignId) {
            throw new Error('Relationship memory save refused — the campaign\'s memories are not loaded');
        }
        if (useAppStore.getState().activeCampaignId !== campaignId) return; // switched away; the store holds another campaign
        const state = readRelationshipMemoryState();
        await saveRelationshipMemories(campaignId, {
            npcToMc: state.relationshipMemoriesNpcToMc ?? [],
            npcToNpc: state.relationshipMemoriesNpcToNpc ?? [],
        });
    });
    saveChain = run.catch(() => undefined);
    return run;
}

/**
 * The one way to change relationship memories. `change` gets the current lists and
 * returns the new ones (or `null` for no change). The store is updated at once; the
 * returned promise settles when the change is on disk.
 *
 * `resetStances` drops the cached stance notes. Pass it when records were removed or
 * rewritten (rollback, delete, hand edits) so no note built from them is reused.
 */
export function updateRelationshipMemories(
    campaignId: string,
    change: (current: RelationshipMemoryCollections) => RelationshipMemoryCollections | null,
    options: { resetStances?: boolean } = {},
): Promise<void> {
    const state = readRelationshipMemoryState();
    const next = change({
        npcToMc: state.relationshipMemoriesNpcToMc ?? [],
        npcToNpc: state.relationshipMemoriesNpcToNpc ?? [],
    });
    if (options.resetStances) clearRelationshipStanceCache();
    if (!next) return Promise.resolve();
    writeRelationshipMemoryState({
        relationshipMemoriesNpcToMc: next.npcToMc,
        relationshipMemoriesNpcToNpc: next.npcToNpc,
    });
    return persistLatestRelationshipMemories(campaignId);
}

/**
 * Remove the recorded memories of scenes the archive just dropped, in the store and on
 * disk. Called after an archive rollback, a surgical scene delete or an archive clear.
 */
export async function dropRelationshipMemoriesForScenes(
    campaignId: string,
    isRemovedScene: (sceneNumber: number) => boolean,
): Promise<number> {
    let removed = 0;
    await updateRelationshipMemories(campaignId, current => {
        const pruned = pruneRelationshipMemoriesForScenes(current, isRemovedScene);
        removed = pruned.removed;
        return pruned.removed === 0 ? null : { npcToMc: pruned.npcToMc, npcToNpc: pruned.npcToNpc };
    }, { resetStances: true });
    return removed;
}

/** Test seam: forget the loaded campaign and any queued saves. */
export function resetRelationshipMemoryWriterForTests(): void {
    loadedCampaignId = null;
    saveChain = Promise.resolve();
}
