import { describe, expect, it } from 'vitest';
import { validateCharacterAbilities, validateCharacterAbility } from '../lib/characterAbilitySchema.js';

describe('character ability API schema', () => {
    it('normalizes optional ownership metadata', () => {
        const result = validateCharacterAbility({
            abilityId: 'ash-step',
            ownerType: 'pc',
            ownerId: 'hero',
            mastery: null,
            modifications: [null, 'Carries one passenger'],
        }, 0, 10);

        expect(result.errors).toEqual([]);
        expect(result.value).toEqual(expect.objectContaining({
            abilityId: 'ash-step',
            ownerType: 'pc',
            ownerId: 'hero',
            mastery: '',
            modifications: ['Carries one passenger'],
            createdAt: 10,
        }));
    });

    it('rejects missing relationships and malformed metadata', () => {
        const result = validateCharacterAbilities([{
            ownerType: 'party',
            ownerId: '',
            abilityId: null,
            modifications: 'faster',
        }]);

        expect(result.errors).toContain('characterAbilities[0].abilityId is required');
        expect(result.errors).toContain('characterAbilities[0].ownerId is required');
        expect(result.errors).toContain('characterAbilities[0].ownerType must be "pc" or "npc"');
        expect(result.errors).toContain('characterAbilities[0].modifications must be an array or null');
    });
});
