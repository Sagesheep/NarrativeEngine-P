import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../useAppStore';
import { createEmptyAbilityEntry } from '../../services/ability/abilitySchema';

describe('ability compendium store actions', () => {
    beforeEach(() => useAppStore.setState({
        activeCampaignId: null,
        abilityCompendium: [],
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
});
