import type {
    EnemyCombatConfig,
    EnemyCooldown,
    EnemyInstance,
    EnemyResource,
} from '../../types';
import { normalizeEnemyEntry } from './enemySchema';

export const DEFAULT_ENEMY_COMBAT_CONFIG: EnemyCombatConfig = {
    promptContextEnabled: true,
    enemyDiscoveryEnabled: true,
    enabled: false,
    initiativeMode: 'manual',
    initiativeModifierStat: '',
    barrierMode: 'absorb-first',
    autoDefeatAtZeroHp: true,
    weaknessMultiplier: 2,
    resistanceMultiplier: 0.5,
    actionsEnabled: false,
    defaultActionsPerTurn: 1,
    cooldownsEnabled: false,
    resourcesEnabled: false,
};

export type EnemyDamageResult = {
    rawDamage: number;
    adjustedDamage: number;
    barrierDamage: number;
    hpDamage: number;
    weaknessApplied: boolean;
    resistanceApplied: boolean;
    defeated: boolean;
};

/** Backfills safe defaults into Phase 2 records and hand-authored imports. */
export function normalizeEnemyInstance(instance: EnemyInstance): EnemyInstance {
    const rawActionsPerTurn = Number(instance.actionsPerTurn);
    const actionsPerTurn = Number.isFinite(rawActionsPerTurn) ? Math.max(0, rawActionsPerTurn) : 1;
    const templateSnapshot = normalizeEnemyEntry(instance.templateSnapshot, {
        now: Number.isFinite(instance.updatedAt) ? instance.updatedAt : Date.now(),
        createId: () => instance.templateId || crypto.randomUUID(),
    });
    return {
        ...instance,
        templateSnapshot: templateSnapshot ?? {
            id: instance.templateId || crypto.randomUUID(),
            name: typeof instance.displayName === 'string' && instance.displayName.trim()
                ? instance.displayName.trim()
                : 'Unknown Enemy',
            aliases: '',
            classification: '',
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
            createdAt: Number.isFinite(instance.createdAt) ? instance.createdAt : Date.now(),
            updatedAt: Number.isFinite(instance.updatedAt) ? instance.updatedAt : Date.now(),
        },
        conditions: Array.isArray(instance.conditions) ? instance.conditions.filter(value => typeof value === 'string') : [],
        temporaryModifiers: Array.isArray(instance.temporaryModifiers) ? instance.temporaryModifiers : [],
        initiative: Number.isFinite(instance.initiative) ? instance.initiative : null,
        actionsRemaining: Math.max(0, Number(instance.actionsRemaining) || 0),
        actionsPerTurn,
        cooldowns: Array.isArray(instance.cooldowns) ? instance.cooldowns : [],
        resources: Array.isArray(instance.resources) ? instance.resources : [],
    };
}

/** Merges persisted partial settings with bounded system-neutral defaults. */
export function normalizeEnemyCombatConfig(config?: Partial<EnemyCombatConfig> | null): EnemyCombatConfig {
    const bounded = (value: unknown, fallback: number) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback;
    };
    const initiativeMode = config?.initiativeMode === 'd20' || config?.initiativeMode === 'd100'
        ? config.initiativeMode
        : 'manual';
    const barrierMode = config?.barrierMode === 'manual' ? 'manual' : 'absorb-first';
    const boolean = <K extends keyof EnemyCombatConfig>(key: K) =>
        typeof config?.[key] === 'boolean'
            ? config[key] as boolean
            : DEFAULT_ENEMY_COMBAT_CONFIG[key] as boolean;
    return {
        ...DEFAULT_ENEMY_COMBAT_CONFIG,
        promptContextEnabled: boolean('promptContextEnabled'),
        enemyDiscoveryEnabled: boolean('enemyDiscoveryEnabled'),
        enabled: boolean('enabled'),
        initiativeMode,
        initiativeModifierStat: typeof config?.initiativeModifierStat === 'string' ? config.initiativeModifierStat : '',
        barrierMode,
        autoDefeatAtZeroHp: boolean('autoDefeatAtZeroHp'),
        weaknessMultiplier: bounded(config?.weaknessMultiplier, DEFAULT_ENEMY_COMBAT_CONFIG.weaknessMultiplier),
        resistanceMultiplier: bounded(config?.resistanceMultiplier, DEFAULT_ENEMY_COMBAT_CONFIG.resistanceMultiplier),
        actionsEnabled: boolean('actionsEnabled'),
        defaultActionsPerTurn: Math.floor(bounded(config?.defaultActionsPerTurn, DEFAULT_ENEMY_COMBAT_CONFIG.defaultActionsPerTurn)),
        cooldownsEnabled: boolean('cooldownsEnabled'),
        resourcesEnabled: boolean('resourcesEnabled'),
    };
}

/** Matches a damage type against a plain entry or an entry annotated after ':'/'('. */
function matchesDamageType(entries: string[], damageType: string): boolean {
    const canonical = (value: string) => value.trim().toLowerCase().split(/[:(]/, 1)[0].trim();
    const target = canonical(damageType);
    return Boolean(target) && entries.some(entry => canonical(entry) === target);
}

/** Applies configured weakness/resistance, barrier, HP, and defeat rules. */
export function applyEnemyDamage(
    instance: EnemyInstance,
    amount: number,
    damageType: string,
    config: EnemyCombatConfig,
    bypassBarrier = false,
): { instance: EnemyInstance; result: EnemyDamageResult } {
    const rawDamage = Math.max(0, Number(amount) || 0);
    if (!config.enabled) {
        return {
            instance,
            result: {
                rawDamage,
                adjustedDamage: 0,
                barrierDamage: 0,
                hpDamage: 0,
                weaknessApplied: false,
                resistanceApplied: false,
                defeated: instance.defeated,
            },
        };
    }

    const weaknessApplied = matchesDamageType(instance.templateSnapshot.weaknesses, damageType);
    const resistanceApplied = matchesDamageType(instance.templateSnapshot.resistances, damageType);
    const multiplier =
        (weaknessApplied ? config.weaknessMultiplier : 1)
        * (resistanceApplied ? config.resistanceMultiplier : 1);
    const adjustedDamage = Math.max(0, Math.round(rawDamage * multiplier));
    const barrierDamage = config.barrierMode === 'absorb-first' && !bypassBarrier
        ? Math.min(instance.currentBarrier, adjustedDamage)
        : 0;
    const hpDamage = Math.min(instance.currentHp, adjustedDamage - barrierDamage);
    const currentHp = Math.max(0, instance.currentHp - hpDamage);
    const next = {
        ...instance,
        currentBarrier: Math.max(0, instance.currentBarrier - barrierDamage),
        currentHp,
        defeated: config.autoDefeatAtZeroHp && currentHp === 0 ? true : instance.defeated,
        updatedAt: Date.now(),
    };
    return {
        instance: next,
        result: {
            rawDamage,
            adjustedDamage,
            barrierDamage,
            hpDamage,
            weaknessApplied,
            resistanceApplied,
            defeated: next.defeated,
        },
    };
}

/** Rolls configured initiative and adds an explicitly named numeric template stat. */
export function rollEnemyInitiative(
    instance: EnemyInstance,
    config: EnemyCombatConfig,
    random = Math.random,
): EnemyInstance {
    if (!config.enabled || config.initiativeMode === 'manual') return instance;
    const sides = config.initiativeMode === 'd100' ? 100 : 20;
    const roll = Math.floor(Math.min(0.999999, Math.max(0, random())) * sides) + 1;
    const modifierStat = config.initiativeModifierStat.trim().toLowerCase();
    const stat = modifierStat
        ? instance.templateSnapshot.stats.find(candidate => candidate.name.trim().toLowerCase() === modifierStat)
        : undefined;
    const modifier = Number(stat?.value.match(/[+-]?\d+(?:\.\d+)?/)?.[0] ?? 0);
    return { ...instance, initiative: roll + modifier, updatedAt: Date.now() };
}

/** Starts an enemy turn by refreshing actions and ticking enabled cooldowns. */
export function beginEnemyTurn(instance: EnemyInstance, config: EnemyCombatConfig): EnemyInstance {
    if (!config.enabled) return instance;
    const actionsPerTurn = config.actionsEnabled
        ? Math.max(0, config.defaultActionsPerTurn)
        : instance.actionsPerTurn;
    const cooldowns = config.cooldownsEnabled
        ? instance.cooldowns.map(cooldown => ({ ...cooldown, remainingRounds: Math.max(0, cooldown.remainingRounds - 1) }))
        : instance.cooldowns;
    return {
        ...instance,
        actionsPerTurn,
        actionsRemaining: config.actionsEnabled ? actionsPerTurn : instance.actionsRemaining,
        cooldowns,
        updatedAt: Date.now(),
    };
}

/** Spends one action and optionally starts or refreshes its named cooldown. */
export function spendEnemyAction(
    instance: EnemyInstance,
    actionName: string,
    cooldownRounds: number,
    config: EnemyCombatConfig,
    id = crypto.randomUUID(),
): EnemyInstance {
    if (!config.enabled || !config.actionsEnabled || instance.actionsRemaining <= 0) return instance;
    let cooldowns = instance.cooldowns;
    const name = actionName.trim();
    const rounds = Math.max(0, Math.floor(Number(cooldownRounds) || 0));
    if (config.cooldownsEnabled && name && rounds > 0) {
        const existing = cooldowns.find(cooldown => cooldown.name.toLowerCase() === name.toLowerCase());
        cooldowns = existing
            ? cooldowns.map(cooldown => cooldown.id === existing.id ? { ...cooldown, remainingRounds: rounds } : cooldown)
            : [...cooldowns, { id, name, remainingRounds: rounds } satisfies EnemyCooldown];
    }
    return {
        ...instance,
        actionsRemaining: instance.actionsRemaining - 1,
        cooldowns,
        updatedAt: Date.now(),
    };
}

/** Adds a named bounded resource tracker to an instance. */
export function addEnemyResource(
    instance: EnemyInstance,
    name: string,
    max: number,
    id = crypto.randomUUID(),
): EnemyInstance {
    const boundedMax = Math.max(0, Number(max) || 0);
    const resource: EnemyResource = { id, name: name.trim() || 'Resource', current: boundedMax, max: boundedMax };
    return { ...instance, resources: [...instance.resources, resource], updatedAt: Date.now() };
}

/** Adjusts a resource without allowing it below zero or above its maximum. */
export function adjustEnemyResource(instance: EnemyInstance, resourceId: string, delta: number): EnemyInstance {
    return {
        ...instance,
        resources: instance.resources.map(resource =>
            resource.id === resourceId
                ? { ...resource, current: Math.min(resource.max, Math.max(0, resource.current + delta)) }
                : resource
        ),
        updatedAt: Date.now(),
    };
}
