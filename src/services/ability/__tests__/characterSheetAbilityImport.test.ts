import { describe, expect, it } from 'vitest';
import type { AbilityEntry, AbilityProposal, CharacterAbility } from '../../../types';
import { createEmptyAbilityEntry } from '../abilitySchema';
import { createEmptyCharacterAbility } from '../characterAbilitySchema';
import {
    buildCharacterSheetAbilityImport,
    parseCharacterSheetAbility,
} from '../characterSheetAbilityImport';

const existingAbility: AbilityEntry = {
    ...createEmptyAbilityEntry({ now: 1, createId: () => 'message' }),
    name: 'Message',
};

const ownedAbility: CharacterAbility = createEmptyCharacterAbility(
    'pc',
    'veronica',
    'message',
    { now: 1, createId: () => 'owned-message' },
);

const pendingProposal: AbilityProposal = {
    id: 'pending',
    kind: 'new',
    abilityId: '',
    abilityName: 'Thunderwave',
    ownerType: 'pc',
    ownerId: 'veronica',
    category: 'active',
    origin: 'spell',
    effect: '',
    activation: '',
    mastery: '',
    masteryTierId: '',
    modification: '',
    upgradeId: '',
    trainingDelta: 0,
    reason: '',
    evidence: '',
    sourceSceneId: '',
    createdAt: 1,
    updatedAt: 1,
};

describe('character sheet ability import', () => {
    it('parses spell labels without retaining the sheet prefix in the canonical name', () => {
        expect(parseCharacterSheetAbility('Cantrip: Prestidigitation')).toMatchObject({
            name: 'Prestidigitation',
            category: 'active',
            origin: 'spell',
            activation: 'Cast as a cantrip',
        });
        expect(parseCharacterSheetAbility('1st-level spell: Feather Fall')).toMatchObject({
            name: 'Feather Fall',
            origin: 'spell',
            activation: 'Cast as a 1st-level spell',
        });
    });

    it('creates review proposals, skips pending entries, and identifies already-owned text for cleanup', () => {
        const result = buildCharacterSheetAbilityImport(
            [
                'Cantrip: Message',
                'Cantrip: Prestidigitation',
                '1st-level spell: Thunderwave',
            ],
            'veronica',
            [existingAbility],
            [ownedAbility],
            [pendingProposal],
        );

        expect(result.alreadyTrackedSources).toEqual(['Cantrip: Message']);
        expect(result.pendingSources).toEqual(['1st-level spell: Thunderwave']);
        expect(result.proposals).toHaveLength(1);
        expect(result.proposals[0]).toMatchObject({
            kind: 'new',
            abilityName: 'Prestidigitation',
            ownerType: 'pc',
            ownerId: 'veronica',
            sourceProfileAbility: 'Cantrip: Prestidigitation',
            origin: 'spell',
        });
    });

    it('creates an assignment proposal when the canonical ability already exists', () => {
        const result = buildCharacterSheetAbilityImport(
            ['Cantrip: Message'],
            'veronica',
            [existingAbility],
            [],
            [],
        );

        expect(result.proposals[0]).toMatchObject({
            kind: 'assign',
            abilityId: 'message',
            abilityName: 'Message',
        });
    });

    it('converts the D&D sheet format into assigned review proposals', () => {
        const result = buildCharacterSheetAbilityImport(
            [
                'Bardic Inspiration (d6)',
                'Spellcasting (Charisma; lute may serve as spellcasting focus)',
                'Rapier attack: +4 to hit, 1d8+2 piercing',
                'Dagger attack: +4 to hit, 1d4+2 piercing',
                'Weapon Mastery: Rapier (Vex)',
                'Weapon Mastery: Dagger (Nick)',
                'Darkvision (60 ft)',
                'Otherworldly Presence (Thaumaturgy)',
                'Origin Feat: Musician',
                'Cantrip: Message',
                'Cantrip: Prestidigitation',
                'Cantrip: Thaumaturgy',
                '1st-level spell: Feather Fall',
                '1st-level spell: Color Spray',
                '1st-level spell: Cure Wounds',
                '1st-level spell: Thunderwave',
            ],
            'veronica',
            [],
            [],
            [],
        );

        expect(result.proposals).toHaveLength(16);
        expect(result.proposals.map(proposal => proposal.abilityName)).toEqual(expect.arrayContaining([
            'Bardic Inspiration',
            'Message',
            'Prestidigitation',
            'Thaumaturgy',
            'Feather Fall',
            'Color Spray',
            'Cure Wounds',
            'Thunderwave',
        ]));
        expect(result.proposals.every(proposal =>
            proposal.ownerType === 'pc' && proposal.ownerId === 'veronica')).toBe(true);
    });
});
