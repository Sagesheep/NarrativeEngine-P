import { describe, expect, it } from 'vitest';
import { agencyFillPatch, needsAgencyFill } from './agencyLazyFill';
import type { NPCEntry } from '../../../types';

const seeded = (seed: number) => () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
};

const legacy = (over: Partial<NPCEntry> = {}): NPCEntry => ({
    id: 'n1', name: 'Sanna', aliases: '', appearance: '', faction: 'Holmes Agency', storyRelevance: '',
    disposition: 'warm but guarded', status: '', goals: 'Keep the agency solvent', voice: '',
    personality: 'cautious, loyal, quietly ambitious', exampleOutput: '', affinity: 60,
    ...over,
} as NPCEntry);

describe('needsAgencyFill', () => {
    it('an NPC from before the agency system needs it', () => {
        expect(needsAgencyFill(legacy())).toBe(true);
    });

    it('populated NPCs, the player character and the dead do not', () => {
        expect(needsAgencyFill(legacy({ populated: true }))).toBe(false);
        expect(needsAgencyFill(legacy({ isPC: true }))).toBe(false);
        expect(needsAgencyFill(legacy({ condition: 'dead' }))).toBe(false);
    });
});

describe('agencyFillPatch', () => {
    it('fills the agency fields mechanically and marks the NPC populated', () => {
        const patch = agencyFillPatch(legacy(), { matureMode: false, rng: seeded(7) });

        expect(patch.populated).toBe(true);
        expect(patch.personalityHex).toBeDefined();
        expect(patch.wants?.short).toHaveLength(4);
        expect(patch.wants?.medium).toHaveLength(3);
        expect(patch.wants?.long).toBe('Keep the agency solvent');
        expect(patch.wantsProvenance).toBe('pool');
        expect(patch.skillRung).toBe(0);
        expect(patch.rungCeiling).toBe(3);
        expect(patch.pcRelation).toBeDefined();
    });

    it('is deterministic for a given rng', () => {
        expect(agencyFillPatch(legacy(), { matureMode: false, rng: seeded(3) }))
            .toEqual(agencyFillPatch(legacy(), { matureMode: false, rng: seeded(3) }));
    });

    it('carries an existing drive into the wants instead of losing it', () => {
        const patch = agencyFillPatch(legacy({
            drives: { coreWant: 'to be seen as capable', sessionWant: 'repay the Soll debt', sceneWant: 'read the letter' },
        }), { matureMode: false, rng: seeded(5) });

        expect(patch.wants?.short[0]).toBe('read the letter');
        expect(patch.wants?.medium[0]).toBe('repay the Soll debt');
        expect(patch.wants?.long).toBe('to be seen as capable');
    });

    it('never overwrites a field the NPC already has', () => {
        const hex = { drive: 1, diligence: 1, boldness: 1, warmth: 1, empathy: 1, composure: 1 };
        const wants = { short: ['eat'], medium: ['win a duel'], long: 'rule' };
        const patch = agencyFillPatch(legacy({ personalityHex: hex, wants, pcRelation: 2, skillRung: 4 } as Partial<NPCEntry>), { matureMode: false });

        expect(patch).not.toHaveProperty('personalityHex');
        expect(patch).not.toHaveProperty('wants');
        expect(patch).not.toHaveProperty('pcRelation');
        expect(patch).not.toHaveProperty('skillRung');
    });
});
