import { describe, expect, it } from 'vitest';
import type { EnemyEntry, EnemyInstance } from '../../../types';
import { createEnemyInstance } from '../enemyInstance';

const template = (): EnemyEntry => ({
    id: 'rapture', name: 'Rapture', aliases: '', classification: 'Machine',
    description: '', threatTier: '', tags: [], faction: '', stats: [
        { name: 'HP', value: '120 / 120' },
        { name: 'Barrier HP', value: '35' },
    ],
    actions: [], passiveTraits: [], specialBehaviors: [], weaknesses: [],
    resistances: [], tactics: '', loot: '', gmNotes: '', promptEnabled: true,
    createdAt: 1, updatedAt: 1,
});

describe('createEnemyInstance', () => {
    it('seeds explicit tracks and snapshots the template', () => {
        const source = template();
        const result = createEnemyInstance(source, [], 10, 'instance-1');

        expect(result).toMatchObject({
            id: 'instance-1',
            templateId: 'rapture',
            displayName: 'Rapture #1',
            currentHp: 120,
            maxHp: 120,
            currentBarrier: 35,
            maxBarrier: 35,
            defeated: false,
        });

        source.name = 'Changed';
        source.stats[0].value = '1';
        expect(result.templateSnapshot.name).toBe('Rapture');
        expect(result.templateSnapshot.stats[0].value).toBe('120 / 120');
    });

    it('increments copy labels without reusing a deleted number', () => {
        const source = template();
        const first = createEnemyInstance(source, [], 10, 'instance-1');
        const third = { ...first, id: 'instance-3', displayName: 'Rapture #3' } satisfies EnemyInstance;
        const result = createEnemyInstance(source, [third], 20, 'instance-4');

        expect(result.displayName).toBe('Rapture #4');
    });

    it('does not infer tracks from unrelated stats or prose', () => {
        const source = { ...template(), stats: [{ name: 'Armor', value: '50' }] };
        const result = createEnemyInstance(source, [], 10, 'instance-1');

        expect(result.maxHp).toBe(0);
        expect(result.maxBarrier).toBe(0);
    });
});
