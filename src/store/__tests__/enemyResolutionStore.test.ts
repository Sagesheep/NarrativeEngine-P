import { beforeEach, describe, expect, it } from 'vitest';
import type { EnemyEncounter, EnemyEntry, EnemyInstance } from '../../types';
import { useAppStore } from '../useAppStore';

const template: EnemyEntry = {
    id: 'template-1', name: 'Scout', aliases: '', classification: '',
    description: '', threatTier: '', tags: [], faction: '',
    stats: [{ name: 'XP', value: '20' }], actions: [], passiveTraits: [],
    specialBehaviors: [], weaknesses: [], resistances: [], tactics: '',
    loot: 'Scrap', gmNotes: '', promptEnabled: true, createdAt: 1, updatedAt: 1,
};

const instance: EnemyInstance = {
    id: 'instance-1', templateId: template.id, templateSnapshot: template,
    displayName: 'Scout #1', currentHp: 0, maxHp: 45,
    currentBarrier: 0, maxBarrier: 0, conditions: [], temporaryModifiers: [],
    defeated: true, initiative: 8, actionsRemaining: 0, actionsPerTurn: 1,
    cooldowns: [], resources: [], createdAt: 1, updatedAt: 1,
};

const encounter = (id: string, status: EnemyEncounter['status']): EnemyEncounter => ({
    id,
    name: id === 'encounter-1' ? 'Bridge Ambush' : 'Other Encounter',
    status,
    waves: [{
        id: `${id}-wave`,
        name: 'Wave 1',
        instanceIds: [instance.id],
        activeInstanceIds: [instance.id],
        createdAt: 1,
        updatedAt: 1,
    }],
    activeWaveId: `${id}-wave`,
    createdAt: 1,
    updatedAt: 1,
});

describe('campaign enemy resolution action', () => {
    beforeEach(() => {
        useAppStore.setState({
            activeCampaignId: null,
            enemyCompendium: [template],
            enemyInstances: [instance],
            enemyEncounters: [encounter('encounter-1', 'active'), encounter('encounter-2', 'paused')],
            enemyResolutions: [],
            timeline: [],
        });
    });

    it('ends the encounter, cleans every live roster, and preserves the template', async () => {
        const resolution = await useAppStore.getState().resolveEnemyEncounter('encounter-1', {
            outcome: 'victory',
            summary: 'The bridge was secured.',
            xpAwarded: 20,
            lootAwarded: ['Scrap'],
            otherRewards: [],
            instanceDisposition: 'archive',
            createTimelineEvent: false,
        });
        const state = useAppStore.getState();

        expect(resolution?.archivedInstances).toHaveLength(1);
        expect(state.enemyInstances).toEqual([]);
        expect(state.enemyEncounters[0]).toMatchObject({
            status: 'ended',
            resolutionId: resolution?.id,
        });
        expect(state.enemyEncounters.every(value =>
            value.waves.every(wave => !wave.instanceIds.includes(instance.id))
        )).toBe(true);
        expect(state.enemyResolutions).toHaveLength(1);
        expect(state.enemyCompendium).toEqual([template]);
    });
});
