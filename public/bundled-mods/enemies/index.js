// Phase 8.2 — the enemy mod's data logic.
//
// This file is the mod's native entry point. It owns the in-memory state for
// the five mod tables (compendium, instances, encounters, resolutions, config)
// and the logic that the host's `campaignSlice.ts` used to run as 32 store
// actions (ENEMY_SEAM §3.1). The actions are reclassified here as:
//
//   - **mod-table write** (5 actions: setEnemyCompendium, setEnemyInstances,
//     setEnemyEncounters, setEnemyCombatConfig, and the resolutions append
//     inside resolveEnemyEncounter) — these become `ctx.table.write` to the
//     mod's own table.
//   - **mod-internal** (27 actions) — the mod keeps the in-memory state and
//     writes the whole array to its table when it mutates. The host's
//     debounced-save pattern (1s timers) is NOT reproduced: the mod writes
//     its own table from its own state, so the shared-snapshot race the
//     back-channel timer cancellation (E14) existed to fix does not exist
//     (§2 ruling). The mod writes immediately on mutation.
//
// What this file does NOT do:
//
//   - **The timeline write.** `resolveEnemyEncounter` in `campaignSlice.ts`
//     writes a timeline event via `persistTimelineEvent` (L1032) and
//     `buildEnemyResolutionTimelineEvent` (L1034). The timeline is a
//     host-owned ledger, not a mod table. §7 flag #11 rules: the mod calls
//     `ctx.write.addTimelineEvent` (shipped by 2.9.3), and the sceneId /
//     chapterId envelope is computed from `ctx.data.archiveIndex` and
//     `ctx.data.chapters` exactly as core does today. **That write is 8.3's**,
//     not 8.2's — see the work order §6 "One split to get right": the data
//     writes (instances, encounters, resolutions) are 8.2's; the timeline
//     write is 8.3's. This file's `resolveEncounter` writes the three data
//     tables and returns the resolution; the timeline event is left to 8.3's
//     generation interceptor, which fires once per turn and whose output is
//     reused verbatim by any swipe or continuation (ENEMY_SEAM §8 flag #1).
//
//   - **The pre-op backup via `preOpBackup`.** §3 rules: the mod calls
//     `ctx.write.requestBackup(trigger)` (added by this phase), which fires
//     the same POST `/campaigns/:id/backup` with the same `isAuto: true`
//     flag. The host keeps the endpoint and any rate limiting. If the
//     reviewer vetoes the primitive, the fallback is the mod writing its own
//     `<table>.backup` copy — worse (one table vs the whole campaign, and
//     it doubles the mod's table count). The veto must be recorded, not
//     silently fallen back to.
//
//   - **enemySuggestions.** §4 rules: suggestions live in the mod's
//     module-local runtime state (the pattern `enemySuggestionTrack.ts:12`'s
//     `enemyDiscoveryState` already uses). Zero behaviour change — the
//     review queue does not survive reload, which is the current behaviour.
//     8.5 may decide to persist them as a feature, deliberately, with the
//     user told; it is not this phase's call to make as a side effect of
//     moving files.
//
// The 32 actions are not all exposed on the mod's activate surface today —
// 8.4 moves the UI that calls them. This file registers the data layer and
// the logic; the UI mount points (the compendium modal, the combat view, the
// encounters view, the resolution dialog, the suggestions panel) are 8.4's
// to wire to this logic. The mod's `onActivate` registers a single
// `enemyData` API object on `ctx.mounts` is NOT done here — 8.4 owns the
// mount surface. For 8.2, the mod's activate hook just initializes the
// in-memory state and returns; the logic is exercised by the differential
// test and by 8.4's UI when it lands.

import {
    validateEnemyCompendium,
    validateEnemyInstances,
    validateEnemyEncounters,
    validateEnemyResolutions,
    validateEnemyCombatConfig,
    repairCompendium,
    repairInstances,
    repairEncounters,
    repairResolutions,
    repairConfig,
    DEFAULT_ENEMY_COMBAT_CONFIG,
} from './validator.js';
import { mountEnemyCompendium, repaintEnemyWindows } from './ui.js';

// ── Constants (duplicated from src/services/enemy/* — locked by the
//    WO-01 contract: a mod never imports from src/, so the logic that lived
//    in src/services/enemy/* is duplicated here. 8.5 consolidates when the
//    files move; for 8.2 the mod needs its own copy because the mod's data
//    logic runs in the browser via import(), not in src/.) ──

// From src/services/enemy/enemyEncounter.ts:5-18 (createEnemyEncounterWave,
// createEnemyEncounter). The `crypto.randomUUID()` calls use the browser
// global (Web Crypto API), same as validator.js.
function createEnemyEncounterWave(number, now = Date.now(), id = crypto.randomUUID()) {
    return {
        id,
        name: `Wave ${number}`,
        instanceIds: [],
        activeInstanceIds: [],
        createdAt: now,
        updatedAt: now,
    };
}

function createEnemyEncounter(name, now = Date.now(), id = crypto.randomUUID(), waveId = crypto.randomUUID()) {
    const wave = createEnemyEncounterWave(1, now, waveId);
    return {
        id,
        name: name.trim() || 'Untitled Encounter',
        status: 'active',
        waves: [wave],
        activeWaveId: wave.id,
        createdAt: now,
        updatedAt: now,
    };
}

// From src/services/enemy/enemyInstance.ts:4-20 (numericStat, nextCopyNumber).
function numericStat(template, names) {
    const stat = template.stats.find(candidate =>
        names.some(name => candidate.name.trim().toLowerCase() === name)
    );
    const match = stat?.value.match(/-?\d+(?:\.\d+)?/);
    return match ? Math.max(0, Number(match[0])) : 0;
}

function nextCopyNumber(template, instances) {
    const prefix = `${template.name} #`;
    return instances.reduce((highest, instance) => {
        if (instance.templateId !== template.id || !instance.displayName.startsWith(prefix)) return highest;
        const suffix = Number(instance.displayName.slice(prefix.length));
        return Number.isFinite(suffix) ? Math.max(highest, suffix) : highest;
    }, 0) + 1;
}

// From src/services/enemy/enemyInstance.ts:26-54 (createEnemyInstance).
function createEnemyInstance(template, existing, now = Date.now(), id = crypto.randomUUID()) {
    const maxHp = numericStat(template, ['hp', 'hit points', 'health']);
    const maxBarrier = numericStat(template, ['barrier', 'barrier hp']);
    return {
        id,
        templateId: template.id,
        templateSnapshot: structuredClone(template),
        displayName: `${template.name} #${nextCopyNumber(template, existing)}`,
        currentHp: maxHp,
        maxHp,
        currentBarrier: maxBarrier,
        maxBarrier,
        conditions: [],
        temporaryModifiers: [],
        defeated: false,
        initiative: null,
        actionsRemaining: 1,
        actionsPerTurn: 1,
        cooldowns: [],
        resources: [],
        createdAt: now,
        updatedAt: now,
    };
}

// From src/services/enemy/enemyResolution.ts:22-28 (getEncounterInstances).
function getEncounterInstances(encounter, instances) {
    const assignedIds = new Set(encounter.waves.flatMap(wave => wave.instanceIds));
    return instances.filter(instance => assignedIds.has(instance.id));
}

// From src/services/enemy/enemyResolution.ts:82-106 (createEnemyEncounterResolution).
function createEnemyEncounterResolution(encounter, instances, draft, now = Date.now(), id = crypto.randomUUID()) {
    const participants = getEncounterInstances(encounter, instances);
    return {
        id,
        encounterId: encounter.id,
        encounterName: encounter.name,
        outcome: draft.outcome,
        summary: draft.summary.trim() || `${encounter.name} ended.`,
        xpAwarded: Math.max(0, Number(draft.xpAwarded) || 0),
        lootAwarded: draft.lootAwarded.map(value => value.trim()).filter(Boolean),
        otherRewards: draft.otherRewards.map(value => value.trim()).filter(Boolean),
        participantNames: participants.map(instance => instance.displayName),
        instanceDisposition: draft.instanceDisposition,
        archivedInstances: draft.instanceDisposition === 'archive'
            ? structuredClone(participants)
            : [],
        resolvedAt: now,
    };
}

// From src/services/enemy/enemyCombat.ts:112-172 (matchesDamageType, applyEnemyDamage).
function matchesDamageType(entries, damageType) {
    const canonical = value => value.trim().toLowerCase().split(/[:(]/, 1)[0].trim();
    const target = canonical(damageType);
    return Boolean(target) && entries.some(entry => canonical(entry) === target);
}

function applyEnemyDamage(instance, amount, damageType, config, bypassBarrier = false) {
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

// From src/services/enemy/enemyCombat.ts:175-189 (rollEnemyInitiative).
function rollEnemyInitiative(instance, config, random = Math.random) {
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

// From src/services/enemy/enemyCombat.ts:192-207 (beginEnemyTurn).
function beginEnemyTurn(instance, config) {
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

// From src/services/enemy/enemyCombat.ts:210-233 (spendEnemyAction).
function spendEnemyAction(instance, actionName, cooldownRounds, config, id = crypto.randomUUID()) {
    if (!config.enabled || !config.actionsEnabled || instance.actionsRemaining <= 0) return instance;
    let cooldowns = instance.cooldowns;
    const name = actionName.trim();
    const rounds = Math.max(0, Math.floor(Number(cooldownRounds) || 0));
    if (config.cooldownsEnabled && name && rounds > 0) {
        const existing = cooldowns.find(cooldown => cooldown.name.toLowerCase() === name.toLowerCase());
        cooldowns = existing
            ? cooldowns.map(cooldown => cooldown.id === existing.id ? { ...cooldown, remainingRounds: rounds } : cooldown)
            : [...cooldowns, { id, name, remainingRounds: rounds }];
    }
    return {
        ...instance,
        actionsRemaining: instance.actionsRemaining - 1,
        cooldowns,
        updatedAt: Date.now(),
    };
}

// From src/services/enemy/enemyCombat.ts:236-245 (addEnemyResource).
function addEnemyResource(instance, name, max, id = crypto.randomUUID()) {
    const boundedMax = Math.max(0, Number(max) || 0);
    const resource = { id, name: name.trim() || 'Resource', current: boundedMax, max: boundedMax };
    return { ...instance, resources: [...instance.resources, resource], updatedAt: Date.now() };
}

// From src/services/enemy/enemyCombat.ts:248-258 (adjustEnemyResource).
function adjustEnemyResource(instance, resourceId, delta) {
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

// From src/services/enemy/enemyCombat.ts:80-109 (normalizeEnemyCombatConfig).
function normalizeEnemyCombatConfig(config) {
    const bounded = (value, fallback) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? Math.max(0, numeric) : fallback;
    };
    const initiativeMode = config?.initiativeMode === 'd20' || config?.initiativeMode === 'd100'
        ? config.initiativeMode
        : 'manual';
    const barrierMode = config?.barrierMode === 'manual' ? 'manual' : 'absorb-first';
    const boolean = key =>
        typeof config?.[key] === 'boolean'
            ? config[key]
            : DEFAULT_ENEMY_COMBAT_CONFIG[key];
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

// ── The mod's in-memory state ──
//
// The mod keeps the five tables' state in memory and writes the whole array
// to its table on mutation. This is the same pattern the host's
// `campaignSlice.ts` used: the store held the state, and the debounced save
// wrote it to disk. The mod's `ctx.table.write` is the equivalent of the
// debounced save, except immediate (no 1s timer) because the mod writes its
// own table from its own state — there is no shared-snapshot race to debounce
// against (§2 ruling).
//
// `enemySuggestions` is deliberately NOT here. §4 rules: suggestions live in
// the mod's module-local runtime state, the pattern
// `enemySuggestionTrack.ts:12`'s `enemyDiscoveryState` already uses. The
// suggestion track itself is 8.3's deletion target; the mod's suggestion
// state will be wired by 8.3/8.4 when the track and the panel move. For 8.2
// the mod owns the five persisted tables only.

const enemySuggestions = [];

const state = {
    compendium: [],
    instances: [],
    encounters: [],
    resolutions: [],
    config: { ...DEFAULT_ENEMY_COMBAT_CONFIG },
};

// The mod's write helper. Wraps `ctx.table.write` with the validator's
// on-write repair (D2 — the mod carries the coercion, the defaults and the
// shape repair in its own native code and runs it on write and on read).
async function writeTable(ctx, name, value, repairFn) {
    const repaired = repairFn(value);
    await ctx.table.write(name, repaired);
    return repaired;
}

// The mod's read helper. Wraps `ctx.table.read` with the validator's on-read
// repair (D2 item 1 — the server will accept and store a corrupt enemy table
// handed to it from outside the app; the mod repairs on read, so observable
// behaviour is unchanged).
async function readTable(ctx, name, repairFn) {
    const raw = await ctx.table.read(name);
    return repairFn(raw);
}

// Phase 8.5 — "no active campaign" is not a fault, it is the state the mod
// spends its first moments in: it activates before any campaign is open, and
// `hydrate` is a best-effort read that the standing subscriptions
// (`enemyData.watch`) make unnecessary. Logging it three times per load taught
// anyone reading the console to ignore the mod's messages, which is how a real
// failure goes unnoticed. Everything else is still reported.
function logHydrateFailure(ctx, error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('no active campaign')) return;
    ctx.log?.('[enemies] hydrate failed:', error);
}

// ── The 32 store actions, reclassified ──
//
// Each function takes a `ctx` (the ModContext) plus the action's arguments,
// mutates the in-memory state, writes the affected table(s), and returns
// what the host action returned. The host's debounced-save calls are gone
// (the mod writes immediately); the host's `preOpBackup` calls become
// `ctx.write.requestBackup` (§3); the host's back-channel timer cancellation
// (E14) is gone (§2 ruling — the mod writes its own tables from its own
// state, so the shared-snapshot race does not exist).
//
// The actions are grouped by table, in the order ENEMY_SEAM §3.1 lists them.

export const enemyData = {
    // ── Compendium (table 1) ──

    async setEnemyCompendium(ctx, enemies) {
        state.compendium = await writeTable(ctx, 'compendium', enemies, repairCompendium);
        return state.compendium;
    },

    async addEnemy(ctx, enemy) {
        const enemies = [...state.compendium, enemy];
        return enemyData.setEnemyCompendium(ctx, enemies);
    },

    async updateEnemy(ctx, id, patch) {
        const enemies = state.compendium.map(e => e.id === id ? { ...e, ...patch, updatedAt: Date.now() } : e);
        return enemyData.setEnemyCompendium(ctx, enemies);
    },

    async removeEnemy(ctx, id) {
        // §3 — the mod calls ctx.write.requestBackup before the destructive op.
        // The host keeps the endpoint, the isAuto flag, and any rate limiting.
        ctx.write.requestBackup('pre-delete-enemy');
        const enemies = state.compendium.filter(e => e.id !== id);
        return enemyData.setEnemyCompendium(ctx, enemies);
    },

    // ── Instances (table 2) ──

    async setEnemyInstances(ctx, instances) {
        state.instances = await writeTable(ctx, 'instances', instances, repairInstances);
        return state.instances;
    },

    async spawnEnemyInstance(ctx, templateId) {
        const template = state.compendium.find(enemy => enemy.id === templateId);
        if (!template) return null;
        const instance = createEnemyInstance(template, state.instances);
        const instances = [...state.instances, instance];
        state.instances = await writeTable(ctx, 'instances', instances, repairInstances);
        return instance;
    },

    async updateEnemyInstance(ctx, id, patch) {
        const instances = state.instances.map(instance =>
            instance.id === id ? { ...instance, ...patch, updatedAt: Date.now() } : instance
        );
        return enemyData.setEnemyInstances(ctx, instances);
    },

    async removeEnemyInstance(ctx, id) {
        // §2 ruling — the mod maintains the referential invariant in its own
        // in-memory state and issues two ctx.table.write calls. No multi-table
        // primitive is added. The current implementation's referential
        // integrity is an in-memory invariant, never a disk transaction; the
        // transactional guarantee a multi-table primitive would buy is a
        // guarantee the app has never had.
        const instances = state.instances.filter(instance => instance.id !== id);
        const now = Date.now();
        const encounters = state.encounters.map(encounter => ({
            ...encounter,
            waves: encounter.waves.map(wave => ({
                ...wave,
                instanceIds: wave.instanceIds.filter(instanceId => instanceId !== id),
                activeInstanceIds: wave.activeInstanceIds.filter(instanceId => instanceId !== id),
                updatedAt: now,
            })),
            updatedAt: now,
        }));
        state.instances = await writeTable(ctx, 'instances', instances, repairInstances);
        state.encounters = await writeTable(ctx, 'encounters', encounters, repairEncounters);
        return { instances: state.instances, encounters: state.encounters };
    },

    async applyEnemyDamage(ctx, id, amount, damageType, bypassBarrier = false) {
        const target = state.instances.find(instance => instance.id === id);
        if (!target) return null;
        const resolved = applyEnemyDamage(target, amount, damageType, state.config, bypassBarrier);
        if (resolved.instance !== target) {
            const instances = state.instances.map(instance =>
                instance.id === id ? resolved.instance : instance
            );
            await enemyData.setEnemyInstances(ctx, instances);
        }
        return resolved.result;
    },

    async rollEnemyInitiatives(ctx, instanceIds) {
        const targets = new Set(instanceIds);
        const instances = state.instances.map(instance =>
            targets.has(instance.id)
                ? rollEnemyInitiative(instance, state.config)
                : instance
        );
        return enemyData.setEnemyInstances(ctx, instances);
    },

    async setEnemyInitiative(ctx, id, initiative) {
        if (!state.config.enabled) return;
        const instances = state.instances.map(instance =>
            instance.id === id
                ? { ...instance, initiative: Number.isFinite(initiative) ? initiative : null, updatedAt: Date.now() }
                : instance
        );
        return enemyData.setEnemyInstances(ctx, instances);
    },

    async beginEnemyTurn(ctx, id) {
        const instances = state.instances.map(instance =>
            instance.id === id ? beginEnemyTurn(instance, state.config) : instance
        );
        return enemyData.setEnemyInstances(ctx, instances);
    },

    async spendEnemyAction(ctx, id, actionName, cooldownRounds = 0) {
        const instances = state.instances.map(instance =>
            instance.id === id
                ? spendEnemyAction(instance, actionName, cooldownRounds, state.config)
                : instance
        );
        return enemyData.setEnemyInstances(ctx, instances);
    },

    async addEnemyResource(ctx, id, name, max) {
        if (!state.config.enabled || !state.config.resourcesEnabled) return;
        const instances = state.instances.map(instance =>
            instance.id === id ? addEnemyResource(instance, name, max) : instance
        );
        return enemyData.setEnemyInstances(ctx, instances);
    },

    async adjustEnemyResource(ctx, id, resourceId, delta) {
        if (!state.config.enabled || !state.config.resourcesEnabled) return;
        const instances = state.instances.map(instance =>
            instance.id === id ? adjustEnemyResource(instance, resourceId, delta) : instance
        );
        return enemyData.setEnemyInstances(ctx, instances);
    },

    async removeEnemyResource(ctx, id, resourceId) {
        if (!state.config.enabled || !state.config.resourcesEnabled) return;
        const instances = state.instances.map(instance =>
            instance.id === id
                ? {
                    ...instance,
                    resources: instance.resources.filter(resource => resource.id !== resourceId),
                    updatedAt: Date.now(),
                }
                : instance
        );
        return enemyData.setEnemyInstances(ctx, instances);
    },

    async clearEnemyCooldown(ctx, id, cooldownId) {
        if (!state.config.enabled || !state.config.cooldownsEnabled) return;
        const instances = state.instances.map(instance =>
            instance.id === id
                ? {
                    ...instance,
                    cooldowns: instance.cooldowns.filter(cooldown => cooldown.id !== cooldownId),
                    updatedAt: Date.now(),
                }
                : instance
        );
        return enemyData.setEnemyInstances(ctx, instances);
    },

    // ── Encounters (table 3) ──

    async setEnemyEncounters(ctx, encounters) {
        state.encounters = await writeTable(ctx, 'encounters', encounters, repairEncounters);
        return state.encounters;
    },

    async createEnemyEncounter(ctx, name) {
        const now = Date.now();
        const encounter = createEnemyEncounter(name, now);
        // Auto-pause other active encounters (campaignSlice.ts:846-850).
        const encounters = [
            ...state.encounters.map(existing =>
                existing.status === 'active'
                    ? { ...existing, status: 'paused', updatedAt: now }
                    : existing
            ),
            encounter,
        ];
        state.encounters = await writeTable(ctx, 'encounters', encounters, repairEncounters);
        return encounter;
    },

    async updateEnemyEncounter(ctx, id, patch) {
        const encounters = state.encounters.map(encounter =>
            encounter.id === id ? { ...encounter, ...patch, updatedAt: Date.now() } : encounter
        );
        return enemyData.setEnemyEncounters(ctx, encounters);
    },

    async addEnemyEncounterWave(ctx, encounterId) {
        const encounter = state.encounters.find(candidate => candidate.id === encounterId);
        if (!encounter) return null;
        const now = Date.now();
        const wave = createEnemyEncounterWave(encounter.waves.length + 1, now);
        const encounters = state.encounters.map(candidate =>
            candidate.id === encounterId
                ? { ...candidate, waves: [...candidate.waves, wave], activeWaveId: wave.id, updatedAt: now }
                : candidate
        );
        state.encounters = await writeTable(ctx, 'encounters', encounters, repairEncounters);
        return wave;
    },

    async updateEnemyEncounterWave(ctx, encounterId, waveId, patch) {
        const now = Date.now();
        const encounters = state.encounters.map(encounter =>
            encounter.id === encounterId
                ? {
                    ...encounter,
                    waves: encounter.waves.map(wave =>
                        wave.id === waveId ? { ...wave, ...patch, updatedAt: now } : wave
                    ),
                    updatedAt: now,
                }
                : encounter
        );
        return enemyData.setEnemyEncounters(ctx, encounters);
    },

    async setEnemyEncounterStatus(ctx, id, status) {
        const target = state.encounters.find(encounter => encounter.id === id);
        if (!target || (target.resolutionId && status !== 'ended')) return;
        const now = Date.now();
        const encounters = state.encounters.map(encounter => {
            if (status === 'active' && encounter.id !== id && encounter.status === 'active') {
                return { ...encounter, status: 'paused', updatedAt: now };
            }
            if (encounter.id !== id) return encounter;
            return {
                ...encounter,
                status,
                updatedAt: now,
                endedAt: status === 'ended' ? now : undefined,
            };
        });
        state.encounters = await writeTable(ctx, 'encounters', encounters, repairEncounters);
        return state.encounters;
    },

    async setEnemyEncounterInstanceAssigned(ctx, encounterId, waveId, instanceId, assigned) {
        const encounter = state.encounters.find(candidate => candidate.id === encounterId);
        const wave = encounter?.waves.find(candidate => candidate.id === waveId);
        if (!encounter || !wave) return;
        const instanceIds = assigned
            ? [...new Set([...wave.instanceIds, instanceId])]
            : wave.instanceIds.filter(id => id !== instanceId);
        const activeInstanceIds = assigned
            ? wave.activeInstanceIds
            : wave.activeInstanceIds.filter(id => id !== instanceId);
        return enemyData.updateEnemyEncounterWave(ctx, encounterId, waveId, { instanceIds, activeInstanceIds });
    },

    async setEnemyEncounterInstanceActive(ctx, encounterId, waveId, instanceId, active) {
        const encounter = state.encounters.find(candidate => candidate.id === encounterId);
        const wave = encounter?.waves.find(candidate => candidate.id === waveId);
        if (!encounter || !wave || !wave.instanceIds.includes(instanceId)) return;
        const activeInstanceIds = active
            ? [...new Set([...wave.activeInstanceIds, instanceId])]
            : wave.activeInstanceIds.filter(id => id !== instanceId);
        return enemyData.updateEnemyEncounterWave(ctx, encounterId, waveId, { activeInstanceIds });
    },

    async addEnemyReinforcement(ctx, encounterId, waveId, templateId) {
        const template = state.compendium.find(enemy => enemy.id === templateId);
        const encounter = state.encounters.find(candidate => candidate.id === encounterId);
        const wave = encounter?.waves.find(candidate => candidate.id === waveId);
        if (!template || !encounter || !wave) return null;
        const instance = createEnemyInstance(template, state.instances);
        const instances = [...state.instances, instance];
        const now = Date.now();
        const encounters = state.encounters.map(candidate =>
            candidate.id === encounterId
                ? {
                    ...candidate,
                    waves: candidate.waves.map(candidateWave =>
                        candidateWave.id === waveId
                            ? {
                                ...candidateWave,
                                instanceIds: [...new Set([...candidateWave.instanceIds, instance.id])],
                                activeInstanceIds: [...new Set([...candidateWave.activeInstanceIds, instance.id])],
                                updatedAt: now,
                            }
                            : candidateWave
                    ),
                    updatedAt: now,
                }
                : candidate
        );
        state.instances = await writeTable(ctx, 'instances', instances, repairInstances);
        state.encounters = await writeTable(ctx, 'encounters', encounters, repairEncounters);
        return instance;
    },

    // ── Resolutions (table 4) ──
    //
    // resolveEnemyEncounter is the one with the §6 split: the data writes
    // (instances, encounters, resolutions) are 8.2's; the timeline write is
    // 8.3's. This function writes the three data tables and returns the
    // resolution; the timeline event is left to 8.3's generation interceptor.
    //
    // The back-channel timer cancellation (E14) is NOT ported (§2 ruling):
    // the mod writes its own tables from its own state, so the shared-
    // snapshot race the back channel existed to fix does not exist. Porting
    // it would be cargo-culting a fix for a race the new design cannot have.

    async resolveEnemyEncounter(ctx, encounterId, draft) {
        const encounter = state.encounters.find(candidate => candidate.id === encounterId);
        if (!encounter || encounter.resolutionId) return null;

        // §3 — the mod calls ctx.write.requestBackup before the destructive op.
        ctx.write.requestBackup('pre-resolve-enemy-encounter');

        const now = Date.now();
        const resolution = createEnemyEncounterResolution(encounter, state.instances, draft, now);
        const resolvedInstanceIds = new Set(
            getEncounterInstances(encounter, state.instances).map(instance => instance.id),
        );
        const instances = state.instances.filter(instance => !resolvedInstanceIds.has(instance.id));
        const encounters = state.encounters.map(candidate => {
            let changed = candidate.id === encounterId;
            const waves = candidate.waves.map(wave => {
                const waveChanged = wave.instanceIds.some(id => resolvedInstanceIds.has(id))
                    || wave.activeInstanceIds.some(id => resolvedInstanceIds.has(id));
                if (!waveChanged) return wave;
                changed = true;
                return {
                    ...wave,
                    instanceIds: wave.instanceIds.filter(id => !resolvedInstanceIds.has(id)),
                    activeInstanceIds: wave.activeInstanceIds.filter(id => !resolvedInstanceIds.has(id)),
                    updatedAt: now,
                };
            });
            if (!changed) return candidate;
            return {
                ...candidate,
                waves,
                ...(candidate.id === encounterId
                    ? { status: 'ended', endedAt: now, resolutionId: resolution.id }
                    : {}),
                updatedAt: now,
            };
        });
        const resolutions = [...state.resolutions, resolution];

        // The three data writes. The host's Promise.all is reproduced because
        // the writes are independent and can be parallelised; the host's
        // second saveEnemyResolutions (L1058, after timeline linking) is
        // gone because the timeline link is 8.3's, not 8.2's.
        state.instances = await writeTable(ctx, 'instances', instances, repairInstances);
        state.encounters = await writeTable(ctx, 'encounters', encounters, repairEncounters);
        state.resolutions = await writeTable(ctx, 'resolutions', resolutions, repairResolutions);
        return resolution;
    },

    // ── Combat config (table 5) ──

    async setEnemyCombatConfig(ctx, patch) {
        const config = normalizeEnemyCombatConfig({ ...state.config, ...patch });
        state.config = await writeTable(ctx, 'config', config, repairConfig);
        return state.config;
    },

    // ── Hydration: load all five tables from disk on activate ──
    //
    // The mod's onActivate reads its five tables through ctx.table.read and
    // repairs them on read (D2). The host's hydrator did this via 5 GETs +
    // 5 normalizations; the mod does it through ctx.table.read + the 5
    // repair functions. The config table backfills DEFAULT_ENEMY_COMBAT_CONFIG
    // when empty, matching the server's GET endpoint (returns null) + the
    // hydrator's normalizeEnemyCombatConfig.

    async hydrate(ctx) {
        state.compendium = await readTable(ctx, 'compendium', repairCompendium);
        state.instances = await readTable(ctx, 'instances', repairInstances);
        state.encounters = await readTable(ctx, 'encounters', repairEncounters);
        state.resolutions = await readTable(ctx, 'resolutions', repairResolutions);
        state.config = await readTable(ctx, 'config', repairConfig);
        return { ...state };
    },

    // Phase 8.5 — the standing subscriptions that make `hydrate` a nicety
    // rather than the only chance.
    //
    // A one-shot read at activate loses a cold-start race it cannot win: the
    // mod activates before any campaign is open, and when one opens, the
    // `campaign.opened` handler's `ctx.table.read` can still land before the
    // host has finished hydrating `modTables`. The facade then has neither a
    // row to return nor a campaign id to fetch with, and throws — leaving the
    // mod showing DEFAULTS while the user's real data sits one layer away.
    // Observed exactly that way against a real campaign: the compendium window
    // opened with an empty roster and a config that was not the one on disk.
    //
    // `ctx.table.subscribe` (Phase 2.4) is the mechanism for this, and the
    // reference mod built from the docs (`anno-mark`) uses it for the same
    // reason. Every row the host hydrates or any writer changes is pushed
    // here and repaired on the way in, so the mod's state converges no matter
    // which order activation, campaign-open and hydration happen in.
    watch(ctx, onChange) {
        const stops = [];
        const bind = (name, repair, assign) => {
            try {
                const stop = ctx.table.subscribe(name, (rows) => {
                    assign(repair(rows));
                    onChange?.(name);
                });
                if (typeof stop === 'function') stops.push(stop);
            } catch (error) {
                ctx.log?.('[enemies] table subscription unavailable:', name, error);
            }
        };
        bind('compendium', repairCompendium, value => { state.compendium = value; });
        bind('instances', repairInstances, value => { state.instances = value; });
        bind('encounters', repairEncounters, value => { state.encounters = value; });
        bind('resolutions', repairResolutions, value => { state.resolutions = value; });
        bind('config', repairConfig, value => { state.config = value; });
        return () => { for (const stop of stops) stop(); };
    },

    // ── Read-only accessors for the mod's in-memory state ──
    //
    // 8.4's UI mount points call these to read the current state without
    // round-tripping through ctx.table.read. The host's store selectors did
    // the same thing (useShallow on the 4-5 enemy fields).

    getCompendium() { return state.compendium; },
    getInstances() { return state.instances; },
    getEncounters() { return state.encounters; },
    getResolutions() { return state.resolutions; },
    getCombatConfig() { return state.config; },
};

// ── Phase 8.3 — the prompt block, Ask-GM section and interceptor ──
//
// The interceptor is declared in the manifest as
// `native.generateInterceptor: "interceptPrompt"`. It fires once per turn at
// `turn.payloadBuilding`, after `runDirectorStage` and before
// `buildTurnPayload`. It reads the mod's in-memory state (the closure
// captures `state`, which `onActivate` hydrated from the five tables) and
// returns a contribution at order ~150 — immediately after the composed
// volatile block and before the first directive built-in at 200. This is the
// closest reachable position to the pre-8.3 segment's order 300, still inside
// the world-state region of the final user message.
//
// The block's render rules are duplicated from
// `src/services/enemy/enemyEncounter.ts` (`buildActiveEncounterBlock`) and
// `src/services/enemy/enemyPrompt.ts` (`buildRelevantEnemyBlock`), locked by
// the WO-01 contract: a mod never imports from `src/`. 8.5 consolidates when
// the files move to the bundled mod; for 8.3 the mod needs its own copy.

// From src/services/enemy/enemyPrompt.ts (normalizedWords, containsExactPhrase).
function normalizedWords(value) {
    return value
        .normalize('NFKC')
        .toLocaleLowerCase()
        .match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function containsExactPhrase(textWords, phrase) {
    const phraseWords = normalizedWords(phrase);
    if (!phraseWords.length || phraseWords.length > textWords.length) return false;
    return textWords.some((word, start) =>
        word === phraseWords[0]
        && phraseWords.every((phraseWord, offset) => textWords[start + offset] === phraseWord));
}

// From src/services/enemy/enemyPrompt.ts (fitEnemyRecordsToBudget).
// Uses ctx.tokens.count (the host's js-tiktoken cl100k_base encoder) when
// available; falls back to a character approximation when ctx is not in
// scope (the interceptor has ctx via closure, but the helper is also used by
// the OOC section which does not receive ctx).
let _tokenCounter = null;

function fitEnemyRecordsToBudget(header, footer, records, tokenBudget) {
    const finiteBudget = Number.isFinite(tokenBudget) ? Math.max(0, Math.floor(tokenBudget)) : Infinity;
    const countFn = _tokenCounter || ((text) => Math.ceil(text.length / 4));
    const accepted = [];

    for (const lines of records) {
        if (!lines.length) continue;
        const withRequiredLine = [header, ...accepted.map(item => item.rendered), lines[0], footer].join('\n\n');
        if (countFn(withRequiredLine) > finiteBudget) break;
        accepted.push({ source: lines, rendered: lines[0] });
    }

    const maxLines = Math.max(0, ...accepted.map(item => item.source.length));
    for (let lineIndex = 1; lineIndex < maxLines; lineIndex++) {
        for (let recordIndex = 0; recordIndex < accepted.length; recordIndex++) {
            const line = accepted[recordIndex].source[lineIndex];
            if (!line) continue;
            const candidateRecords = accepted.map((item, index) =>
                index === recordIndex ? `${item.rendered}\n${line}` : item.rendered);
            const candidate = [header, ...candidateRecords, footer].join('\n\n');
            if (countFn(candidate) <= finiteBudget) {
                accepted[recordIndex].rendered = candidateRecords[recordIndex];
            }
        }
    }

    return accepted.length ? [header, ...accepted.map(item => item.rendered), footer].join('\n\n') : '';
}

// From src/services/enemy/enemyPrompt.ts (buildRelevantEnemyBlock).
function buildRelevantEnemyBlock(enemies, history, userMessage, tokenBudget) {
    if (!enemies?.length || tokenBudget <= 0) return '';
    const textWords = normalizedWords(`${history.slice(-10).map(m => m.content ?? '').join(' ')} ${userMessage}`);
    const relevant = enemies.filter(enemy => {
        if (enemy.promptEnabled === false) return false;
        const aliases = typeof enemy.aliases === 'string' ? enemy.aliases.split(',') : [];
        const names = [enemy.name, ...aliases].map(v => v.trim()).filter(Boolean);
        return names.some(name => containsExactPhrase(textWords, name));
    }).slice(0, 4);
    if (!relevant.length) return '';

    const records = relevant.map(enemy => [
        `ENEMY: ${enemy.name}`,
        enemy.classification && `TYPE: ${enemy.classification}`,
        enemy.threatTier && `THREAT: ${enemy.threatTier}`,
        enemy.faction && `FACTION: ${enemy.faction}`,
        enemy.stats?.length && `STATS: ${enemy.stats.map(s => `${s.name} ${s.value}`).join('; ')}`,
        enemy.actions?.length && `ACTIONS: ${enemy.actions.map(a => `${a.name} — ${a.description}`).join('; ')}`,
        enemy.specialBehaviors?.length && `SPECIAL: ${enemy.specialBehaviors.join('; ')}`,
        enemy.weaknesses?.length && `WEAKNESSES: ${enemy.weaknesses.join('; ')}`,
        enemy.resistances?.length && `RESISTANCES: ${enemy.resistances.join('; ')}`,
        enemy.tactics && `TACTICS: ${enemy.tactics}`,
        enemy.passiveTraits?.length && `PASSIVES: ${enemy.passiveTraits.join('; ')}`,
        enemy.description && `DESCRIPTION: ${enemy.description}`,
        enemy.loot && `REWARDS: ${enemy.loot}`,
        enemy.gmNotes && `GM NOTES: ${enemy.gmNotes}`,
    ].filter(Boolean));

    return fitEnemyRecordsToBudget(
        '[RELEVANT ENEMY TEMPLATES — immutable reference records]',
        '[END ENEMY TEMPLATES]',
        records,
        tokenBudget,
    );
}

// From src/services/enemy/enemyEncounter.ts (buildActiveEncounterBlock).
function buildActiveEncounterBlock(encounters, instances, combatConfig, tokenBudget) {
    const encounter = encounters?.find(e => e.status === 'active');
    if (!encounter) return '';
    const wave = encounter.waves.find(w => w.id === encounter.activeWaveId);
    if (!wave) return '';

    const byId = new Map((instances ?? []).map(i => [i.id, i]));
    const activeInstances = wave.activeInstanceIds
        .map(id => byId.get(id))
        .filter(i => Boolean(i));

    const header = [
        '[ACTIVE ENCOUNTER — authoritative live state]',
        `ENCOUNTER: ${encounter.name}`,
        `CURRENT WAVE: ${wave.name}`,
        'Use only this active roster for present enemies. Preserve the exact HP, barrier, condition, modifier, and defeated state shown here; do not silently reset or replace it.',
        combatConfig?.enabled
            ? 'The COMBAT, COOLDOWNS, and RESOURCES lines are authoritative tracked state. Narrate their consequences, but never silently mutate them; only player actions in the combat console update these values.'
            : '',
    ].filter(Boolean).join('\n');

    if (!activeInstances.length) {
        return fitEnemyRecordsToBudget(header, '[END ACTIVE ENCOUNTER]',
            [['(No enemy instances are currently active in this wave.)']], tokenBudget);
    }

    const instanceRecords = activeInstances.map(instance => [
        `INSTANCE: ${instance.displayName} (TEMPLATE: ${instance.templateSnapshot.name})\nSTATE: HP ${instance.currentHp}/${instance.maxHp}; BARRIER ${instance.currentBarrier}/${instance.maxBarrier}; ${instance.defeated ? 'DEFEATED/RESOLVED' : 'ACTIVE'}`,
        combatConfig?.enabled && `COMBAT: INITIATIVE ${instance.initiative ?? 'UNSET'}${combatConfig.actionsEnabled ? `; ACTIONS ${instance.actionsRemaining}/${instance.actionsPerTurn}` : ''}`,
        instance.conditions.length && `CONDITIONS: ${instance.conditions.join('; ')}`,
        combatConfig?.enabled && combatConfig.cooldownsEnabled && instance.cooldowns.length
            ? `COOLDOWNS: ${instance.cooldowns.map(c => `${c.name} ${c.remainingRounds} round(s)`).join('; ')}` : '',
        combatConfig?.enabled && combatConfig.resourcesEnabled && instance.resources.length
            ? `RESOURCES: ${instance.resources.map(r => `${r.name} ${r.current}/${r.max}`).join('; ')}` : '',
        instance.temporaryModifiers.length && `TEMPORARY MODIFIERS: ${instance.temporaryModifiers.map(m => `${m.name} ${m.value}`).join('; ')}`,
    ].filter(Boolean));

    const uniqueTemplates = [...new Map(activeInstances.map(i => [i.templateSnapshot.id, i.templateSnapshot])).values()];
    const templateRecords = uniqueTemplates.map(template => [
        `TEMPLATE: ${template.name}`,
        template.classification && `TYPE: ${template.classification}`,
        template.threatTier && `THREAT: ${template.threatTier}`,
        template.stats.length && `BASE STATS: ${template.stats.map(s => `${s.name} ${s.value}`).join('; ')}`,
        template.actions.length && `ACTIONS: ${template.actions.map(a => `${a.name} — ${a.description}`).join('; ')}`,
        template.specialBehaviors.length && `SPECIAL: ${template.specialBehaviors.join('; ')}`,
        template.weaknesses.length && `WEAKNESSES: ${template.weaknesses.join('; ')}`,
        template.resistances.length && `RESISTANCES: ${template.resistances.join('; ')}`,
        template.tactics && `TACTICS: ${template.tactics}`,
        template.passiveTraits.length && `PASSIVES: ${template.passiveTraits.join('; ')}`,
        template.faction && `FACTION: ${template.faction}`,
        template.description && `DESCRIPTION: ${template.description}`,
        template.gmNotes && `GM NOTES: ${template.gmNotes}`,
    ].filter(Boolean));

    return fitEnemyRecordsToBudget(header, '[END ACTIVE ENCOUNTER]',
        [...instanceRecords, ...templateRecords], tokenBudget);
}

/**
 * Phase 8.3 — the generation interceptor.
 *
 * Declared in the manifest as `native.generateInterceptor: "interceptPrompt"`.
 * Fires once per turn at `turn.payloadBuilding`. Reads the mod's in-memory
 * state (captured in the closure) and returns a contribution at order ~150.
 *
 * The `input` argument is the frozen `PromptInterceptorInput` (turnId,
 * campaignId, tier, playerInput, hasDirectorBrief, hasWatchdogNudge,
 * hasAbsoluteCommand). The interceptor does not need most of these fields —
 * it builds the block from the mod's own state, not from the input. The
 * `playerInput` and the messages are read from the closure's `state`, not
 * from `input`, because the interceptor is a closure that captured `ctx` at
 * activate time and `ctx.data.messages` / `ctx.data.playerInput` are the live
 * values.
 *
 * The block's `promptContextEnabled` gate mirrors the pre-8.3 segment: absent
 * means on (preserves campaigns saved before the toggle existed).
 */
export function interceptPrompt(input) {
    // The mod's context is captured in the closure by `onActivate`. The
    // `_modCtx` variable is set at activate time so the interceptor can read
    // `ctx.tokens.count` for token-accurate trimming and `ctx.data.messages`
    // for the history the mention-matcher reads.
    const ctx = _modCtx;
    if (!ctx) return;

    const config = state.config;
    const contextEnabled = config.promptContextEnabled !== false;
    if (!contextEnabled) return;

    // Token budget from the mod's budget claim (2.5% of limit, capped 1024).
    // The claim is registered in `onActivate`; the budget map resolves it at
    // payload-build time. Here we use the same formula directly since the
    // interceptor runs before the budget map is computed — the contribution's
    // `budget` field is what the arbiter uses, and we set it to the same
    // formula so the token arithmetic does not move.
    const limit = ctx.config?.contextLimit ?? 32768;
    const budget = Math.min(1024, Math.floor(limit * 0.025));

    // Set up the token counter for fitEnemyRecordsToBudget.
    _tokenCounter = ctx.tokens ? (text) => ctx.tokens.count(text) : null;

    const messages = ctx.data?.messages ?? [];
    const userMessage = input?.playerInput ?? '';

    const activeEncounterBlock = buildActiveEncounterBlock(
        state.encounters, state.instances, config, budget,
    );
    const text = activeEncounterBlock || buildRelevantEnemyBlock(
        state.compendium, messages, userMessage, budget,
    );

    if (!text) return;

    return {
        contributions: [
            {
                id: 'enemyBlock',
                order: 150,
                budget,
                text,
            },
        ],
    };
}

// The mod's context, captured at activate time so the interceptor closure
// can read `ctx.tokens`, `ctx.data.messages` and `ctx.config.contextLimit`.
let _modCtx = null;

// ── The Ask-GM OOC section builder ──
//
// Duplicated from `src/services/enemy/enemyOocSection.ts` (the in-tree section
// that 8.3 deleted). The rendering rules, the two caps and the
// question-named-wins-over-live-snapshot precedence are unchanged; only the
// address moved (from a side-effect import to `ctx.oocSections.register`).

const MAX_OOC_ENEMIES = 4;
const MAX_OOC_ENEMY_INSTANCES = 8;

function oocEnemyLine(enemy, excerpt) {
    const bits = [];
    if (enemy.aliases?.trim()) bits.push(`aka ${excerpt(enemy.aliases, 80)}`);
    if (enemy.classification?.trim()) bits.push(`type: ${excerpt(enemy.classification, 60)}`);
    if (enemy.threatTier?.trim()) bits.push(`threat: ${excerpt(enemy.threatTier, 40)}`);
    if (enemy.faction?.trim()) bits.push(`faction: ${excerpt(enemy.faction, 60)}`);
    if (enemy.stats?.length) bits.push(`stats: ${excerpt(enemy.stats.map(s => `${s.name} ${s.value}`).join(', '), 160)}`);
    if (enemy.actions?.length) bits.push(`actions: ${excerpt(enemy.actions.map(a => a.name).join(', '), 140)}`);
    if (enemy.specialBehaviors?.length) bits.push(`special: ${excerpt(enemy.specialBehaviors.join(', '), 140)}`);
    if (enemy.weaknesses?.length) bits.push(`weaknesses: ${excerpt(enemy.weaknesses.join(', '), 120)}`);
    if (enemy.resistances?.length) bits.push(`resistances: ${excerpt(enemy.resistances.join(', '), 120)}`);
    if (enemy.passiveTraits?.length) bits.push(`passives: ${excerpt(enemy.passiveTraits.join(', '), 120)}`);
    if (enemy.tactics?.trim()) bits.push(`tactics: ${excerpt(enemy.tactics, 160)}`);
    if (enemy.description?.trim()) bits.push(excerpt(enemy.description, 200));
    if (enemy.loot?.trim()) bits.push(`rewards: ${excerpt(enemy.loot, 100)}`);
    if (enemy.gmNotes?.trim()) bits.push(`notes: ${excerpt(enemy.gmNotes, 160)}`);
    return bits.join('; ');
}

function oocEnemyInstanceLine(instance, excerpt) {
    const bits = [`HP ${instance.currentHp}/${instance.maxHp}`];
    if (instance.maxBarrier > 0) bits.push(`barrier ${instance.currentBarrier}/${instance.maxBarrier}`);
    bits.push(instance.defeated ? 'defeated' : 'active');
    if (instance.conditions.length) bits.push(`conditions: ${excerpt(instance.conditions.join(', '), 120)}`);
    if (instance.temporaryModifiers.length) {
        bits.push(`modifiers: ${excerpt(instance.temporaryModifiers.map(m => `${m.name} ${m.value}`).join(', '), 120)}`);
    }
    return bits.join('; ');
}

function buildEnemyOocSection(question, excerpt, namedIn) {
    const lines = [];
    const sources = [];

    const activeEncounter = (state.encounters ?? []).find(e => e.status === 'active');
    const activeWave = activeEncounter?.waves.find(w => w.id === activeEncounter.activeWaveId);
    const instancesById = new Map((state.instances ?? []).map(i => [i.id, i]));
    const liveInstances = (activeWave?.activeInstanceIds ?? [])
        .map(id => instancesById.get(id))
        .filter(i => !!i)
        .slice(0, MAX_OOC_ENEMY_INSTANCES);
    if (activeEncounter && liveInstances.length > 0) {
        lines.push(`Active encounter: ${excerpt(activeEncounter.name, 80)}${activeWave ? ` - wave ${excerpt(activeWave.name, 60)}` : ''}`);
        for (const instance of liveInstances) {
            const line = `${instance.displayName} (${instance.templateSnapshot.name}): ${oocEnemyInstanceLine(instance, excerpt)}`;
            lines.push(`- ${line}`);
            sources.push({ kind: 'enemy', id: instance.id, label: `On the field: ${instance.displayName}`, excerpt: excerpt(line, 500) });
        }
    }

    const askedEnemies = (state.compendium ?? []).filter(e => namedIn(question, e.name, e.aliases));
    const seenTemplateIds = new Set(askedEnemies.map(e => e.id));
    const liveTemplates = [];
    for (const { templateSnapshot } of liveInstances) {
        if (seenTemplateIds.has(templateSnapshot.id)) continue;
        seenTemplateIds.add(templateSnapshot.id);
        liveTemplates.push(templateSnapshot);
    }
    const enemies = [...askedEnemies, ...liveTemplates].slice(0, MAX_OOC_ENEMIES);
    if (enemies.length > 0) {
        lines.push('Enemy records (compendium):');
        for (const enemy of enemies) {
            const details = oocEnemyLine(enemy, excerpt);
            const line = `${enemy.name}${details ? ` - ${details}` : ''}`;
            lines.push(`- ${line}`);
            sources.push({ kind: 'enemy', id: enemy.id, label: `Enemy: ${enemy.name}`, excerpt: excerpt(line, 500) });
        }
    }

    return { lines, sources };
}

// ── The mod's lifecycle hooks ──
//
// `onActivate` hydrates the five tables from disk. The mod's tables stay
// empty until 8.4 moves the UI — nothing dual-writes, so nothing can diverge
// (§6 build step). The hydrate is safe to run on an empty campaign (the
// repair functions return [] / DEFAULT for empty tables).
//
// `onDisable` is a no-op for 8.2: the host's table adapter owns the on-disk
// files, and the mod's in-memory state is rebuilt on the next activate.
// 8.4's UI teardown is 8.4's; 8.2 just needs the data layer to exist.

function registerEnemyMounts(ctx) {
    if (!ctx.mounts) return;
    // Phase 8.5 — same signature correction as `ui.js`: `__narrativeTranslate`
    // is `(locale, key, vars)`. Called with one argument it read the key as a
    // locale and returned `undefined`, so this silently used the English
    // fallback in every language.
    const translate = globalThis.__narrativeTranslate;
    const locale = document.documentElement.getAttribute('data-lang') || 'en';
    const candidate = typeof translate === 'function' ? translate(locale, 'mod.enemies.modal.title', {}) : undefined;
    const translatedTitle = typeof candidate === 'string' && candidate ? candidate : 'Enemy Compendium';
    const win = ctx.mounts.window({
        id: 'compendium',
        title: translatedTitle,
        defaultSize: { width: 1120, height: 760 },
        minSize: { width: 760, height: 500 },
        resizable: true,
        mount: (node, mountCtx) => mountEnemyCompendium(node, mountCtx, {
            state,
            data: enemyData,
            repairCompendium,
            repairInstances,
            repairEncounters,
            repairResolutions,
            repairConfig,
            getSuggestions: () => enemySuggestions,
            setSuggestions: next => { enemySuggestions.splice(0, enemySuggestions.length, ...next); },
        }),
    });
    const headerHandle = ctx.mounts.header({
        id: 'open',
        icon: 'Swords',
        label: 'header.open.label.off',
        tooltip: 'header.open.tooltip.off',
        onSelect: () => win.open(),
        state: () => {
            const enabled = state.config.enemyDiscoveryEnabled === true;
            return {
                label: enabled ? 'header.open.label.on' : 'header.open.label.off',
                tooltip: enabled ? 'header.open.tooltip.on' : 'header.open.tooltip.off',
                tone: enabled ? 'active' : 'default',
            };
        },
    });
    // Phase 8.5 — one standing subscription per table, replacing the single
    // `config` subscription that only refreshed the header. Every row the host
    // hydrates lands in `state`, so the mod's data survives the cold-start race
    // whichever order activation, campaign-open and hydration happen in. See
    // `enemyData.watch`.
    enemyData.watch(ctx, () => headerHandle.update());

    // The re-hydrate on campaign open stays as the belt to `watch`'s braces:
    // subscriptions cover every row the host publishes, and this covers the
    // case where the host has already published and there is nothing left to
    // push. The campaign-id guard is gone — `ctx.data` is a snapshot taken when
    // the context was built, so at activate time (no campaign open) its
    // `campaignId` is null and the guard rejected the very event it was waiting
    // for. A hydrate for a campaign that is not the open one is harmless
    // anyway: `ctx.table.read` resolves against whatever the host has now.
    ctx.events?.on('campaign.opened', () => {
        enemyData.hydrate(ctx)
            .then(() => {
                headerHandle.update();
                // Phase 9.9.2 — the header was the only thing this told. A
                // window mounted before the hydrate resolved kept whatever it
                // had painted: nothing on a cold start, the PREVIOUS campaign's
                // monsters after a switch. The window's own subscriptions
                // cannot cover this — the host revokes every table lease when
                // the campaign id changes (`ui.js`, `repaintEnemyWindows`).
                repaintEnemyWindows();
            })
            .catch(error => logHydrateFailure(ctx, error));
    });
}

export async function onActivate(ctx) {
    if (!ctx || !ctx.table) return;
    // Capture the context for the interceptor closure.
    _modCtx = ctx;
    registerEnemyMounts(ctx);
    try {
        await enemyData.hydrate(ctx);
    } catch (err) {
        // A hydrate failure is not fatal — the mod's in-memory state stays at
        // the defaults and the standing subscriptions fill it in as soon as
        // the host publishes a row. The host's hydrator had the same defensive
        // shape (campaignHydrator.ts:378-383 wrapped each read in a try).
        logHydrateFailure(ctx, err);
    }

    // Phase 8.3 — register the mod's prompt-side surfaces.

    // 1. Budget claim. The same allocation formula the host's segment used
    //    (2.5% of limit, capped at 1024). The id is namespaced to
    //    `mod.enemies.enemy` by the host; the allocation is identical so
    //    the token arithmetic does not move.
    if (ctx.budgets) {
        ctx.budgets.claim('enemy', (allocCtx) => {
            return Math.min(1024, Math.floor(allocCtx.limit * 0.025));
        }, { name: 'Enemy context', description: 'Relevant enemy templates and the active encounter block. Priority-trimmed within the budget.' });
    }

    // 2. Ask-GM section. Registered through `ctx.oocSections` (Phase 8.3's
    //    new mod-facing API over the OOC section registry). The host
    //    qualifies the id to `mod.enemies.enemy`. The section reads the
    //    mod's in-memory state (the closure captures `state`), not the
    //    OocCampaignSnapshot — the three enemy fields on that snapshot
    //    retired with the in-tree section in 8.3.
    if (ctx.oocSections) {
        ctx.oocSections.register({
            id: 'enemy',
            order: 100,
            build({ question, excerpt, namedIn }) {
                return buildEnemyOocSection(question, excerpt, namedIn);
            },
        });
    }

    // 3. inCombat fact. The host's volatile segment used to derive this; now
    //    the mod publishes it through `ctx.facts` (Phase 5.4). `inCombat` is
    //    true only for a live encounter, never for a compendium-only match —
    //    the same distinction the pre-8.3 `activeEncounterBlock !== ''` drew.
    if (ctx.facts) {
        ctx.facts.register(
            'inCombat',
            () => {
                const encounter = state.encounters.find(e => e.status === 'active');
                if (!encounter) return false;
                const wave = encounter.waves.find(w => w.id === encounter.activeWaveId);
                if (!wave) return false;
                const byId = new Map(state.instances.map(i => [i.id, i]));
                return wave.activeInstanceIds.some(id => {
                    const inst = byId.get(id);
                    return inst && !inst.defeated;
                });
            },
            { claims: 'inCombat' },
        );
    }
}

export function onDisable() {
    // Corrected in Phase 8.5. The comment here used to say the host removes
    // the mod's tables on disable, citing `DATA_POLICY.md` §3. It says the
    // opposite: **disable freezes data, untouched** (§1), and the only thing
    // that removes a mod's tables is the explicit Delete data action (§3). A
    // bundled mod holding a year of somebody's monsters is exactly the case
    // that promise was written for, so the mistake is worth naming rather
    // than quietly fixing.
    //
    // There is still nothing to do here: the host tears down mounts,
    // subscriptions, macros, interceptors, facts, budgets and OOC sections
    // itself, and the mod's in-memory state is rebuilt from its tables on the
    // next activate.
}