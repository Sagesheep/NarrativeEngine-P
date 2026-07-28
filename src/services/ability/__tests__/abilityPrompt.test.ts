import { describe, expect, it } from 'vitest';
import type { AbilityEntry, AbilityRuntimeState, CharacterAbility, ChatMessage, NPCEntry } from '../../../types';
import { createEmptyAbilityEntry } from '../abilitySchema';
import { buildRelevantAbilityBlock } from '../abilityPrompt';

const ability = (name: string, patch: Partial<AbilityEntry> = {}): AbilityEntry => ({
    ...createEmptyAbilityEntry({ now: 1, createId: () => name }),
    name,
    effect: 'Relocate through an existing flame.',
    costs: [{ resource: 'Aura', amount: '8', timing: 'On activation', condition: '' }],
    limitations: ['Cannot carry another person'],
    ...patch,
});

const history = (content: string): ChatMessage[] => [{
    id: 'm1',
    role: 'assistant',
    content,
    timestamp: 1,
}];

describe('ability prompt selection', () => {
    it('matches exact names and comma-delimited aliases from recent play', () => {
        const output = buildRelevantAbilityBlock([
            ability('Ash Step', { aliases: 'Cinder Walk, Ember Passage' }),
            ability('Ward'),
        ], history('The room is quiet.'), 'I use Cinder Walk.', 1000);

        expect(output).toContain('ABILITY: Ash Step');
        expect(output).toContain('COSTS: Aura | 8 | On activation');
        expect(output).not.toContain('ABILITY: Ward');
    });

    it('does not substring-match names or include disabled definitions', () => {
        expect(buildRelevantAbilityBlock([ability('Ward')], [], 'I walk toward the garden.', 1000)).toBe('');
        expect(buildRelevantAbilityBlock([ability('Ash Step', { promptEnabled: false })], [], 'Use Ash Step.', 1000)).toBe('');
    });

    it('never exceeds its hard token budget', () => {
        const output = buildRelevantAbilityBlock([
            ability('Ash Step', { gmNotes: 'secret '.repeat(400) }),
        ], [], 'Use Ash Step.', 45);
        expect(output).toContain('ABILITY: Ash Step');
        expect(output).not.toContain('GM NOTES');
    });

    it('annotates PC and on-stage NPC variants without changing canon', () => {
        const ashStep = ability('Ash Step');
        const owned = (ownerType: 'pc' | 'npc', ownerId: string, patch: Partial<CharacterAbility> = {}): CharacterAbility => ({
            id: `${ownerId}-ash`,
            abilityId: ashStep.id,
            ownerType,
            ownerId,
            mastery: '',
            variantName: '',
            modifications: [],
            learnedSceneId: '',
            notes: '',
            promptEnabled: true,
            createdAt: 1,
            updatedAt: 1,
            ...patch,
        });
        const hero = { id: 'hero', name: 'Kael' } as NPCEntry;
        const marcus = { id: 'marcus', name: 'Marcus' } as NPCEntry;
        const offstage = { id: 'sable', name: 'Sable' } as NPCEntry;

        const output = buildRelevantAbilityBlock([ashStep], [], 'I use Ash Step.', 1000, 4, {
            characterAbilities: [
                owned('pc', 'hero', { mastery: 'Adept', variantName: 'Cinder Walk' }),
                owned('npc', 'marcus', { modifications: ['Can carry one passenger'] }),
                owned('npc', 'sable', { mastery: 'Master' }),
            ],
            playerCharacter: hero,
            npcLedger: [marcus, offstage],
            onStageNpcIds: ['marcus'],
        });

        expect(output).toContain('KNOWN BY: Kael | MASTERY: Adept | VARIANT: Cinder Walk');
        expect(output).toContain('OWNER MODIFICATIONS (Marcus): Can carry one passenger');
        expect(output).not.toContain('Sable');
        expect(output).toContain('EFFECT: Relocate through an existing flame.');
    });

    it('injects runtime availability for a relevant owned ability', () => {
        const ashStep = ability('Ash Step');
        const ownership: CharacterAbility = {
            id: 'known-ash',
            abilityId: ashStep.id,
            ownerType: 'pc',
            ownerId: 'hero',
            mastery: 'Adept',
            variantName: '',
            modifications: [],
            learnedSceneId: '',
            notes: '',
            promptEnabled: true,
            createdAt: 1,
            updatedAt: 1,
        };
        const runtime: AbilityRuntimeState = {
            id: 'runtime-ash',
            characterAbilityId: ownership.id,
            cooldownRemaining: 2,
            cooldownMax: 4,
            chargesRemaining: 1,
            chargesMax: 3,
            activeEffects: [{ id: 'effect-1', name: 'Afterimage', remainingTurns: 2, notes: 'Evasion up' }],
            uses: 5,
            lastUsedSceneId: '007',
            notes: '',
            updatedAt: 1,
        };
        const hero = { id: 'hero', name: 'Kael' } as NPCEntry;

        const output = buildRelevantAbilityBlock([ashStep], [], 'I use Ash Step.', 1000, 4, {
            characterAbilities: [ownership],
            abilityRuntimeStates: [runtime],
            playerCharacter: hero,
        });

        expect(output).toContain('RUNTIME (Kael): COOLDOWN 2/4 | CHARGES 1/3 | USES 5 | LAST USED scene 007');
        expect(output).toContain('ACTIVE EFFECTS (Kael): Afterimage (2 turns; Evasion up)');
    });
});
