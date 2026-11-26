import { describe, it, expect } from 'vitest';
import { applyTierCross } from './agencyDrift';
import type { NPCEntry, Goal } from '../../../types';

describe('agencyRung — applyTierCross', () => {
    function createGoal(overrides: Partial<Goal> = {}): Goal {
        return {
            text: 'test goal',
            horizon: 'med',
            tier: 'default',
            base_heat: 2,
            lastAdvancedTick: 0,
            failStreak: 0,
            progress: 10,
            quota: 10,
            state: 'active',
            justifiedEventFlag: true,
            ...overrides
        };
    }

    function createNpc(overrides: Partial<NPCEntry> = {}): NPCEntry {
        return {
            id: 'n1',
            name: 'Alden',
            isPC: false,
            skillRung: 0,
            rungCeiling: 3,
            ...overrides
        } as unknown as NPCEntry;
    }

    it('cross bumps: goal with progress >= quota && justifiedEventFlag -> skillRung +1, flag cleared, progress reset', () => {
        const npc = createNpc({ skillRung: 1, rungCeiling: 3 });
        const goal = createGoal({ progress: 10, quota: 10, justifiedEventFlag: true });

        const result = applyTierCross(npc, goal);
        expect(result).not.toBeNull();

        const { updatedGoal, rungPatch, rungShiftLine } = result!;
        expect(rungPatch).toBe(2);
        expect(updatedGoal.justifiedEventFlag).toBe(false);
        expect(updatedGoal.progress).toBe(0);
        expect(rungShiftLine).toBe('SHIFT: Skilled → Expert');
    });

    it('grind can\'t cross: progress >= quota but justifiedEventFlag:false -> no bump (returns null)', () => {
        const npc = createNpc({ skillRung: 1, rungCeiling: 3 });
        const goal = createGoal({ progress: 10, quota: 10, justifiedEventFlag: false });

        const result = applyTierCross(npc, goal);
        expect(result).toBeNull();
    });

    it('ceiling cap: NPC at skillRung === rungCeiling with a valid cross -> cross consumed (flag cleared, progress reset) but skillRung unchanged (rungPatch undefined)', () => {
        const npc = createNpc({ skillRung: 3, rungCeiling: 3 });
        const goal = createGoal({ progress: 10, quota: 10, justifiedEventFlag: true });

        const result = applyTierCross(npc, goal);
        expect(result).not.toBeNull();

        const { updatedGoal, rungPatch, rungShiftLine } = result!;
        expect(rungPatch).toBeUndefined();
        expect(updatedGoal.justifiedEventFlag).toBe(false);
        expect(updatedGoal.progress).toBe(0);
        expect(rungShiftLine).toBe('');
    });

    it('word-band: the surfaced shift uses RUNG_LABELS text, not the integer', () => {
        const npc = createNpc({ skillRung: 0, rungCeiling: 3 });
        const goal = createGoal({ progress: 10, quota: 10, justifiedEventFlag: true });

        const result = applyTierCross(npc, goal);
        expect(result).not.toBeNull();
        expect(result!.rungShiftLine).toBe('SHIFT: Novice → Skilled');
    });
});
