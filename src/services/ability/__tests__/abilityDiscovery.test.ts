import { describe, expect, it } from 'vitest';
import type { AbilityEntry, CharacterAbility } from '../../../types';
import { sanitizeAbilityProposalResponse } from '../abilityDiscovery';
import { createEmptyAbilityEntry } from '../abilitySchema';
import { createEmptyCharacterAbility } from '../characterAbilitySchema';

const ability: AbilityEntry = {
    ...createEmptyAbilityEntry({ now: 1, createId: () => 'target-mark' }),
    name: 'Target Mark',
};
const assignment: CharacterAbility = {
    ...createEmptyCharacterAbility('pc', 'parallax', 'target-mark', { now: 1, createId: () => 'owned-target-mark' }),
    mastery: 'Rank 1',
};
const owners = [{ type: 'pc' as const, id: 'parallax', name: 'Parallax' }];

describe('ability discovery sanitizer', () => {
    it('accepts reviewable new, assignment, and progression proposals', () => {
        const result = sanitizeAbilityProposalResponse({ proposals: [
            {
                kind: 'new',
                abilityName: 'Ghost Step',
                category: 'reaction',
                effect: 'Move without drawing fire.',
            },
            {
                kind: 'progression',
                abilityId: 'target-mark',
                abilityName: 'Target Mark',
                ownerType: 'pc',
                ownerId: 'parallax',
                mastery: 'Rank 2',
            },
        ] }, [ability], [assignment], owners);

        expect(result).toHaveLength(2);
        expect(result.map(entry => entry.kind)).toEqual(['new', 'progression']);
    });

    it('drops hallucinated IDs, duplicate canon, and invalid ownership transitions', () => {
        const result = sanitizeAbilityProposalResponse({ proposals: [
            { kind: 'new', abilityName: 'Target Mark' },
            { kind: 'assign', abilityId: 'missing', ownerType: 'pc', ownerId: 'parallax' },
            { kind: 'assign', abilityId: 'target-mark', ownerType: 'pc', ownerId: 'parallax' },
            { kind: 'progression', abilityId: 'target-mark', ownerType: 'pc', ownerId: 'unknown', mastery: 'Rank 2' },
        ] }, [ability], [assignment], owners);

        expect(result).toEqual([]);
    });

    it('accepts only progression tier and upgrade IDs defined by the canonical ability', () => {
        const structured = {
            ...ability,
            masteryLadder: [{ id: 'adept', name: 'Adept', requirements: '', benefits: '' }],
            upgradeNodes: [{
                id: 'long-range',
                branch: 'Control',
                name: 'Long Range',
                description: '',
                prerequisiteTierId: 'adept',
                prerequisiteUpgradeIds: [],
            }],
        };
        const result = sanitizeAbilityProposalResponse({ proposals: [{
            kind: 'progression',
            abilityId: 'target-mark',
            ownerType: 'pc',
            ownerId: 'parallax',
            masteryTierId: 'adept',
            upgradeId: 'long-range',
            trainingDelta: 2,
        }, {
            kind: 'progression',
            abilityId: 'target-mark',
            ownerType: 'pc',
            ownerId: 'parallax',
            masteryTierId: 'hallucinated-tier',
            upgradeId: 'hallucinated-upgrade',
        }] }, [structured], [assignment], owners);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual(expect.objectContaining({
            masteryTierId: 'adept',
            upgradeId: 'long-range',
            trainingDelta: 2,
        }));
    });
});
