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

    it('normalizes structured progression and completed milestones', () => {
        const result = validateCharacterAbility({
            abilityId: 'ash-step',
            ownerType: 'pc',
            ownerId: 'hero',
            masteryTierId: 'adept',
            unlockedUpgradeIds: ['passenger'],
            trainingProgress: 3.8,
            trainingGoal: 5,
            trainingMilestones: [{
                id: 'wildfire',
                name: 'Cross a Wildfire',
                completed: true,
                completedSceneId: '009',
                completedAt: 20,
            }],
        });

        expect(result.errors).toEqual([]);
        expect(result.value).toEqual(expect.objectContaining({
            masteryTierId: 'adept',
            unlockedUpgradeIds: ['passenger'],
            trainingProgress: 3,
            trainingGoal: 5,
            trainingMilestones: [expect.objectContaining({
                name: 'Cross a Wildfire',
                completed: true,
            })],
        }));
    });
});
