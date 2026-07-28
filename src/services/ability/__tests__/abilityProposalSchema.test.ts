import { describe, expect, it } from 'vitest';
import { normalizeAbilityProposals } from '../abilityProposalSchema';

describe('ability proposal client schema', () => {
    it('normalizes valid proposals and skips incomplete ones', () => {
        const result = normalizeAbilityProposals([
            {
                kind: 'new',
                abilityName: 'Ghost Step',
                category: 'reaction',
                ownerType: 'pc',
                ownerId: 'hero',
            },
            { kind: 'assign', abilityId: '' },
        ], { now: 5, createId: () => 'proposal-1' });

        expect(result.skipped).toBe(1);
        expect(result.entries[0]).toEqual(expect.objectContaining({
            id: 'proposal-1',
            kind: 'new',
            abilityName: 'Ghost Step',
            category: 'reaction',
            createdAt: 5,
        }));
    });
});
