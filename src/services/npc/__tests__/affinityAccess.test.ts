import { describe, it, expect } from 'vitest';
import type { NPCEntry } from '../../../types';
import { pcRelationOf, readPcAffinity, relationToward } from '../affinityAccess';
import { affinityToPcRelation } from '../agency/agencyBands';

function mkNpc(overrides: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: 'test-1',
        name: 'Test NPC',
        aliases: '',
        appearance: '',
        faction: '',
        storyRelevance: '',
        disposition: '',
        status: '',
        goals: '',
        voice: '',
        personality: '',
        exampleOutput: '',
        affinity: 50,
        ...overrides,
    } as NPCEntry;
}

/**
 * WO-4 §2 — accessor parity. The accessor must return today's stored values
 * and nothing else (no v3 branch in this order). Semantics preserved exactly,
 * including the `?? 0` and `?? 50` fallbacks.
 */
describe('WO-4 §2 — affinityAccess: pcRelationOf preserves the legacy fallback', () => {
    it('returns pcRelation when set', () => {
        expect(pcRelationOf(mkNpc({ pcRelation: 2 }))).toBe(2);
    });

    it('derives from affinity via affinityToPcRelation when pcRelation is undefined', () => {
        expect(pcRelationOf(mkNpc({ affinity: 10, pcRelation: undefined }))).toBe(affinityToPcRelation(10));
        expect(pcRelationOf(mkNpc({ affinity: 50, pcRelation: undefined }))).toBe(affinityToPcRelation(50));
        expect(pcRelationOf(mkNpc({ affinity: 90, pcRelation: undefined }))).toBe(affinityToPcRelation(90));
    });

    it('defaults affinity to 50 when both pcRelation and affinity are undefined (the ?? 50 fallback)', () => {
        expect(pcRelationOf(mkNpc({ affinity: undefined, pcRelation: undefined }))).toBe(affinityToPcRelation(50));
    });
});

describe('WO-4 §2 — affinityAccess: readPcAffinity (the v3 seam)', () => {
    it('returns pcRelation when set', () => {
        expect(readPcAffinity(mkNpc({ pcRelation: 2 }))).toEqual({ kind: 'pcRelation', value: 2 });
    });

    it('returns legacyAffinity when pcRelation is undefined but affinity is set', () => {
        expect(readPcAffinity(mkNpc({ affinity: 65, pcRelation: undefined }))).toEqual({ kind: 'legacyAffinity', value: 65 });
    });

    it('returns none when both are undefined', () => {
        expect(readPcAffinity(mkNpc({ affinity: undefined, pcRelation: undefined }))).toEqual({ kind: 'none' });
    });
});

describe('WO-4 §2 — affinityAccess: relationToward', () => {
    it('returns the pcRelation slot for a PC target when set', () => {
        const source = mkNpc({ id: 'a', pcRelation: -1 });
        const pc = mkNpc({ id: 'pc', name: 'Player', isPC: true });
        expect(relationToward(source, pc)).toBe(-1);
    });

    it('resolves a name-keyed NPC edge through the resolver', () => {
        const source = mkNpc({ id: 'a', name: 'Alden', relations: { 'Bram': 2 } });
        const target = mkNpc({ id: 'b', name: 'Bram' });
        expect(relationToward(source, target)).toBe(2);
    });

    it('falls back to 0 for an unknown edge (the pre-refactor default)', () => {
        const source = mkNpc({ id: 'a', name: 'Alden', relations: {} });
        const target = mkNpc({ id: 'b', name: 'Bram' });
        expect(relationToward(source, target)).toBe(0);
    });

    it('returns the stance seam and no scalar when relationship memory is enabled', () => {
        const source = mkNpc({ id: 'a', pcRelation: 3, affinity: 90, relations: { Bram: 2 } });
        const target = mkNpc({ id: 'b', name: 'Bram' });
        expect(readPcAffinity(source, true)).toEqual({ kind: 'stance' });
        expect(pcRelationOf(source, true)).toBe(0);
        expect(relationToward(source, target, true)).toBe(0);
    });
});
