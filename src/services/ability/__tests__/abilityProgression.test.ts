import { describe, expect, it } from 'vitest';
import { createEmptyAbilityEntry } from '../abilitySchema';
import { createEmptyCharacterAbility } from '../characterAbilitySchema';
import {
    getUpgradeAvailability,
    setCharacterMasteryTier,
    toggleCharacterUpgrade,
} from '../abilityProgression';

const ability = {
    ...createEmptyAbilityEntry({ now: 1, createId: () => 'ember-song' }),
    name: 'Ember Song',
    masteryLadder: [
        { id: 'novice', name: 'Novice', requirements: '', benefits: '' },
        { id: 'adept', name: 'Adept', requirements: 'Train twice', benefits: 'Stronger flames' },
    ],
    upgradeNodes: [
        {
            id: 'wide-chorus',
            branch: 'Control',
            name: 'Wide Chorus',
            description: 'Widen the area.',
            prerequisiteTierId: 'adept',
            prerequisiteUpgradeIds: [],
        },
        {
            id: 'lasting-chorus',
            branch: 'Control',
            name: 'Lasting Chorus',
            description: 'Extend the duration.',
            prerequisiteTierId: '',
            prerequisiteUpgradeIds: ['wide-chorus'],
        },
    ],
};

const assignment = createEmptyCharacterAbility('pc', 'hero', ability.id, {
    now: 1,
    createId: () => 'known-ember-song',
});

describe('ability progression', () => {
    it('keeps the free-text mastery label synchronized with structured tiers', () => {
        expect(setCharacterMasteryTier(ability, assignment, 'adept')).toMatchObject({
            masteryTierId: 'adept',
            mastery: 'Adept',
        });
    });

    it('enforces tier and prior-upgrade prerequisites', () => {
        const wide = ability.upgradeNodes[0];
        expect(getUpgradeAvailability(ability, assignment, wide)).toEqual({
            available: false,
            reasons: ['Requires Adept'],
        });

        const adept = setCharacterMasteryTier(ability, assignment, 'adept');
        const withWide = toggleCharacterUpgrade(ability, adept, 'wide-chorus');
        expect(withWide.unlockedUpgradeIds).toEqual(['wide-chorus']);
        expect(getUpgradeAvailability(ability, withWide, ability.upgradeNodes[1]).available).toBe(true);
    });

    it('removes direct dependant upgrades when their prerequisite is revoked', () => {
        const progressed = {
            ...setCharacterMasteryTier(ability, assignment, 'adept'),
            unlockedUpgradeIds: ['wide-chorus', 'lasting-chorus'],
        };
        expect(toggleCharacterUpgrade(ability, progressed, 'wide-chorus').unlockedUpgradeIds).toEqual([]);
    });
});
