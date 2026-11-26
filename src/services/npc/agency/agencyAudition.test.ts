import { describe, it, expect } from 'vitest';
import type { NPCEntry } from '../../../types';
import {
    DEEP_TIER_CAP,
    ACTIVITY_PROMOTE,
    ACTIVITY_RELEGATE,
} from './agencyConstants';
import {
    currentActivity,
    activityBumpPatch,
    selectTickTarget,
} from './agencyAudition';

// Helper to construct a mock NPCEntry
function mockNpc(id: string, name: string, overrides: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id,
        name,
        isPC: false,
        condition: 'healthy',
        wants: { short: [], medium: [], long: '' },
        ...overrides,
    } as unknown as NPCEntry;
}

describe('agencyAudition — Piece D: promotion / audition', () => {
    describe('currentActivity', () => {
        it('returns 0 when agencyActivity is absent', () => {
            const npc = mockNpc('npc-1', 'Alden');
            expect(currentActivity(npc, 10)).toBe(0);
        });

        it('returns value without decay when now === tick', () => {
            const npc = mockNpc('npc-1', 'Alden', {
                agencyActivity: { value: 3.5, tick: 10 }
            });
            expect(currentActivity(npc, 10)).toBe(3.5);
        });

        it('applies decay over time based on ACTIVITY_DECAY', () => {
            const npc = mockNpc('npc-1', 'Alden', {
                agencyActivity: { value: 3.0, tick: 10 }
            });
            // At tick 12: decay = 3.0 - 0.5 * (12 - 10) = 2.0
            expect(currentActivity(npc, 12)).toBe(2.0);
        });

        it('clamps decayed activity at 0', () => {
            const npc = mockNpc('npc-1', 'Alden', {
                agencyActivity: { value: 1.0, tick: 10 }
            });
            // At tick 20: decay = 1.0 - 0.5 * (20 - 10) = -4.0 -> clamp to 0
            expect(currentActivity(npc, 20)).toBe(0);
        });
    });

    describe('activityBumpPatch', () => {
        it('returns patch with value = 1 and tick = now for NPC with no prior activity', () => {
            const npc = mockNpc('npc-1', 'Alden');
            const patch = activityBumpPatch(npc, 15);
            expect(patch).toEqual({
                agencyActivity: { value: 1, tick: 15 }
            });
        });

        it('returns patch with bumped decayed activity and tick = now', () => {
            const npc = mockNpc('npc-1', 'Alden', {
                agencyActivity: { value: 3.0, tick: 10 }
            });
            // At tick 12: decayed activity is 2.0. Bumped should be 3.0.
            const patch = activityBumpPatch(npc, 12);
            expect(patch).toEqual({
                agencyActivity: { value: 3.0, tick: 12 }
            });
        });
    });

    describe('selectTickTarget', () => {
        it('returns null pick and empty deepTier when roster is empty', () => {
            const result = selectTickTarget([], 10, () => 0.5);
            expect(result).toEqual({
                pick: null,
                isAudition: false,
                deepTier: []
            });
        });

        it('respects DEEP_TIER_CAP and ranks by activity desc, tie-breaking by id asc', () => {
            const n1 = mockNpc('npc-a', 'Alden', { agencyActivity: { value: 1.0, tick: 10 } });
            const n2 = mockNpc('npc-b', 'Bram', { agencyActivity: { value: 2.5, tick: 10 } });
            const n3 = mockNpc('npc-c', 'Mira', { agencyActivity: { value: 2.0, tick: 10 } });
            const n4 = mockNpc('npc-d', 'Kael', { agencyActivity: { value: 2.0, tick: 10 } });
            const n5 = mockNpc('npc-e', 'Lyra', { agencyActivity: { value: 0.5, tick: 10 } });

            const roster = [n1, n2, n3, n4, n5];

            // At tick 10:
            // n2: 2.5
            // n3: 2.0, n4: 2.0 -> tied, id 'npc-c' < 'npc-d', so n3 ranks above n4
            // n1: 1.0
            // n5: 0.5
            // With DEEP_TIER_CAP = 3, deepTier should be: [n2, n3, n4]
            const result = selectTickTarget(roster, 10, () => 0.9); // rng >= AUDITION_PROB (0.15) to pick from deep tier
            expect(result.deepTier).toHaveLength(DEEP_TIER_CAP);
            expect(result.deepTier[0].id).toBe('npc-b');
            expect(result.deepTier[1].id).toBe('npc-c');
            expect(result.deepTier[2].id).toBe('npc-d');
        });

        it('resolves cold start by taking the lowest-id NPCs in deepTier', () => {
            const n1 = mockNpc('npc-z', 'Zelda');
            const n2 = mockNpc('npc-a', 'Alden');
            const n3 = mockNpc('npc-k', 'Kael');
            const n4 = mockNpc('npc-b', 'Bram');

            const roster = [n1, n2, n3, n4];
            // Everyone is at 0. Sorting by current desc (0 for all), then id asc:
            // 'npc-a' (n2) < 'npc-b' (n4) < 'npc-k' (n3) < 'npc-z' (n1)
            // Top 3 should be: [n2, n4, n3] (Alden, Bram, Kael)
            const result = selectTickTarget(roster, 10, () => 0.9);
            expect(result.deepTier).toHaveLength(DEEP_TIER_CAP);
            expect(result.deepTier[0].id).toBe('npc-a');
            expect(result.deepTier[1].id).toBe('npc-b');
            expect(result.deepTier[2].id).toBe('npc-k');
        });

        it('triggers audition when rng() < AUDITION_PROB and returns a background NPC', () => {
            const n1 = mockNpc('npc-a', 'Alden', { agencyActivity: { value: 3.0, tick: 10 } });
            const n2 = mockNpc('npc-b', 'Bram', { agencyActivity: { value: 2.0, tick: 10 } });
            const n3 = mockNpc('npc-c', 'Mira', { agencyActivity: { value: 1.5, tick: 10 } });
            const n4 = mockNpc('npc-d', 'Kael', { agencyActivity: { value: 0.5, tick: 10 } }); // Background 1
            const n5 = mockNpc('npc-e', 'Lyra', { agencyActivity: { value: 0.2, tick: 10 } }); // Background 2

            const roster = [n1, n2, n3, n4, n5];

            // Deep tier is [n1, n2, n3]
            // Background is [n4, n5]
            
            // Seeded RNG:
            // First call (audition roll): returns 0.1 (which is < AUDITION_PROB 0.15) -> audition triggers!
            // Second call (audition pick): background.length = 2.
            // Math.floor(rng() * 2) should pick background[1] if rng() yields 0.9.
            // Math.floor(0.9 * 2) = Math.floor(1.8) = 1.
            let callCount = 0;
            const customRng = () => {
                callCount++;
                if (callCount === 1) return 0.1; // Audition triggers
                return 0.9; // Index 1 of background
            };

            const result = selectTickTarget(roster, 10, customRng);
            expect(result.isAudition).toBe(true);
            expect(result.pick?.id).toBe('npc-e'); // Lyra (background[1])
            expect(result.deepTier.map(x => x.id)).toEqual(['npc-a', 'npc-b', 'npc-c']);
        });

        it('picks from deepTier when rng() >= AUDITION_PROB', () => {
            const n1 = mockNpc('npc-a', 'Alden', { agencyActivity: { value: 3.0, tick: 10 } });
            const n2 = mockNpc('npc-b', 'Bram', { agencyActivity: { value: 2.0, tick: 10 } });
            const n3 = mockNpc('npc-c', 'Mira', { agencyActivity: { value: 1.5, tick: 10 } });
            const n4 = mockNpc('npc-d', 'Kael', { agencyActivity: { value: 0.5, tick: 10 } });

            const roster = [n1, n2, n3, n4];

            // Seeded RNG:
            // First call (audition roll): returns 0.5 (which is >= AUDITION_PROB 0.15) -> no audition
            // Second call (deep-tier pick): deepTier.length = 3.
            // Math.floor(rng() * 3) should pick deepTier[2] if rng() yields 0.8.
            // Math.floor(0.8 * 3) = Math.floor(2.4) = 2.
            let callCount = 0;
            const customRng = () => {
                callCount++;
                if (callCount === 1) return 0.5; // No audition
                return 0.8; // Index 2 of deepTier
            };

            const result = selectTickTarget(roster, 10, customRng);
            expect(result.isAudition).toBe(false);
            expect(result.pick?.id).toBe('npc-c'); // Mira (deepTier[2])
        });

        it('skips audition roll and picks from deepTier when there are no background NPCs', () => {
            const n1 = mockNpc('npc-a', 'Alden', { agencyActivity: { value: 3.0, tick: 10 } });
            const n2 = mockNpc('npc-b', 'Bram', { agencyActivity: { value: 2.0, tick: 10 } });
            const roster = [n1, n2];

            let callCount = 0;
            const customRng = () => {
                callCount++;
                return 0.99; // Index 1
            };

            const result = selectTickTarget(roster, 10, customRng);
            expect(result.isAudition).toBe(false);
            expect(result.pick?.id).toBe('npc-b');
            expect(callCount).toBe(1); // Only called once because background is empty
        });
    });

    describe('Sustained-activity promotion & relegation sanity', () => {
        it('drives currentActivity to >= ACTIVITY_PROMOTE under repeated bumps, and decays to 0 under neglect', () => {
            let npc = mockNpc('npc-1', 'Alden');

            // Simulate repeated bumps each turn.
            // ACTIVITY_PROMOTE is 3. Bumps are +1, decay is 0.5 per beat.
            // Let's bump at ticks 1, 2, 3, 4, 5, 6.
            // Tick 1: first bump. Decayed activity is 0. Bumped: value 1.0, tick 1.
            npc = { ...npc, ...activityBumpPatch(npc, 1) };
            expect(currentActivity(npc, 1)).toBe(1.0);

            // Tick 2: decayed is 1.0 - 0.5 * 1 = 0.5. Bumped: value 1.5, tick 2.
            npc = { ...npc, ...activityBumpPatch(npc, 2) };
            expect(currentActivity(npc, 2)).toBe(1.5);

            // Tick 3: decayed is 1.5 - 0.5 * 1 = 1.0. Bumped: value 2.0, tick 3.
            npc = { ...npc, ...activityBumpPatch(npc, 3) };
            expect(currentActivity(npc, 3)).toBe(2.0);

            // Tick 4: decayed is 2.0 - 0.5 * 1 = 1.5. Bumped: value 2.5, tick 4.
            npc = { ...npc, ...activityBumpPatch(npc, 4) };
            expect(currentActivity(npc, 4)).toBe(2.5);

            // Tick 5: decayed is 2.5 - 0.5 * 1 = 2.0. Bumped: value 3.0, tick 5.
            npc = { ...npc, ...activityBumpPatch(npc, 5) };
            expect(currentActivity(npc, 5)).toBe(3.0); // reached ACTIVITY_PROMOTE = 3!

            // Tick 6: decayed is 3.0 - 0.5 * 1 = 2.5. Bumped: value 3.5, tick 6.
            npc = { ...npc, ...activityBumpPatch(npc, 6) };
            expect(currentActivity(npc, 6)).toBe(3.5);
            expect(currentActivity(npc, 6)).toBeGreaterThanOrEqual(ACTIVITY_PROMOTE);

            // Now, simulate neglect. Tick advances but no bumps are applied.
            // From tick 6 to tick 13 (7 ticks of neglect):
            // Activity at tick 13: 3.5 - 0.5 * 7 = 0.
            expect(currentActivity(npc, 13)).toBe(0);
            expect(currentActivity(npc, 13)).toBeLessThanOrEqual(ACTIVITY_RELEGATE);
        });
    });
});
