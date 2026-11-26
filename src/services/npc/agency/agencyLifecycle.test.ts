import { describe, it, expect } from 'vitest';
import { isAgencyEligible, filterUpdatableNPCs, completeShortWant } from './agencyLifecycle';
import type { NPCEntry, NPCWants } from '../../../types';

describe('agencyLifecycle', () => {
    describe('isAgencyEligible', () => {
        it('returns false if npc is a PC', () => {
            const npc = { id: 'pc', isPC: true } as NPCEntry;
            expect(isAgencyEligible(npc)).toBe(false);
        });

        it('returns false if npc is agencyLocked', () => {
            const npc = { id: 'npc1', isPC: false, agencyLocked: true } as unknown as NPCEntry;
            expect(isAgencyEligible(npc)).toBe(false);
        });

        it('returns false if npc condition is dead', () => {
            const npc = { id: 'npc1', isPC: false, condition: 'dead' } as NPCEntry;
            expect(isAgencyEligible(npc)).toBe(false);
        });

        it('returns true for a normal eligible NPC', () => {
            const npc = { id: 'npc1', isPC: false, condition: 'healthy' } as NPCEntry;
            expect(isAgencyEligible(npc)).toBe(true);
        });
    });

    describe('filterUpdatableNPCs', () => {
        const eligibleOnStage = { id: 'npc1', isPC: false, condition: 'healthy' } as NPCEntry;
        const eligibleMentioned = { id: 'npc2', isPC: false, condition: 'healthy' } as NPCEntry;
        const eligibleStale = { id: 'npc3', isPC: false, condition: 'healthy' } as NPCEntry;
        const ineligibleOnStage = { id: 'npc4', isPC: false, condition: 'dead' } as NPCEntry;
        const ineligibleMentioned = { id: 'npc5', isPC: false, agencyLocked: true } as unknown as NPCEntry;

        const npcs = [
            eligibleOnStage,
            eligibleMentioned,
            eligibleStale,
            ineligibleOnStage,
            ineligibleMentioned
        ];

        it('keeps on-stage and recently-mentioned eligible NPCs, dropping others', () => {
            const result = filterUpdatableNPCs(npcs, {
                onStageIds: ['npc1', 'npc4'],
                recentlyMentionedIds: ['npc2', 'npc5']
            });

            expect(result).toContain(eligibleOnStage);
            expect(result).toContain(eligibleMentioned);
            expect(result).not.toContain(eligibleStale);
            expect(result).not.toContain(ineligibleOnStage);
            expect(result).not.toContain(ineligibleMentioned);
            expect(result).toHaveLength(2);
        });

        it('handles empty options gracefully', () => {
            const result = filterUpdatableNPCs(npcs, {});
            expect(result).toHaveLength(0);
        });
    });

    describe('completeShortWant', () => {
        it('removes the satisfied short want, returns a NEW object, and does not mutate input', () => {
            const originalWants: NPCWants = {
                short: ['eat', 'rest', 'read'],
                medium: ['earn wealth'],
                long: 'become king'
            };

            const result = completeShortWant(originalWants, 'rest');

            // Verify the short want is removed
            expect(result.short).toEqual(['eat', 'read']);

            // Verify medium and long are untouched
            expect(result.medium).toEqual(originalWants.medium);
            expect(result.long).toBe(originalWants.long);

            // Verify a NEW object is returned
            expect(result).not.toBe(originalWants);

            // Verify the input object is not mutated
            expect(originalWants.short).toEqual(['eat', 'rest', 'read']);
        });

        it('does nothing if the short want is not present', () => {
            const originalWants: NPCWants = {
                short: ['eat', 'rest'],
                medium: ['earn wealth'],
                long: 'become king'
            };

            const result = completeShortWant(originalWants, 'read');

            expect(result.short).toEqual(['eat', 'rest']);
            expect(result).not.toBe(originalWants);
        });
    });
});
