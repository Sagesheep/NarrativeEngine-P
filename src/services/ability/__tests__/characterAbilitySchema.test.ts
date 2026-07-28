import { describe, expect, it } from 'vitest';
import { createEmptyCharacterAbility, normalizeCharacterAbilities } from '../characterAbilitySchema';

describe('character ability normalization', () => {
    it('creates a complete owner assignment', () => {
        expect(createEmptyCharacterAbility('npc', 'marcus', 'ash-step', {
            now: 10,
            createId: () => 'known-1',
        })).toEqual(expect.objectContaining({
            id: 'known-1',
            ownerType: 'npc',
            ownerId: 'marcus',
            abilityId: 'ash-step',
            modifications: [],
            promptEnabled: true,
        }));
    });

    it('keeps valid entries and reports broken relationships', () => {
        const result = normalizeCharacterAbilities([
            {
                abilityId: 'ash-step',
                ownerType: 'pc',
                ownerId: 'hero',
                modifications: [' Faster ', 3],
            },
            { abilityId: '', ownerType: 'pc', ownerId: 'hero' },
        ], { now: 20, createId: () => 'known-2' });

        expect(result.entries[0]).toEqual(expect.objectContaining({
            id: 'known-2',
            modifications: ['Faster'],
        }));
        expect(result.skipped).toBe(1);
    });
});
