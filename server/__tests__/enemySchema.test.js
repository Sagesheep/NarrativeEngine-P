import { describe, expect, it } from 'vitest';
import { validateEnemyCompendium, validateEnemyEntry } from '../lib/enemySchema.js';

describe('enemy compendium API schema', () => {
    it('normalizes nullable optional fields and ignores null list entries', () => {
        const result = validateEnemyEntry({
            name: 'Royal Duelist',
            tags: null,
            stats: null,
            weaknesses: [null, 'Fire'],
            actions: [null, { name: 'Riposte', description: null }],
        }, 0, 10);

        expect(result.errors).toEqual([]);
        expect(result.value).toEqual(expect.objectContaining({
            name: 'Royal Duelist',
            tags: [],
            stats: [],
            weaknesses: ['Fire'],
            actions: [{ name: 'Riposte', description: '' }],
            createdAt: 10,
            updatedAt: 10,
        }));
    });

    it('rejects incompatible non-null field shapes with indexed errors', () => {
        const result = validateEnemyCompendium([
            { name: 'Broken Orc', tags: 'melee', stats: 'HP 10' },
        ]);

        expect(result.errors).toContain('enemies[0].tags must be an array or null');
        expect(result.errors).toContain('enemies[0].stats must be an array or null');
    });

    it('rejects unnamed records', () => {
        const result = validateEnemyCompendium([{ name: null }]);

        expect(result.errors).toContain('enemies[0].name is required');
    });
});
