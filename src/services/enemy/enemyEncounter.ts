import type { EnemyEncounter, EnemyEncounterWave, EnemyInstance } from '../../types';

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

/** Renders the selected live roster as an authoritative volatile prompt block. */
export function buildActiveEncounterBlock(
    encounters: EnemyEncounter[] | undefined,
    instances: EnemyInstance[] | undefined,
): string {
    const encounter = encounters?.find(candidate => candidate.status === 'active');
    if (!encounter) return '';
    const wave = encounter.waves.find(candidate => candidate.id === encounter.activeWaveId);
    if (!wave) return '';

    const byId = new Map((instances ?? []).map(instance => [instance.id, instance]));
    const activeInstances = wave.activeInstanceIds
        .map(id => byId.get(id))
        .filter((instance): instance is EnemyInstance => Boolean(instance));

    const roster = activeInstances.length
        ? activeInstances.map(instance => {
            const template = instance.templateSnapshot;
            return [
                `INSTANCE: ${instance.displayName}`,
                `STATE: HP ${instance.currentHp}/${instance.maxHp}; BARRIER ${instance.currentBarrier}/${instance.maxBarrier}; ${instance.defeated ? 'DEFEATED/RESOLVED' : 'ACTIVE'}`,
                instance.conditions.length && `CONDITIONS: ${instance.conditions.join('; ')}`,
                instance.temporaryModifiers.length && `TEMPORARY MODIFIERS: ${instance.temporaryModifiers.map(modifier => `${modifier.name} ${modifier.value}`).join('; ')}`,
                template.classification && `TYPE: ${template.classification}`,
                template.threatTier && `THREAT: ${template.threatTier}`,
                template.faction && `FACTION: ${template.faction}`,
                template.description && `DESCRIPTION: ${template.description}`,
                template.stats.length && `BASE STATS: ${template.stats.map(stat => `${stat.name} ${stat.value}`).join('; ')}`,
                template.actions.length && `ACTIONS: ${template.actions.map(action => `${action.name} — ${action.description}`).join('; ')}`,
                template.passiveTraits.length && `PASSIVES: ${template.passiveTraits.join('; ')}`,
                template.specialBehaviors.length && `SPECIAL: ${template.specialBehaviors.join('; ')}`,
                template.weaknesses.length && `WEAKNESSES: ${template.weaknesses.join('; ')}`,
                template.resistances.length && `RESISTANCES: ${template.resistances.join('; ')}`,
                template.tactics && `TACTICS: ${template.tactics}`,
                template.gmNotes && `GM NOTES: ${template.gmNotes}`,
            ].filter(Boolean).join('\n');
        }).join('\n\n')
        : '(No enemy instances are currently active in this wave.)';

    return [
        '[ACTIVE ENCOUNTER — authoritative live state]',
        `ENCOUNTER: ${encounter.name}`,
        `CURRENT WAVE: ${wave.name}`,
        'Use only this active roster for present enemies. Preserve the exact HP, barrier, condition, modifier, and defeated state shown here; do not silently reset or replace it.',
        roster,
        '[END ACTIVE ENCOUNTER]',
    ].join('\n');
}
