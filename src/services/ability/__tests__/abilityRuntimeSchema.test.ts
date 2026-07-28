import { describe, expect, it } from 'vitest';
import {
    activateAbilityRuntimeState,
    advanceAbilityRuntimeState,
    canActivateAbility,
    createEmptyAbilityRuntimeState,
    normalizeAbilityRuntimeStates,
    resetAbilityRuntimeState,
} from '../abilityRuntimeSchema';

describe('ability runtime state', () => {
    it('activates, advances, expires effects, and resets deterministically', () => {
        const base = {
            ...createEmptyAbilityRuntimeState('known-1', { now: 1, createId: () => 'runtime-1' }),
            cooldownMax: 3,
            chargesMax: 2,
            chargesRemaining: 2,
            activeEffects: [{ id: 'effect-1', name: 'Accuracy Up', remainingTurns: 2, notes: '' }],
        };

        const activated = activateAbilityRuntimeState(base, '007', 2);
        expect(activated).toEqual(expect.objectContaining({
            cooldownRemaining: 3,
            chargesRemaining: 1,
            uses: 1,
            lastUsedSceneId: '007',
        }));
        expect(canActivateAbility(activated).ok).toBe(false);

        const advanced = advanceAbilityRuntimeState(activated, 3);
        expect(advanced.cooldownRemaining).toBe(2);
        expect(advanced.activeEffects[0].remainingTurns).toBe(1);
        expect(advanceAbilityRuntimeState(advanced, 4).activeEffects).toEqual([]);

        const reset = resetAbilityRuntimeState(advanced, 5);
        expect(reset.cooldownRemaining).toBe(0);
        expect(reset.chargesRemaining).toBe(2);
        expect(reset.activeEffects).toEqual([]);
    });

    it('normalizes charge bounds and skips rows without an ownership reference', () => {
        const result = normalizeAbilityRuntimeStates([
            { characterAbilityId: 'known-1', chargesMax: 2, chargesRemaining: 9 },
            { cooldownRemaining: 2 },
        ], { now: 1, createId: () => 'runtime-1' });

        expect(result.skipped).toBe(1);
        expect(result.entries[0].chargesRemaining).toBe(2);
    });
});
