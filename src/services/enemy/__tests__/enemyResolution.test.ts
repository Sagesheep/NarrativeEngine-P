import { describe, expect, it } from 'vitest';
import type { EnemyEncounter, EnemyEntry, EnemyInstance } from '../../../types';
import {
    buildEnemyResolutionTimelineEvent,
    createEnemyEncounterResolution,
    getEncounterInstances,
    suggestEnemyResolution,
} from '../enemyResolution';

const template = (id: string, name: string, xp: string, loot: string): EnemyEntry => ({
    id, name, aliases: '', classification: '', description: '', threatTier: '',
    tags: [], faction: '', stats: [{ name: 'XP', value: xp }], actions: [],
    passiveTraits: [], specialBehaviors: [], weaknesses: [], resistances: [],
    tactics: '', loot, gmNotes: '', promptEnabled: true, createdAt: 1, updatedAt: 1,
});

const instance = (id: string, source: EnemyEntry, defeated: boolean): EnemyInstance => ({
    id, templateId: source.id, templateSnapshot: source, displayName: `${source.name} #1`,
    currentHp: defeated ? 0 : 10, maxHp: 10, currentBarrier: 0, maxBarrier: 0,
    conditions: [], temporaryModifiers: [], defeated, initiative: null,
    actionsRemaining: 1, actionsPerTurn: 1, cooldowns: [], resources: [],
    createdAt: 1, updatedAt: 1,
});

const encounter: EnemyEncounter = {
    id: 'encounter-1', name: 'Bridge Ambush', status: 'active',
    waves: [
        { id: 'wave-1', name: 'Wave 1', instanceIds: ['scout-1'], activeInstanceIds: ['scout-1'], createdAt: 1, updatedAt: 1 },
        { id: 'wave-2', name: 'Wave 2', instanceIds: ['scout-1', 'guard-1'], activeInstanceIds: [], createdAt: 1, updatedAt: 1 },
    ],
    activeWaveId: 'wave-2', createdAt: 1, updatedAt: 1,
};

describe('enemy encounter resolution', () => {
    const scout = instance('scout-1', template('scout', 'Scout', '20 XP', 'Scrap\nCore'), true);
    const guard = instance('guard-1', template('guard', 'Guard', '30', 'Core'), false);

    it('collects assigned instances once across multiple waves', () => {
        expect(getEncounterInstances(encounter, [scout, guard]).map(value => value.id)).toEqual(['scout-1', 'guard-1']);
    });

    it('suggests XP and loot only from instances marked resolved', () => {
        const draft = suggestEnemyResolution(encounter, [scout, guard]);

        expect(draft.xpAwarded).toBe(20);
        expect(draft.lootAwarded).toEqual(['Scrap', 'Core']);
        expect(draft.outcome).toBe('partial');
        expect(draft.summary).toContain('1 of 2 participants');
    });

    it('archives full instance snapshots without changing templates', () => {
        const draft = suggestEnemyResolution(encounter, [scout, guard]);
        const resolution = createEnemyEncounterResolution(encounter, [scout, guard], draft, 100, 'resolution-1');

        expect(resolution.archivedInstances).toHaveLength(2);
        expect(resolution.archivedInstances[0]).not.toBe(scout);
        expect(resolution.participantNames).toEqual(['Scout #1', 'Guard #1']);
        expect(resolution.resolvedAt).toBe(100);
    });

    it('discard mode omits mutable runtime snapshots', () => {
        const draft = { ...suggestEnemyResolution(encounter, [scout, guard]), instanceDisposition: 'discard' as const };
        const resolution = createEnemyEncounterResolution(encounter, [scout, guard], draft);

        expect(resolution.archivedInstances).toEqual([]);
        expect(resolution.participantNames).toEqual(['Scout #1', 'Guard #1']);
    });

    it('builds an archive timeline event containing the confirmed rewards', () => {
        const draft = {
            ...suggestEnemyResolution(encounter, [scout, guard]),
            otherRewards: ['Faction favour'],
        };
        const resolution = createEnemyEncounterResolution(encounter, [scout, guard], draft);
        const event = buildEnemyResolutionTimelineEvent(resolution, '007', 'CH02');

        expect(event).toMatchObject({
            sceneId: '007',
            chapterId: 'CH02',
            subject: 'Bridge Ambush',
            predicate: 'status',
            object: 'resolved: partial',
            importance: 7,
        });
        expect(event.summary).toContain('20 XP');
        expect(event.summary).toContain('Faction favour');
    });
});
