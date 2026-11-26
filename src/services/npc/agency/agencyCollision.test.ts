import { describe, it, expect } from 'vitest';
import type { NPCEntry, Goal } from '../../../types';

import {
    goalsCoincide,
    topActiveGoal,
    relationTone,
    detectCollision,
    resolveTangle,
    buildTangleDeltas,
} from './agencyCollision';
import { buildDigest } from './agencyDigest';

// Helper to construct a mock Goal
function mockGoal(overrides: Partial<Goal> = {}): Goal {
    return {
        text: 'master the blade',
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

// Helper to construct a mock NPCEntry
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

// Helper for sequence RNG
function fixedNats(nats: number[]) {
    let index = 0;
    return () => {
        const n = nats[index++];
        return (n - 0.5) / 20;
    };
}

describe('agencyCollision — Piece E: event collisions', () => {
    describe('goalsCoincide', () => {
        it('returns true if region matches, regardless of text', () => {
            const a = mockNpc('a', 'Alden', { region: 'academy' });
            const b = mockNpc('b', 'Bram', { region: 'academy' });
            const aGoal = mockGoal({ text: 'unrelated goal' });
            const bGoal = mockGoal({ text: 'completely different thing' });
            expect(goalsCoincide(a, aGoal, b, bGoal)).toBe(true);
        });

        it('returns true if non-stopword keyword matches, even if region differs', () => {
            const a = mockNpc('a', 'Alden', { region: 'academy' });
            const b = mockNpc('b', 'Bram', { region: 'forest' });
            const aGoal = mockGoal({ text: 'slay the mighty dragon' });
            const bGoal = mockGoal({ text: 'find a dragon claw' });
            expect(goalsCoincide(a, aGoal, b, bGoal)).toBe(true);
        });

        it('returns false if only stopwords (or short words <= 2) match', () => {
            const a = mockNpc('a', 'Alden', { region: 'academy' });
            const b = mockNpc('b', 'Bram', { region: 'forest' });
            const aGoal = mockGoal({ text: 'run to the castle' });
            const bGoal = mockGoal({ text: 'fly to a tree' });
            expect(goalsCoincide(a, aGoal, b, bGoal)).toBe(false);
        });

        it('returns false if regions differ and no keywords are shared', () => {
            const a = mockNpc('a', 'Alden', { region: 'academy' });
            const b = mockNpc('b', 'Bram', { region: 'forest' });
            const aGoal = mockGoal({ text: 'gather herbs' });
            const bGoal = mockGoal({ text: 'slay beasts' });
            expect(goalsCoincide(a, aGoal, b, bGoal)).toBe(false);
        });
    });

    describe('topActiveGoal', () => {
        it('returns the first active goal', () => {
            const g1 = mockGoal({ text: 'g1', state: 'achieved' });
            const g2 = mockGoal({ text: 'g2', state: 'active' });
            const g3 = mockGoal({ text: 'g3', state: 'active' });
            const npc = mockNpc('a', 'Alden', { goalRecords: [g1, g2, g3] });
            expect(topActiveGoal(npc)?.text).toBe('g2');
        });

        it('returns null if there are no active goals', () => {
            const g1 = mockGoal({ text: 'g1', state: 'achieved' });
            const npc = mockNpc('a', 'Alden', { goalRecords: [g1] });
            expect(topActiveGoal(npc)).toBeNull();
        });
    });

    describe('relationTone', () => {
        it('returns ally when max-magnitude relation is >= 1', () => {
            const a = mockNpc('a', 'Alden', { relations: { b: 2 } });
            const b = mockNpc('b', 'Bram', { relations: { a: 1 } });
            expect(relationTone(a, b)).toEqual({ tone: 'ally', magnitude: 2 });
        });

        it('returns rival when max-magnitude relation is <= -1', () => {
            const a = mockNpc('a', 'Alden', { relations: { b: -2 } });
            const b = mockNpc('b', 'Bram', { relations: { a: 0 } });
            expect(relationTone(a, b)).toEqual({ tone: 'rival', magnitude: -2 });
        });

        it('resolves directionality using max-magnitude (checks both directions)', () => {
            const a = mockNpc('a', 'Alden', { relations: { b: 1 } });
            const b = mockNpc('b', 'Bram', { relations: { a: -3 } });
            expect(relationTone(a, b)).toEqual({ tone: 'rival', magnitude: -3 });
        });

        it('returns neutral when relations are 0 or absent', () => {
            const a = mockNpc('a', 'Alden', { relations: { b: 0 } });
            const b = mockNpc('b', 'Bram');
            expect(relationTone(a, b)).toEqual({ tone: 'neutral', magnitude: 0 });
        });
    });

    describe('detectCollision', () => {
        it('returns the coinciding partner with the highest relation magnitude (tie-break id asc)', () => {
            const pick = mockNpc('pick', 'Alden', { region: 'academy' });
            const pickGoal = mockGoal({ text: 'slay dragon' });

            const c1 = mockNpc('npc-c1', 'Bram', { region: 'academy', relations: { pick: 1 }, goalRecords: [mockGoal()] });
            const c2 = mockNpc('npc-c2', 'Mira', { region: 'academy', relations: { pick: -2 }, goalRecords: [mockGoal()] });
            const c3 = mockNpc('npc-c3', 'Kael', { region: 'academy', relations: { pick: 2 }, goalRecords: [mockGoal()] });
            const c4 = mockNpc('npc-c4', 'Lyra', { region: 'forest', goalRecords: [mockGoal({ text: 'find flower' })] });

            const candidates = [c1, c2, c3, c4];

            const result = detectCollision(pick, pickGoal, candidates, 'calm');
            expect(result).not.toBeNull();
            expect(result?.partner.id).toBe('npc-c2');
            expect(result?.tone).toBe('rival');
        });

        it('skips a partner whose coinciding goal is blocked by stakes (tangle fizzles)', () => {
            const pick = mockNpc('pick', 'Alden', { region: 'academy' });
            const pickGoal = mockGoal({ text: 'slay dragon' });

            const c1 = mockNpc('npc-c1', 'Bram', {
                region: 'academy',
                goalRecords: [mockGoal({ horizon: 'long' })]
            });
            const candidates = [c1];

            const result = detectCollision(pick, pickGoal, candidates, 'dangerous');
            expect(result).toBeNull();
        });

        it('returns null when no candidate coincides', () => {
            const pick = mockNpc('pick', 'Alden', { region: 'academy' });
            const pickGoal = mockGoal({ text: 'slay dragon' });
            const c1 = mockNpc('npc-c1', 'Bram', { region: 'forest', goalRecords: [mockGoal({ text: 'unrelated' })] });

            expect(detectCollision(pick, pickGoal, [c1], 'calm')).toBeNull();
        });
    });

    describe('resolveTangle', () => {
        it('cooperate (ally): both roll and share the better band', () => {
            const a = mockNpc('a', 'Alden');
            const b = mockNpc('b', 'Bram');
            const aGoal = mockGoal({ failStreak: 0 });
            const bGoal = mockGoal({ failStreak: 0 });

            const rng = fixedNats([5, 15]);

            const outcome = resolveTangle(a, aGoal, b, bGoal, 'ally', rng);
            expect(outcome).toEqual({
                aBand: 'success',
                bBand: 'success',
                aFeedsB: false,
                bFeedsA: false,
            });
        });

        it('contest (rival): higher margin wins, winner gets boosted roll (loser feeds winner)', () => {
            const a = mockNpc('a', 'Alden');
            const b = mockNpc('b', 'Bram');
            const aGoal = mockGoal({ failStreak: 0 });
            const bGoal = mockGoal({ failStreak: 0 });

            const rng = fixedNats([12, 5, 10]);

            const outcome = resolveTangle(a, aGoal, b, bGoal, 'rival', rng);
            expect(outcome).toEqual({
                aBand: 'success',
                bBand: 'fail',
                aFeedsB: false,
                bFeedsA: true,
            });
        });

        it('contest (rival): B wins contest, B gets boosted roll', () => {
            const a = mockNpc('a', 'Alden');
            const b = mockNpc('b', 'Bram');
            const aGoal = mockGoal({ failStreak: 0 });
            const bGoal = mockGoal({ failStreak: 0 });

            const rng = fixedNats([5, 12, 10]);

            const outcome = resolveTangle(a, aGoal, b, bGoal, 'rival', rng);
            expect(outcome).toEqual({
                aBand: 'fail',
                bBand: 'success',
                aFeedsB: true,
                bFeedsA: false,
            });
        });

        it('mild contest (neutral): both roll, higher margin wins, NO feeding', () => {
            const a = mockNpc('a', 'Alden');
            const b = mockNpc('b', 'Bram');
            const aGoal = mockGoal({ failStreak: 0 });
            const bGoal = mockGoal({ failStreak: 0 });

            const rng = fixedNats([15, 5]);

            const outcome = resolveTangle(a, aGoal, b, bGoal, 'neutral', rng);
            expect(outcome).toEqual({
                aBand: 'success',
                bBand: 'fail',
                aFeedsB: false,
                bFeedsA: false,
            });
        });
    });

    describe('buildTangleDeltas', () => {
        it('returns exactly ONE TickDelta, leading with the higher-visibility side', () => {
            const a = mockNpc('a', 'Alden');
            const b = mockNpc('b', 'Bram');
            const aGoal = mockGoal({ text: 'aGoalText', horizon: 'med' });
            const bGoal = mockGoal({ text: 'bGoalText', horizon: 'med' });

            const deltas = buildTangleDeltas(a, aGoal, 'success', b, bGoal, 'critSuccess', 'rival');
            expect(deltas).toHaveLength(1);
            expect(deltas[0]).toEqual({
                npcId: 'b',
                npcName: 'Bram',
                goalText: 'bGoalText',
                horizon: 'med',
                band: 'critSuccess',
                visibility: 'direct',
                note: 'contesting Alden',
            });
        });

        it('leads with the first NPC (a) in case of a visibility tie', () => {
            const a = mockNpc('a', 'Alden');
            const b = mockNpc('b', 'Bram');
            const aGoal = mockGoal({ text: 'aGoalText', horizon: 'med' });
            const bGoal = mockGoal({ text: 'bGoalText', horizon: 'med' });

            const deltas = buildTangleDeltas(a, aGoal, 'critSuccess', b, bGoal, 'critSuccess', 'ally');
            expect(deltas).toHaveLength(1);
            expect(deltas[0]).toEqual({
                npcId: 'a',
                npcName: 'Alden',
                goalText: 'aGoalText',
                horizon: 'med',
                band: 'critSuccess',
                visibility: 'direct',
                note: 'cooperating with Bram',
            });
        });

        it('uses appropriate tone words in the note', () => {
            const a = mockNpc('a', 'Alden');
            const b = mockNpc('b', 'Bram');
            const aGoal = mockGoal({ text: 'aGoalText', horizon: 'med' });
            const bGoal = mockGoal({ text: 'bGoalText', horizon: 'med' });

            const d1 = buildTangleDeltas(a, aGoal, 'critSuccess', b, bGoal, 'critSuccess', 'ally');
            expect(d1[0].note).toBe('cooperating with Bram');

            const d2 = buildTangleDeltas(a, aGoal, 'critSuccess', b, bGoal, 'critSuccess', 'rival');
            expect(d2[0].note).toBe('contesting Bram');

            const d3 = buildTangleDeltas(a, aGoal, 'critSuccess', b, bGoal, 'critSuccess', 'neutral');
            expect(d3[0].note).toBe('crossing paths with Bram');
        });
    });

    describe('id-leak guard', () => {
        it('player view: renders npcName if available, avoiding raw npcId leak', () => {
            const delta = {
                npcId: 'npc-1234-xyz',
                npcName: 'Alden',
                goalText: 'defeat the goblin lord',
                horizon: 'med' as const,
                band: 'success' as const,
                visibility: 'direct' as const,
                note: 'contesting Bram',
            };

            const digest = buildDigest([delta], 'player');
            expect(digest).toContain('Alden');
            expect(digest).toContain('advanced toward');
            expect(digest).toContain('defeat the goblin lord');
            expect(digest).toContain('contesting Bram');
            expect(digest).not.toContain('npc-1234-xyz');
        });

        it('debug view: still exposes npcId for developer inspection', () => {
            const delta = {
                npcId: 'npc-1234-xyz',
                npcName: 'Alden',
                goalText: 'defeat the goblin lord',
                horizon: 'med' as const,
                band: 'success' as const,
                visibility: 'direct' as const,
                note: 'contesting Bram',
            };

            const digest = buildDigest([delta], 'debug');
            expect(digest).toContain('[npc-1234-xyz]');
            expect(digest).toContain('success(med)');
        });
    });
});
