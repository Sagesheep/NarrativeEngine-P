import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnemyEntry } from '../../types';
import { useAppStore } from '../useAppStore';

const template: EnemyEntry = {
    id: 'orc-template',
    name: 'Orc Warrior',
    aliases: '',
    classification: 'Orc',
    description: '',
    threatTier: '',
    tags: [],
    faction: '',
    stats: [],
    actions: [],
    passiveTraits: [],
    specialBehaviors: [],
    weaknesses: [],
    resistances: [],
    tactics: '',
    loot: '',
    gmNotes: '',
    promptEnabled: true,
    createdAt: 1,
    updatedAt: 1,
};

describe('enemy suggestion queue', () => {
    beforeEach(() => {
        vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'suggestion-id') });
        useAppStore.setState({
            activeCampaignId: null,
            enemyCompendium: [template],
            enemySuggestions: [],
        });
    });

    it('queues review-only suggestions without mutating the compendium', () => {
        useAppStore.getState().addEnemySuggestions([
            { kind: 'alias', name: 'Orcish Warrior', targetEnemyId: template.id, reason: 'Narrated synonym' },
        ], 'The Orcish Warrior advances.');

        const state = useAppStore.getState();
        expect(state.enemyCompendium).toEqual([template]);
        expect(state.enemySuggestions).toEqual([
            expect.objectContaining({
                id: 'suggestion-id',
                kind: 'alias',
                name: 'Orcish Warrior',
                targetEnemyId: template.id,
            }),
        ]);
    });

    it('deduplicates suggestions and ignores names already known to the compendium', () => {
        const suggestion = { kind: 'new' as const, name: 'Orc Berserker' };
        useAppStore.getState().addEnemySuggestions([suggestion, suggestion]);
        useAppStore.getState().addEnemySuggestions([suggestion, { kind: 'new', name: 'Orc Warrior' }]);

        expect(useAppStore.getState().enemySuggestions).toHaveLength(1);
    });
});
