import { describe, expect, it } from 'vitest';
import { validateAbilityRuntimeState, validateAbilityRuntimeStates } from '../lib/abilityRuntimeSchema.js';

describe('ability runtime API schema', () => {
    it('normalizes safe runtime fields and bounds charges', () => {
        const result = validateAbilityRuntimeState({
            characterAbilityId: 'known-1',
            cooldownRemaining: 2,
            cooldownMax: 3,
            chargesRemaining: 8,
            chargesMax: 2,
            activeEffects: [{ name: 'Accuracy Up', remainingTurns: 2 }],
        }, 0, 10);

        expect(result.errors).toEqual([]);
        expect(result.value).toEqual(expect.objectContaining({
            characterAbilityId: 'known-1',
            chargesRemaining: 2,
            chargesMax: 2,
            updatedAt: 10,
        }));
        expect(result.value.activeEffects[0]).toEqual(expect.objectContaining({
            name: 'Accuracy Up',
            remainingTurns: 2,
        }));
    });

    it('rejects invalid relationships and collection shapes', () => {
        expect(validateAbilityRuntimeState({ cooldownRemaining: -1 }).errors).toEqual(expect.arrayContaining([
            'abilityRuntimeStates[0].characterAbilityId is required',
            'abilityRuntimeStates[0].cooldownRemaining must be a non-negative finite number or null',
        ]));
        expect(validateAbilityRuntimeStates({}).errors).toEqual(['Ability runtime states must be an array']);
    });
});
