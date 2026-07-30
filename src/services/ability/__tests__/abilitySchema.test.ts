import { describe, expect, it } from 'vitest';
import { createAbilityCompendiumDocument, createEmptyAbilityEntry, normalizeAbilityCompendiumDocument, normalizeAbilityEntries, normalizeAbilityEntry, resolveAbilityOriginLabel } from '../abilitySchema';

describe('ability schema normalization', () => {
    it('creates controlled definition drafts', () => {
        const entry = createEmptyAbilityEntry({ now: 10, createId: () => 'ability-1' });
        expect(entry).toEqual(expect.objectContaining({
            id: 'ability-1',
            category: 'active',
            origin: 'trained',
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

    it('infers spell origin for older tagged compendium imports', () => {
        const spell = normalizeAbilityEntry({
            name: 'Thunderwave',
            category: 'active',
            tags: ['D&D', 'Bard', 'Spell', '1st-level'],
        });
        expect(spell?.origin).toBe('spell');
    });

    it('accepts legacy arrays and versioned documents with terminology', () => {
        const legacy = normalizeAbilityCompendiumDocument([{ name: 'Legacy Step' }]);
        expect(legacy.entries).toHaveLength(1);
        expect(legacy.terminology.originLabels).toEqual({});

        const document = normalizeAbilityCompendiumDocument({
            schemaVersion: 2,
            terminology: {
                originLabels: { innate: 'Species Trait', unsupported: 'Discarded' },
                categoryLabels: { active: 'Action' },
            },
            abilities: [{ name: 'Darkvision', origin: 'innate' }],
        });
        expect(document.entries[0].name).toBe('Darkvision');
        expect(document.terminology).toEqual({
            originLabels: { innate: 'Species Trait' },
            categoryLabels: { active: 'Action' },
        });
        expect(resolveAbilityOriginLabel('innate', document.terminology)).toBe('Species Trait');
        expect(createAbilityCompendiumDocument(document.entries, document.terminology))
            .toEqual(expect.objectContaining({ schemaVersion: 2, abilities: document.entries }));
    });
});
