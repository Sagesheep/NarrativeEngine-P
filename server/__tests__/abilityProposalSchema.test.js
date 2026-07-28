import { describe, expect, it } from 'vitest';
import { validateAbilityProposal, validateAbilityProposals } from '../lib/abilityProposalSchema.js';

describe('ability proposal server schema', () => {
    it('normalizes a valid progression proposal', () => {
        const result = validateAbilityProposal({
            kind: 'progression',
            abilityId: 'ash-step',
            abilityName: 'Ash Step',
            ownerType: 'pc',
            ownerId: 'hero',
            mastery: 'Adept',
            modification: 'Crosses wider gaps',
        }, 0, 10);
        expect(result.errors).toEqual([]);
        expect(result.value).toEqual(expect.objectContaining({
            kind: 'progression',
            abilityId: 'ash-step',
            ownerId: 'hero',
            createdAt: 10,
        }));
    });

    it('rejects missing targets and non-array collections', () => {
        expect(validateAbilityProposal({ kind: 'assign', abilityId: 'ash-step' }).errors)
            .toContain('abilityProposals[0] must identify an owner for assign proposals');
        expect(validateAbilityProposals({}).errors).toEqual(['Ability proposals must be an array']);
    });
});
