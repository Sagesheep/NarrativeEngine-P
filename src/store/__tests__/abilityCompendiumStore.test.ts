import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../useAppStore';
import { createEmptyAbilityEntry } from '../../services/ability/abilitySchema';
import { createEmptyAbilityRuntimeState } from '../../services/ability/abilityRuntimeSchema';

describe('ability compendium store actions', () => {
    beforeEach(() => useAppStore.setState({
        activeCampaignId: null,
        abilityCompendium: [],
        characterAbilities: [],
        abilityRuntimeStates: [],
    }));

    it('adds, updates, and removes definitions without runtime state', () => {
        const entry = {
            ...createEmptyAbilityEntry({ now: 1, createId: () => 'ash-step' }),
            name: 'Ash Step',
        };
        useAppStore.getState().addAbility(entry);
        expect(useAppStore.getState().abilityCompendium).toEqual([entry]);

        useAppStore.getState().updateAbility(entry.id, { effect: 'Move through flame.' });
        expect(useAppStore.getState().abilityCompendium[0].effect).toBe('Move through flame.');

        useAppStore.getState().removeAbility(entry.id);
        expect(useAppStore.getState().abilityCompendium).toEqual([]);
    });

    it('deduplicates owner-definition pairs and cascades definition deletion', () => {
        const entry = {
            ...createEmptyAbilityEntry({ now: 1, createId: () => 'ash-step' }),
            name: 'Ash Step',
        };
        useAppStore.getState().addAbility(entry);
        useAppStore.getState().addCharacterAbility({
            id: 'known-1',
            abilityId: entry.id,
            ownerType: 'pc',
            ownerId: 'hero',
            mastery: 'Novice',
            variantName: '',
            modifications: [],
            learnedSceneId: '',
            notes: '',
            promptEnabled: true,
            createdAt: 1,
            updatedAt: 1,
        });
        useAppStore.getState().upsertAbilityRuntimeState({
            ...createEmptyAbilityRuntimeState('known-1', { now: 1, createId: () => 'runtime-1' }),
            cooldownRemaining: 2,
            cooldownMax: 3,
            activeEffects: [{ id: 'effect-1', name: 'Marked', remainingTurns: 2, notes: '' }],
        });
        useAppStore.getState().addCharacterAbility({
            ...useAppStore.getState().characterAbilities[0],
            id: 'known-replacement',
            mastery: 'Adept',
        });

        expect(useAppStore.getState().characterAbilities).toHaveLength(1);
        expect(useAppStore.getState().characterAbilities[0].mastery).toBe('Adept');
        expect(useAppStore.getState().abilityRuntimeStates).toEqual([]);

        useAppStore.getState().upsertAbilityRuntimeState({
            ...createEmptyAbilityRuntimeState('known-replacement', { now: 1, createId: () => 'runtime-2' }),
            cooldownRemaining: 2,
            cooldownMax: 3,
            activeEffects: [{ id: 'effect-2', name: 'Marked', remainingTurns: 2, notes: '' }],
        });
        useAppStore.getState().advanceAbilityRuntimeTurn('known-replacement');
        expect(useAppStore.getState().abilityRuntimeStates[0]).toEqual(expect.objectContaining({
            cooldownRemaining: 1,
            activeEffects: [expect.objectContaining({ remainingTurns: 1 })],
        }));

        useAppStore.getState().removeAbility(entry.id);
        expect(useAppStore.getState().characterAbilities).toEqual([]);
        expect(useAppStore.getState().abilityRuntimeStates).toEqual([]);
    });
});
