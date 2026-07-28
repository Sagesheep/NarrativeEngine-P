import { describe, expect, it } from 'vitest';
import { createEmptyAbilityEntry, normalizeAbilityEntries, normalizeAbilityEntry } from '../abilitySchema';

describe('ability schema normalization', () => {
    it('creates controlled definition drafts', () => {
        const entry = createEmptyAbilityEntry({ now: 10, createId: () => 'ability-1' });
        expect(entry).toEqual(expect.objectContaining({
            id: 'ability-1',
            category: 'active',
            costs: [],
            limitations: [],
            promptEnabled: true,
            createdAt: 10,
        }));
    });

    it('normalizes imports and discards unknown fields', () => {
        const entry = normalizeAbilityEntry({
            name: '  Ash Step ',
            category: 'reaction',
            costs: [{ resource: ' Aura ', amount: 8 }, { resource: '' }, null],
            tags: [' movement ', 4],
            hiddenRuntimeState: { cooldown: 3 },
        }, { now: 20, createId: () => 'ability-2' });

        expect(entry).toEqual(expect.objectContaining({
            id: 'ability-2',
            name: 'Ash Step',
            category: 'reaction',
            costs: [{ resource: 'Aura', amount: '', timing: '', condition: '' }],
            tags: ['movement'],
        }));
        expect(entry).not.toHaveProperty('hiddenRuntimeState');
    });

    it('reports skipped unnamed records', () => {
        const result = normalizeAbilityEntries([{ name: 'Valid' }, { description: 'No name' }, null]);
        expect(result.entries).toHaveLength(1);
        expect(result.skipped).toBe(2);
    });
});
