import type { RelationshipMemoryRecord } from '../types';
import { API_BASE } from '../lib/apiBase';
import { pruneRelationshipMemoriesForScenes } from '../services/archive-memory/relationshipMemory';
import { readRelationshipMemoryState, writeRelationshipMemoryState } from './relationshipMemoryState';

export type RelationshipMemoryCollections = {
    npcToMc: RelationshipMemoryRecord[];
    npcToNpc: RelationshipMemoryRecord[];
};

export async function loadRelationshipMemories(campaignId: string): Promise<RelationshipMemoryCollections> {
    const [npcToMcResponse, npcToNpcResponse] = await Promise.all([
        fetch(API_BASE + '/campaigns/' + campaignId + '/relationship-memory/npc-to-mc'),
        fetch(API_BASE + '/campaigns/' + campaignId + '/relationship-memory/npc-to-npc'),
    ]);
    const [npcToMc, npcToNpc] = await Promise.all([
        npcToMcResponse.ok ? npcToMcResponse.json() : Promise.resolve([]),
        npcToNpcResponse.ok ? npcToNpcResponse.json() : Promise.resolve([]),
    ]);
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

/**
 * Remove the recorded memories of scenes the archive just dropped, in the store and on
 * disk. Called after an archive rollback or a surgical scene delete. The store is what
 * the next save writes from, so trimming only the server file would not stick.
 */
export async function dropRelationshipMemoriesForScenes(
    campaignId: string,
    isRemovedScene: (sceneNumber: number) => boolean,
): Promise<number> {
    const state = readRelationshipMemoryState();
    const pruned = pruneRelationshipMemoriesForScenes({
        npcToMc: state.relationshipMemoriesNpcToMc ?? [],
        npcToNpc: state.relationshipMemoriesNpcToNpc ?? [],
    }, isRemovedScene);
    if (pruned.removed === 0) return 0;
    writeRelationshipMemoryState({
        relationshipMemoriesNpcToMc: pruned.npcToMc,
        relationshipMemoriesNpcToNpc: pruned.npcToNpc,
    });
    await saveRelationshipMemories(campaignId, { npcToMc: pruned.npcToMc, npcToNpc: pruned.npcToNpc });
    return pruned.removed;
}
