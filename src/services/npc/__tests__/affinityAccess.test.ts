import { describe, it, expect } from 'vitest';
import type { NPCEntry } from '../../../types';
import { pcRelationOf, readPcAffinity, relationToward } from '../affinityAccess';

function mkNpc(overrides: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: 'test-1',
        name: 'Test NPC',
        aliases: '',
        appearance: '',
        faction: '',
        storyRelevance: '',
        status: '',
        voice: '',
        personality: '',
        exampleOutput: '',
        ...overrides,
    } as NPCEntry;
}

/**
 * WO-4 §2 — accessor parity. The legacy 0..100 affinity arm is retired (it folds
 * into pcRelation on load), so an unset pcRelation reads Neutral.
 */
describe('WO-4 §2 — affinityAccess: pcRelationOf', () => {
    it('returns pcRelation when set', () => {
        expect(pcRelationOf(mkNpc({ pcRelation: 2 }))).toBe(2);
    });

    it('reads Neutral (0) when pcRelation is undefined', () => {
        expect(pcRelationOf(mkNpc({ pcRelation: undefined }))).toBe(0);
    });
});

describe('WO-4 §2 — affinityAccess: readPcAffinity (the v3 seam)', () => {
    it('returns pcRelation when set', () => {
        expect(readPcAffinity(mkNpc({ pcRelation: 2 }))).toEqual({ kind: 'pcRelation', value: 2 });
    });

    it('returns none when pcRelation is undefined', () => {
        expect(readPcAffinity(mkNpc({ pcRelation: undefined }))).toEqual({ kind: 'none' });
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
        const source = mkNpc({ id: 'a', pcRelation: 3, relations: { Bram: 2 } });
        const target = mkNpc({ id: 'b', name: 'Bram' });
        expect(readPcAffinity(source, true)).toEqual({ kind: 'stance' });
        expect(pcRelationOf(source, true)).toBe(0);
        expect(relationToward(source, target, true)).toBe(0);
    });
});
