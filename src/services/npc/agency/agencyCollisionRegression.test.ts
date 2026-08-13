import { describe, it, expect } from 'vitest';
import type { NPCEntry, Goal } from '../../../types';
import { relationTone, detectCollision } from './agencyCollision';
import { relationToward } from '../affinityAccess';

function mockGoal(overrides: Partial<Goal> = {}): Goal {
    return {
        text: 'slay dragon',
        horizon: 'med',
        tier: 'default',
        base_heat: 2,
        lastAdvancedTick: 0,
        failStreak: 0,
        progress: 0,
        quota: 10,
        state: 'active',
        ...overrides,
    };
}

function mockNpc(id: string, name: string, overrides: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id,
        name,
        isPC: false,
        condition: 'healthy',
        wants: { short: [], medium: [], long: '' },
        goalRecords: [],
        relations: {},
        ...overrides,
    } as unknown as NPCEntry;
}

/**
 * WO-4 §3 — the live bug regression. Before the resolver, `agencyCollision`
 * read `a.relations?.[b.id]` — but the LLM only ever knows names, so stored
 * keys were overwhelmingly names, and the collision path read `undefined → 0`
 * for essentially every edge. **Off-screen NPCs had never once tangled by
 * relationship.** After routing through the resolver, a name-keyed edge reads
 * non-zero here. Id-keyed legacy edges still resolve.
 */
describe('WO-4 §3 — collision regression: name-keyed edges now read non-zero', () => {
    it('a NAME-keyed relation between two NPCs reads non-zero in relationTone (the bug fix)', () => {
        // Stored by name — the overwhelming majority case, since the LLM only knows names.
        const a = mockNpc('a', 'Alden', { relations: { 'Bram': 2 } });
        const b = mockNpc('b', 'Bram');
        // Before the fix: relationTone read a.relations?.[b.id] = a.relations?.['b'] = undefined → 0 → neutral.
        // After the fix: routes through resolveRelationTarget → finds 'Bram' → 2 → ally.
        expect(relationTone(a, b)).toEqual({ tone: 'ally', magnitude: 2 });
    });

    it('a NAME-keyed rival edge reads non-zero (rival, not neutral)', () => {
        const a = mockNpc('a', 'Alden', { relations: { 'Bram': -2 } });
        const b = mockNpc('b', 'Bram');
        expect(relationTone(a, b)).toEqual({ tone: 'rival', magnitude: -2 });
    });

    it('a legacy ID-keyed edge still resolves (no data migration)', () => {
        const a = mockNpc('a', 'Alden', { relations: { 'b': 2 } });
        const b = mockNpc('b', 'Bram');
        expect(relationTone(a, b)).toEqual({ tone: 'ally', magnitude: 2 });
    });

    it('an alias-keyed edge resolves', () => {
        const a = mockNpc('a', 'Alden', { relations: { 'Vorin': 2 } });
        const b = mockNpc('b', 'Captain Vorin', { aliases: 'Vorin' });
        expect(relationTone(a, b)).toEqual({ tone: 'ally', magnitude: 2 });
    });

    it('detectCollision now picks the name-keyed rival partner (previously read 0 → neutral → lost the tie-break)', () => {
        // Two candidates in the same region (so goalsCoincide is true by region).
        // c1 has a name-keyed rival edge (-2); c2 has a name-keyed ally edge (+1).
        // Before the fix: both read 0 → neutral → tie-break by id asc → c1 won by id,
        // but as NEUTRAL (magnitude 0). After the fix: c1 reads -2 (rival, magnitude 2)
        // and wins on magnitude.
        const pick = mockNpc('pick', 'Alden', { region: 'academy' });
        const pickGoal = mockGoal();
        const c1 = mockNpc('npc-c1', 'Bram', {
            region: 'academy',
            relations: { 'Alden': -2 },  // name-keyed rival
            goalRecords: [mockGoal()],
        });
        const c2 = mockNpc('npc-c2', 'Mira', {
            region: 'academy',
            relations: { 'Alden': 1 },   // name-keyed ally
            goalRecords: [mockGoal()],
        });

        const result = detectCollision(pick, pickGoal, [c1, c2], 'calm');
        expect(result).not.toBeNull();
        expect(result?.partner.id).toBe('npc-c1');
        expect(result?.tone).toBe('rival');
    });

    it('relationToward reads a name-keyed edge to a non-PC target', () => {
        const source = mockNpc('a', 'Alden', { relations: { 'Bram': 3 } });
        const target = mockNpc('b', 'Bram');
        expect(relationToward(source, target)).toBe(3);
    });

    it('relationToward falls back to 0 for an unknown key (the pre-refactor default)', () => {
        const source = mockNpc('a', 'Alden', { relations: { 'Ghost': 1 } });
        const target = mockNpc('b', 'Bram');
        expect(relationToward(source, target)).toBe(0);
    });

    it('relationToward returns the pcRelation slot for a PC target when set', () => {
        const source = mockNpc('a', 'Alden', { pcRelation: 2 });
        const pc = mockNpc('pc', 'Player', { isPC: true });
        expect(relationToward(source, pc)).toBe(2);
    });
});