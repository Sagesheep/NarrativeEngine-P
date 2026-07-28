import { describe, expect, it } from 'vitest';
import { validateAbilityCompendium, validateAbilityEntry } from '../lib/abilitySchema.js';

describe('ability compendium API schema', () => {
    it('normalizes nullable optional fields and strips unknown fields', () => {
        const result = validateAbilityEntry({
            name: 'Ash Step',
            category: 'reaction',
            costs: [{ resource: 'Aura', amount: null, timing: 'On activation' }],
            tags: [null, 'movement'],
            limitations: null,
            unknown: 'discard me',
        }, 0, 10);

        expect(result.errors).toEqual([]);
        expect(result.value).toEqual(expect.objectContaining({
            name: 'Ash Step',
            category: 'reaction',
            costs: [{ resource: 'Aura', amount: '', timing: 'On activation', condition: '' }],
            tags: ['movement'],
            limitations: [],
            createdAt: 10,
            updatedAt: 10,
        }));
        expect(result.value).not.toHaveProperty('unknown');
    });

    it('rejects malformed lists, costs, and unsupported categories', () => {
        const result = validateAbilityCompendium([{
            name: 'Broken Power',
            category: 'ultimate',
            tags: 'fire',
            costs: [{ amount: '10' }],
        }]);

        expect(result.errors).toContain('abilities[0].category must be a supported ability category or null');
        expect(result.errors).toContain('abilities[0].tags must be an array or null');
        expect(result.errors).toContain('abilities[0].costs[0].resource is required');
    });
});
