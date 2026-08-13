import { describe, it, expect } from 'vitest';
import type { NPCEntry } from '../../../types';
import {
    resolveRelationTarget,
    resolveRelationEdges,
    npcIdentityKeys,
} from '../relationResolve';

function mkNpc(id: string, name: string, overrides: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id,
        name,
        aliases: '',
        appearance: '',
        faction: '',
        storyRelevance: '',
        disposition: '',
        status: 'alive',
        goals: '',
        voice: '',
        personality: '',
        exampleOutput: '',
        affinity: 50,
        ...overrides,
    } as NPCEntry;
}

describe('WO-4 §3 — relationResolve: resolveRelationTarget', () => {
    it('resolves a name-keyed edge (the canonical case — the LLM only knows names)', () => {
        const source = mkNpc('a', 'Alden', { relations: { 'Bram': 2 } });
        const target = mkNpc('b', 'Bram');
        expect(resolveRelationTarget(source, target)).toBe(2);
    });

    it('resolves a name-keyed edge case-insensitively', () => {
        const source = mkNpc('a', 'Alden', { relations: { 'bram': 2 } });
        const target = mkNpc('b', 'Bram');
        expect(resolveRelationTarget(source, target)).toBe(2);
    });

    it('resolves a name-keyed edge space-insensitively', () => {
        const source = mkNpc('a', 'Alden', { relations: { 'captain  vorin': 2 } });
        const target = mkNpc('b', 'Captain Vorin');
        expect(resolveRelationTarget(source, target)).toBe(2);
    });

    it('resolves a legacy id-keyed edge (no migration — ids resolve forever)', () => {
        const source = mkNpc('a', 'Alden', { relations: { 'b': 2 } });
        const target = mkNpc('b', 'Bram');
        expect(resolveRelationTarget(source, target)).toBe(2);
    });

    it('resolves an alias-keyed edge', () => {
        const source = mkNpc('a', 'Alden', { relations: { 'Vorin': 2 } });
        const target = mkNpc('b', 'Captain Vorin', { aliases: 'Vorin, Old Captain' });
        expect(resolveRelationTarget(source, target)).toBe(2);
    });

    it('resolves an alias-keyed edge case-insensitively', () => {
        const source = mkNpc('a', 'Alden', { relations: { 'old captain': 2 } });
        const target = mkNpc('b', 'Captain Vorin', { aliases: 'Vorin, Old Captain' });
        expect(resolveRelationTarget(source, target)).toBe(2);
    });

    it('name takes precedence over id (canonical key = name)', () => {
        // Both name and id present with different values — name wins.
        const source = mkNpc('a', 'Alden', { relations: { 'Bram': 2, 'b': -1 } });
        const target = mkNpc('b', 'Bram');
        expect(resolveRelationTarget(source, target)).toBe(2);
    });

    it('id is used when no name key exists (legacy fallback)', () => {
        const source = mkNpc('a', 'Alden', { relations: { 'b': -1 } });
        const target = mkNpc('b', 'Bram');
        expect(resolveRelationTarget(source, target)).toBe(-1);
    });

    it('returns undefined for self-reference', () => {
        const source = mkNpc('a', 'Alden', { relations: { 'Alden': 3 } });
        expect(resolveRelationTarget(source, source)).toBeUndefined();
    });

    it('returns undefined for an unknown key', () => {
        const source = mkNpc('a', 'Alden', { relations: { 'Ghost': 1 } });
        const target = mkNpc('b', 'Bram');
        expect(resolveRelationTarget(source, target)).toBeUndefined();
    });

    it('returns undefined when source has no relations', () => {
        const source = mkNpc('a', 'Alden');
        const target = mkNpc('b', 'Bram');
        expect(resolveRelationTarget(source, target)).toBeUndefined();
    });

    it('returns 0 (not undefined) for a stored zero edge', () => {
        const source = mkNpc('a', 'Alden', { relations: { 'Bram': 0 } });
        const target = mkNpc('b', 'Bram');
        expect(resolveRelationTarget(source, target)).toBe(0);
    });

    it('skips non-numeric / non-finite values', () => {
        const source = mkNpc('a', 'Alden', { relations: { 'Bram': 'friendly' as unknown as number } });
        const target = mkNpc('b', 'Bram');
        expect(resolveRelationTarget(source, target)).toBeUndefined();
    });
});

describe('WO-4 §3 — relationResolve: resolveRelationEdges', () => {
    it('resolves all edges to the targets, skipping self-edges', () => {
        const source = mkNpc('a', 'Alden', { relations: { 'Bram': 2, 'Cira': -1 } });
        const bram = mkNpc('b', 'Bram');
        const cira = mkNpc('c', 'Cira');
        const edges = resolveRelationEdges(source, [source, bram, cira]);
        expect(edges).toEqual([
            { target: bram, value: 2 },
            { target: cira, value: -1 },
        ]);
    });

    it('returns 0 for absent edges (not undefined)', () => {
        const source = mkNpc('a', 'Alden', { relations: { 'Bram': 2 } });
        const bram = mkNpc('b', 'Bram');
        const cira = mkNpc('c', 'Cira');
        const edges = resolveRelationEdges(source, [bram, cira]);
        expect(edges).toEqual([
            { target: bram, value: 2 },
            { target: cira, value: 0 },
        ]);
    });
});

describe('WO-4 §3 — relationResolve: npcIdentityKeys', () => {
    it('returns lowercased name + aliases', () => {
        const npc = mkNpc('a', 'Captain Vorin', { aliases: 'Vorin, Old Captain' });
        expect(npcIdentityKeys(npc)).toEqual(['captain vorin', 'vorin', 'old captain']);
    });

    it('dedupes aliases that collide with the name', () => {
        const npc = mkNpc('a', 'Vorin', { aliases: 'Vorin, Vorin' });
        expect(npcIdentityKeys(npc)).toEqual(['vorin']);
    });

    it('handles empty aliases', () => {
        const npc = mkNpc('a', 'Alden', { aliases: '' });
        expect(npcIdentityKeys(npc)).toEqual(['alden']);
    });
});