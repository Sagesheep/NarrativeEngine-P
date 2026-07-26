import { describe, expect, it } from 'vitest';
import type { EnemyEntry, EnemyInstance } from '../../../types';
import { buildActiveEncounterBlock, createEnemyEncounter } from '../enemyEncounter';
import { DEFAULT_ENEMY_COMBAT_CONFIG } from '../enemyCombat';

const template = (name: string): EnemyEntry => ({
    id: `${name}-template`, name, aliases: '', classification: 'Rapture',
    description: 'A ranged machine.', threatTier: 'Standard', tags: [],
    faction: '', stats: [{ name: 'HP', value: '45' }],
    actions: [{ name: 'Burst', description: 'Ordinary direct fire.' }],
    passiveTraits: [], specialBehaviors: [], weaknesses: [], resistances: [],
    tactics: '', loot: '', gmNotes: '', promptEnabled: true,
    createdAt: 1, updatedAt: 1,
});

const instance = (id: string, name: string): EnemyInstance => ({
    id,
    templateId: `${name}-template`,
    templateSnapshot: template(name),
    displayName: name,
    currentHp: 17,
    maxHp: 45,
    currentBarrier: 5,
    maxBarrier: 10,
    conditions: ['Jammed'],
    temporaryModifiers: [{ id: 'mod-1', name: 'Accuracy', value: '-5' }],
    defeated: false,
    initiative: null,
    actionsRemaining: 1,
    actionsPerTurn: 1,
    cooldowns: [],
    resources: [],
    createdAt: 1,
    updatedAt: 1,
});

describe('enemy encounters', () => {
    it('creates an active encounter with its first wave', () => {
        const encounter = createEnemyEncounter('Tutorial', 10, 'encounter-1', 'wave-1');

        expect(encounter).toMatchObject({
            id: 'encounter-1',
            name: 'Tutorial',
            status: 'active',
            activeWaveId: 'wave-1',
        });
        expect(encounter.waves).toHaveLength(1);
    });

    it('injects only explicitly active instances from the current wave', () => {
        const scout = instance('scout-1', 'Scout Gunner #1');
        const reserve = instance('reserve-1', 'Scout Gunner #2');
        const encounter = createEnemyEncounter('Tutorial', 10, 'encounter-1', 'wave-1');
        encounter.waves[0].instanceIds = [scout.id, reserve.id];
        encounter.waves[0].activeInstanceIds = [scout.id];

        const block = buildActiveEncounterBlock([encounter], [scout, reserve]);

        expect(block).toContain('ENCOUNTER: Tutorial');
        expect(block).toContain('INSTANCE: Scout Gunner #1');
        expect(block).toContain('STATE: HP 17/45; BARRIER 5/10; ACTIVE');
        expect(block).toContain('CONDITIONS: Jammed');
        expect(block).not.toContain('Scout Gunner #2');
    });

    it('does not inject paused or ended encounters', () => {
        const encounter = createEnemyEncounter('Paused', 10, 'encounter-1', 'wave-1');
        encounter.status = 'paused';

        expect(buildActiveEncounterBlock([encounter], [])).toBe('');
    });

    it('injects tracked combat state only when the optional integration is enabled', () => {
        const scout = {
            ...instance('scout-1', 'Scout Gunner #1'),
            initiative: 14,
            actionsRemaining: 0,
            actionsPerTurn: 2,
            cooldowns: [{ id: 'cooldown-1', name: 'Burst', remainingRounds: 2 }],
            resources: [{ id: 'resource-1', name: 'Ammo', current: 3, max: 5 }],
        };
        const encounter = createEnemyEncounter('Tutorial', 10, 'encounter-1', 'wave-1');
        encounter.waves[0].instanceIds = [scout.id];
        encounter.waves[0].activeInstanceIds = [scout.id];
        const enabled = {
            ...DEFAULT_ENEMY_COMBAT_CONFIG,
            enabled: true,
            actionsEnabled: true,
            cooldownsEnabled: true,
            resourcesEnabled: true,
        };

        const disabledBlock = buildActiveEncounterBlock([encounter], [scout], DEFAULT_ENEMY_COMBAT_CONFIG);
        const enabledBlock = buildActiveEncounterBlock([encounter], [scout], enabled);

        expect(disabledBlock).not.toContain('COMBAT:');
        expect(enabledBlock).toContain('COMBAT: INITIATIVE 14; ACTIONS 0/2');
        expect(enabledBlock).toContain('COOLDOWNS: Burst 2 round(s)');
        expect(enabledBlock).toContain('RESOURCES: Ammo 3/5');
        expect(enabledBlock).toContain('never silently mutate them');
    });

    it('ignores active IDs that no longer resolve to saved instances', () => {
        const encounter = createEnemyEncounter('Tutorial', 10, 'encounter-1', 'wave-1');
        encounter.waves[0].activeInstanceIds = ['missing'];

        expect(buildActiveEncounterBlock([encounter], [])).toContain('(No enemy instances are currently active in this wave.)');
    });
});
