import { describe, expect, it } from 'vitest';
import { normalizeEnemyEntries, normalizeEnemyEntry } from '../enemySchema';

describe('enemy entry normalization', () => {
    it('treats nullable optional fields as unused and removes invalid list elements', () => {
        const normalized = normalizeEnemyEntry({
            name: 'Royal Duelist',
            tags: null,
            stats: null,
            weaknesses: null,
            actions: [
                { name: 'Riposte', description: null },
                null,
                { name: null, description: 'ignored' },
            ],
            unknownField: 'discard me',
        }, { now: 10, createId: () => 'generated-id' });

        expect(normalized).toEqual(expect.objectContaining({
            id: 'generated-id',
            name: 'Royal Duelist',
            tags: [],
            stats: [],
            weaknesses: [],
            actions: [{ name: 'Riposte', description: '' }],
            createdAt: 10,
            updatedAt: 10,
        }));
        expect(normalized).not.toHaveProperty('unknownField');
    });

    it('skips records without a usable name', () => {
        const result = normalizeEnemyEntries([
            null,
            { name: null },
            { name: '   ' },
            { name: 'Orc', tags: 'not-an-array' },
        ], { now: 10, createId: () => 'orc-id' });

        expect(result.skipped).toBe(3);
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].tags).toEqual([]);
    });
});
