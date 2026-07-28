import type { EnemyCombatConfig, EnemyEncounter, EnemyEncounterWave, EnemyInstance } from '../../types';
import { fitEnemyRecordsToBudget } from './enemyPrompt';

/** Creates an empty numbered wave for a new or existing encounter. */
export function createEnemyEncounterWave(
    number: number,
    now = Date.now(),
    id = crypto.randomUUID(),
): EnemyEncounterWave {
    return {
        id,
        name: `Wave ${number}`,
        instanceIds: [],
        activeInstanceIds: [],
        createdAt: now,
        updatedAt: now,
    };
}

/** Creates an active encounter with its first empty wave ready for rostering. */
export function createEnemyEncounter(
    name: string,
    now = Date.now(),
    id = crypto.randomUUID(),
    waveId = crypto.randomUUID(),
): EnemyEncounter {
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

/**
 * Renders the selected live roster within a hard token budget. Instance state is
 * listed first, while duplicate instances share one compact template record.
 */
export function buildActiveEncounterBlock(
    encounters: EnemyEncounter[] | undefined,
    instances: EnemyInstance[] | undefined,
    combatConfig?: EnemyCombatConfig,
    tokenBudget = Infinity,
): string {
    const encounter = encounters?.find(candidate => candidate.status === 'active');
    if (!encounter) return '';
    const wave = encounter.waves.find(candidate => candidate.id === encounter.activeWaveId);
    if (!wave) return '';

    const byId = new Map((instances ?? []).map(instance => [instance.id, instance]));
    const activeInstances = wave.activeInstanceIds
        .map(id => byId.get(id))
        .filter((instance): instance is EnemyInstance => Boolean(instance));

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
        return fitEnemyRecordsToBudget(
            header,
            '[END ACTIVE ENCOUNTER]',
            [['(No enemy instances are currently active in this wave.)']],
            tokenBudget,
        );
    }

    const instanceRecords = activeInstances.map(instance => [
        `INSTANCE: ${instance.displayName} (TEMPLATE: ${instance.templateSnapshot.name})\nSTATE: HP ${instance.currentHp}/${instance.maxHp}; BARRIER ${instance.currentBarrier}/${instance.maxBarrier}; ${instance.defeated ? 'DEFEATED/RESOLVED' : 'ACTIVE'}`,
        combatConfig?.enabled && `COMBAT: INITIATIVE ${instance.initiative ?? 'UNSET'}${combatConfig.actionsEnabled ? `; ACTIONS ${instance.actionsRemaining}/${instance.actionsPerTurn}` : ''}`,
        instance.conditions.length && `CONDITIONS: ${instance.conditions.join('; ')}`,
        combatConfig?.enabled && combatConfig.cooldownsEnabled && instance.cooldowns.length
            ? `COOLDOWNS: ${instance.cooldowns.map(cooldown => `${cooldown.name} ${cooldown.remainingRounds} round(s)`).join('; ')}`
            : '',
        combatConfig?.enabled && combatConfig.resourcesEnabled && instance.resources.length
            ? `RESOURCES: ${instance.resources.map(resource => `${resource.name} ${resource.current}/${resource.max}`).join('; ')}`
            : '',
        instance.temporaryModifiers.length && `TEMPORARY MODIFIERS: ${instance.temporaryModifiers.map(modifier => `${modifier.name} ${modifier.value}`).join('; ')}`,
    ].filter((line): line is string => Boolean(line)));

    const uniqueTemplates = [...new Map(activeInstances.map(instance => [
        instance.templateSnapshot.id,
        instance.templateSnapshot,
    ])).values()];
    const templateRecords = uniqueTemplates.map(template => [
        `TEMPLATE: ${template.name}`,
        template.classification && `TYPE: ${template.classification}`,
        template.threatTier && `THREAT: ${template.threatTier}`,
        template.stats.length && `BASE STATS: ${template.stats.map(stat => `${stat.name} ${stat.value}`).join('; ')}`,
        template.actions.length && `ACTIONS: ${template.actions.map(action => `${action.name} — ${action.description}`).join('; ')}`,
        template.specialBehaviors.length && `SPECIAL: ${template.specialBehaviors.join('; ')}`,
        template.weaknesses.length && `WEAKNESSES: ${template.weaknesses.join('; ')}`,
        template.resistances.length && `RESISTANCES: ${template.resistances.join('; ')}`,
        template.tactics && `TACTICS: ${template.tactics}`,
        template.passiveTraits.length && `PASSIVES: ${template.passiveTraits.join('; ')}`,
        template.faction && `FACTION: ${template.faction}`,
        template.description && `DESCRIPTION: ${template.description}`,
        template.gmNotes && `GM NOTES: ${template.gmNotes}`,
    ].filter((line): line is string => Boolean(line)));

    return fitEnemyRecordsToBudget(
        header,
        '[END ACTIVE ENCOUNTER]',
        [...instanceRecords, ...templateRecords],
        tokenBudget,
    );
}
