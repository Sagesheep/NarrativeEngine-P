import { describe, expect, it } from 'vitest';
import {
    mergeRelationshipMemoryCollections,
    pruneRelationshipMemoriesForScenes,
} from '../relationshipMemory';
import type { RelationshipMemoryRecord } from '../../../types';

const rec = (sceneId: string, event: string, extra: Partial<RelationshipMemoryRecord> = {}): RelationshipMemoryRecord => ({
    sceneId, subject: 'npc-1', target: 'MC', mood: 'triumphant', impact: 'remembered',
    event, outcome: 'nodded', source: 'recorded', ...extra,
});

describe('relationship memory after an archive rollback', () => {
    it('a fresh record replaces a stale one from a rolled-back scene with the same number', () => {
        const stale = rec('012', 'abandoned the convoy');
        const fresh = rec('012', 'cleared the blockade');
        const merged = mergeRelationshipMemoryCollections([stale], [], { npcToMc: [fresh], npcToNpc: [], faults: [] });
        expect(merged.npcToMc).toEqual([fresh]);
    });

    it('never replaces a hand-written record', () => {
        const user = rec('012', 'written by the player', { source: 'user' });
        const fresh = rec('012', 'cleared the blockade');
        const merged = mergeRelationshipMemoryCollections([user], [], { npcToMc: [fresh], npcToNpc: [], faults: [] });
        expect(merged.npcToMc).toEqual([user, fresh]);
    });

    it('keeps records of other scenes and pairs', () => {
        const other = rec('011', 'shared rations');
        const fresh = rec('012', 'cleared the blockade');
        const merged = mergeRelationshipMemoryCollections([other], [], { npcToMc: [fresh], npcToNpc: [], faults: [] });
        expect(merged.npcToMc).toEqual([other, fresh]);
    });

    it('prunes recorded memories from the cut onward, keeping hand-written ones', () => {
        const kept = rec('009', 'before the cut');
        const cut = rec('010', 'at the cut');
        const after = rec('015', 'after the cut', { target: 'npc-2' });
        const user = rec('011', 'written by the player', { source: 'user' });
        const pruned = pruneRelationshipMemoriesForScenes(
            { npcToMc: [kept, cut, user], npcToNpc: [after] },
            n => n >= 10,
        );
        expect(pruned.npcToMc).toEqual([kept, user]);
        expect(pruned.npcToNpc).toEqual([]);
        expect(pruned.removed).toBe(2);
    });

    it('prunes a single surgically deleted scene', () => {
        const pruned = pruneRelationshipMemoriesForScenes(
            { npcToMc: [rec('004', 'a'), rec('005', 'b'), rec('006', 'c')], npcToNpc: [] },
            n => n === 5,
        );
        expect(pruned.npcToMc.map(r => r.sceneId)).toEqual(['004', '006']);
    });
});
