import { describe, expect, it } from 'vitest';
import type { EnemyEntry, EnemyInstance } from '../../../types';
import {
    DEFAULT_ENEMY_COMBAT_CONFIG,
    addEnemyResource,
    adjustEnemyResource,
    applyEnemyDamage,
    beginEnemyTurn,
    normalizeEnemyCombatConfig,
    normalizeEnemyInstance,
    rollEnemyInitiative,
    spendEnemyAction,
} from '../enemyCombat';

const template = (): EnemyEntry => ({
    id: 'target-template', name: 'Target', aliases: '', classification: '',
    description: '', threatTier: '', tags: [], faction: '',
    stats: [{ name: 'Initiative', value: '+3' }], actions: [],
    passiveTraits: [], specialBehaviors: [], weaknesses: ['Fire: exposed core'],
    resistances: ['Ice (armoured)'], tactics: '', loot: '', gmNotes: '',
    promptEnabled: true, createdAt: 1, updatedAt: 1,
});

const instance = (): EnemyInstance => ({
    id: 'target-1',
    templateId: 'target-template',
    templateSnapshot: template(),
    displayName: 'Target #1',
    currentHp: 50,
    maxHp: 50,
    currentBarrier: 20,
    maxBarrier: 20,
    conditions: [],
    temporaryModifiers: [],
    defeated: false,
    initiative: null,
    actionsRemaining: 0,
    actionsPerTurn: 1,
    cooldowns: [{ id: 'cooldown-1', name: 'Burst', remainingRounds: 2 }],
    resources: [],
    createdAt: 1,
    updatedAt: 1,
});

const enabledConfig = () => ({ ...DEFAULT_ENEMY_COMBAT_CONFIG, enabled: true });

describe('enemy combat integration', () => {
    it('does nothing while integration is disabled', () => {
        const target = instance();
        const resolved = applyEnemyDamage(target, 10, 'Fire', DEFAULT_ENEMY_COMBAT_CONFIG);

        expect(resolved.instance).toBe(target);
        expect(resolved.result.adjustedDamage).toBe(0);
    });

    it('applies weakness damage to barrier before HP', () => {
        const resolved = applyEnemyDamage(instance(), 15, 'Fire', enabledConfig());

        expect(resolved.result).toMatchObject({
            adjustedDamage: 30,
            barrierDamage: 20,
            hpDamage: 10,
            weaknessApplied: true,
            resistanceApplied: false,
        });
        expect(resolved.instance.currentBarrier).toBe(0);
        expect(resolved.instance.currentHp).toBe(40);
    });

    it('applies resistance and can bypass barriers', () => {
        const resolved = applyEnemyDamage(instance(), 20, 'Ice', enabledConfig(), true);

        expect(resolved.result.adjustedDamage).toBe(10);
        expect(resolved.result.barrierDamage).toBe(0);
        expect(resolved.instance.currentBarrier).toBe(20);
        expect(resolved.instance.currentHp).toBe(40);
    });

    it('marks zero-HP targets defeated when configured', () => {
        const target = { ...instance(), currentBarrier: 0, currentHp: 5 };
        const resolved = applyEnemyDamage(target, 10, '', enabledConfig());

        expect(resolved.instance.currentHp).toBe(0);
        expect(resolved.instance.defeated).toBe(true);
    });

    it('rolls initiative with an explicitly configured stat modifier', () => {
        const config = { ...enabledConfig(), initiativeMode: 'd20' as const, initiativeModifierStat: 'Initiative' };
        const rolled = rollEnemyInitiative(instance(), config, () => 0.5);

        expect(rolled.initiative).toBe(14);
    });

    it('refreshes actions, ticks cooldowns, and spends an action', () => {
        const config = {
            ...enabledConfig(),
            actionsEnabled: true,
            cooldownsEnabled: true,
            defaultActionsPerTurn: 2,
        };
        const begun = beginEnemyTurn(instance(), config);
        const spent = spendEnemyAction(begun, 'Laser', 3, config, 'cooldown-2');

        expect(begun.actionsRemaining).toBe(2);
        expect(begun.cooldowns[0].remainingRounds).toBe(1);
        expect(spent.actionsRemaining).toBe(1);
        expect(spent.cooldowns).toContainEqual({
            id: 'cooldown-2',
            name: 'Laser',
            remainingRounds: 3,
        });
    });

    it('adds and bounds named resources', () => {
        const added = addEnemyResource(instance(), 'Ammo', 3, 'resource-1');
        const spent = adjustEnemyResource(added, 'resource-1', -5);
        const restored = adjustEnemyResource(spent, 'resource-1', 10);

        expect(spent.resources[0].current).toBe(0);
        expect(restored.resources[0].current).toBe(3);
    });

    it('normalizes legacy records and partial configuration', () => {
        const legacy = {
            ...instance(),
            initiative: undefined,
            actionsRemaining: undefined,
            actionsPerTurn: undefined,
            cooldowns: undefined,
            resources: undefined,
        } as unknown as EnemyInstance;

        expect(normalizeEnemyInstance(legacy)).toMatchObject({
            initiative: null,
            actionsRemaining: 0,
            actionsPerTurn: 1,
            cooldowns: [],
            resources: [],
        });
        expect(normalizeEnemyCombatConfig({ enabled: true, weaknessMultiplier: 0 })).toMatchObject({
            promptContextEnabled: true,
            enemyDiscoveryEnabled: true,
            enabled: true,
            weaknessMultiplier: 0,
            initiativeMode: 'manual',
        });
        expect(normalizeEnemyCombatConfig({
            promptContextEnabled: false,
            enemyDiscoveryEnabled: false,
        })).toMatchObject({
            promptContextEnabled: false,
            enemyDiscoveryEnabled: false,
        });
    });
});
