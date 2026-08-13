import type { RelationshipMemoryRecord } from '../types';
import { API_BASE } from '../lib/apiBase';

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
