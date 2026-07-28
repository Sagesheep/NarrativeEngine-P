import type {
    EnemyEncounter,
    EnemyEncounterOutcome,
    EnemyEncounterResolution,
    EnemyInstance,
    EnemyInstanceDisposition,
    TimelineEvent,
} from '../../types';

export type EnemyResolutionDraft = {
    outcome: EnemyEncounterOutcome;
    summary: string;
    xpAwarded: number;
    lootAwarded: string[];
    otherRewards: string[];
    instanceDisposition: EnemyInstanceDisposition;
    createTimelineEvent: boolean;
};

/** Returns each instance assigned to any encounter wave exactly once. */
export function getEncounterInstances(
    encounter: EnemyEncounter,
    instances: EnemyInstance[],
): EnemyInstance[] {
    const assignedIds = new Set(encounter.waves.flatMap(wave => wave.instanceIds));
    return instances.filter(instance => assignedIds.has(instance.id));
}

/** Reads a non-negative reward value from common XP stat labels. */
function instanceXp(instance: EnemyInstance): number {
    const stat = instance.templateSnapshot.stats.find(candidate => {
        const name = candidate.name.trim().toLowerCase();
        return name === 'xp' || name === 'experience' || name === 'experience points';
    });
    const match = stat?.value.match(/-?\d+(?:\.\d+)?/);
    return match ? Math.max(0, Number(match[0])) : 0;
}

/** Splits multiline template loot while preserving prose within each line. */
function instanceLoot(instance: EnemyInstance): string[] {
    return instance.templateSnapshot.loot
        .split(/\r?\n/)
        .map(value => value.trim())
        .filter(Boolean);
}

/** Builds editable, deterministic reward suggestions from resolved instances. */
export function suggestEnemyResolution(
    encounter: EnemyEncounter,
    instances: EnemyInstance[],
): EnemyResolutionDraft {
    const participants = getEncounterInstances(encounter, instances);
    const resolved = participants.filter(instance => instance.defeated);
    const xpAwarded = resolved.reduce((total, instance) => total + instanceXp(instance), 0);
    const lootAwarded = [...new Set(resolved.flatMap(instanceLoot))];
    const resolvedNames = resolved.map(instance => instance.displayName);
    const outcome: EnemyEncounterOutcome = participants.length > 0 && resolved.length === participants.length
        ? 'victory'
        : resolved.length > 0
            ? 'partial'
            : 'other';
    const summary = resolvedNames.length
        ? `${encounter.name} ended with ${resolvedNames.length} of ${participants.length} participant${participants.length === 1 ? '' : 's'} defeated or otherwise resolved: ${resolvedNames.join(', ')}.`
        : `${encounter.name} ended. No instances were marked defeated or resolved.`;

    return {
        outcome,
        summary,
        xpAwarded,
        lootAwarded,
        otherRewards: [],
        instanceDisposition: 'archive',
        createTimelineEvent: true,
    };
}

/**
 * Freezes the player-confirmed outcome. Discard mode retains participant names
 * for the summary but deliberately omits mutable runtime instance data.
 */
export function createEnemyEncounterResolution(
    encounter: EnemyEncounter,
    instances: EnemyInstance[],
    draft: EnemyResolutionDraft,
    now = Date.now(),
    id = crypto.randomUUID(),
): EnemyEncounterResolution {
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

/** Converts a resolution into the manual timeline event consumed by archive context. */
export function buildEnemyResolutionTimelineEvent(
    resolution: EnemyEncounterResolution,
    sceneId = '000',
    chapterId = 'CH00',
): Omit<TimelineEvent, 'id' | 'source'> {
    const rewardText = [
        resolution.xpAwarded > 0 ? `${resolution.xpAwarded} XP` : '',
        ...resolution.lootAwarded,
        ...resolution.otherRewards,
    ].filter(Boolean).join(', ');
    return {
        sceneId,
        chapterId,
        subject: resolution.encounterName,
        predicate: 'status',
        object: `resolved: ${resolution.outcome}`,
        summary: `${resolution.summary}${rewardText ? ` Rewards: ${rewardText}.` : ''}`,
        importance: 7,
    };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const optionalText = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

const optionalStringList = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        : [];

const finiteNumber = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const ENCOUNTER_OUTCOMES = new Set(['victory', 'partial', 'defeat', 'escaped', 'negotiated', 'other']);
const INSTANCE_DISPOSITIONS = new Set(['archive', 'discard']);

/**
 * Safely normalizes a persisted or imported resolution. Malformed archived
 * instances are dropped; incompatible enum values degrade to safe defaults so
 * the Enemy Compendium UI never crashes on legacy/damaged files.
 */
export function normalizeEnemyResolution(value: unknown): EnemyEncounterResolution | null {
    if (!isRecord(value)) return null;
    const now = Date.now();
    const outcome: EnemyEncounterResolution['outcome'] = typeof value.outcome === 'string' && ENCOUNTER_OUTCOMES.has(value.outcome) ? value.outcome as EnemyEncounterResolution['outcome'] : 'other';
    const instanceDisposition: EnemyEncounterResolution['instanceDisposition'] = typeof value.instanceDisposition === 'string' && INSTANCE_DISPOSITIONS.has(value.instanceDisposition)
        ? value.instanceDisposition as EnemyEncounterResolution['instanceDisposition']
        : 'archive';
    const archivedInstances = Array.isArray(value.archivedInstances)
        ? value.archivedInstances.filter(isRecord)
        : [];
    return {
        id: optionalText(value.id) || crypto.randomUUID(),
        encounterId: optionalText(value.encounterId),
        encounterName: optionalText(value.encounterName) || 'Encounter',
        outcome,
        summary: optionalText(value.summary) || 'Encounter ended.',
        xpAwarded: Math.max(0, finiteNumber(value.xpAwarded, 0)),
        lootAwarded: optionalStringList(value.lootAwarded),
        otherRewards: optionalStringList(value.otherRewards),
        participantNames: optionalStringList(value.participantNames),
        instanceDisposition,
        archivedInstances: archivedInstances as EnemyInstance[],
        ...(optionalText(value.timelineEventId) ? { timelineEventId: value.timelineEventId as string } : {}),
        resolvedAt: finiteNumber(value.resolvedAt, now),
    };
}

/** Normalizes an unknown list of resolutions, dropping records that cannot be identified. */
export function normalizeEnemyResolutions(value: unknown): EnemyEncounterResolution[] {
    if (!Array.isArray(value)) return [];
    return value.map(normalizeEnemyResolution).filter((r): r is EnemyEncounterResolution => r !== null);
}
