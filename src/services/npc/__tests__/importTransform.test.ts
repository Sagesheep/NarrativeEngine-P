import { describe, it, expect } from 'vitest';
import { prepareImportedNpcs } from '../importTransform';
import type { NPCEntry } from '../../../types';

// A representative cross-campaign export: intrinsic identity + origin-campaign
// plot baggage (storyRelevance/goals/region/groups/relations/equipment).
function sampleExport(): Partial<NPCEntry> {
    return {
        id: 'origin-id-123',
        name: 'John Roleplay',
        appearance: 'Lean, wiry, thin scar on left jaw',
        voice: 'Monotone, clipped sentences',
        personality: 'Suspicious, guarded',
        disposition: 'Suspicious, guarded',
        faction: 'Independent operator',
        storyRelevance: "Caught with the stolen Warder's Knot seal — pivotal to Lord Vex's investigation.",
        goals: 'Escape the manor with the seal and deliver it to his client.',
        pcRelation: 3,
        region: 'academy',
        haunt: 'the garden',
        primaryGroup: 'scholars',
        secondaryGroup: 'thieves',
        relations: { 'origin-npc-9': { kind: 'ally' } } as unknown as NPCEntry['relations'],
        signatureKit: { equipment: ["Warder's Knot seal", 'pick set'], abilities: ['Lockpicking', 'Stealth'] },
        goalRecords: [{ text: 'accumulate wealth' } as unknown as NonNullable<NPCEntry['goalRecords']>[number]],
    };
}

let counter = 0;
const makeId = () => `new-${counter++}`;

describe('prepareImportedNpcs', () => {
    it('full: assigns a fresh id but keeps every origin field verbatim', () => {
        const [npc] = prepareImportedNpcs([sampleExport()], 'full', makeId);
        expect(npc.id).not.toBe('origin-id-123');
        expect(npc.storyRelevance).toContain('Warder\'s Knot seal');
        expect(npc.goals).toContain('Escape the manor');
        expect(npc.pcRelation).toBe(3);
        expect(npc.region).toBe('academy');
        expect(npc.signatureKit?.equipment).toContain("Warder's Knot seal");
        expect(npc.transmigrated).toBeUndefined();
    });

    it('strip: clears plot-bound + dangling fields, keeps intrinsic identity', () => {
        const [npc] = prepareImportedNpcs([sampleExport()], 'strip', makeId);
        // Cleared / reset
        expect(npc.storyRelevance).toBe('');
        expect(npc.goals).toBe('');
        expect(npc.pcRelation).toBe(0);
        expect(npc.region).toBeUndefined();
        expect(npc.haunt).toBeUndefined();
        expect(npc.primaryGroup).toBeUndefined();
        expect(npc.secondaryGroup).toBeUndefined();
        expect(npc.relations).toBeUndefined();
        // Kept: intrinsic identity + skills + ambitions
        expect(npc.appearance).toContain('thin scar');
        expect(npc.voice).toContain('Monotone');
        expect(npc.personality).toContain('guarded');
        expect(npc.goalRecords?.[0]?.text).toBe('accumulate wealth');
        // Signature kit: abilities kept, equipment (plot loot) dropped
        expect(npc.signatureKit?.abilities).toEqual(['Lockpicking', 'Stealth']);
        expect(npc.signatureKit?.equipment).toEqual([]);
    });

    it('strip: drops the whole kit when no intrinsic abilities remain', () => {
        const entry = { ...sampleExport(), signatureKit: { equipment: ['loot'], abilities: [] } };
        const [npc] = prepareImportedNpcs([entry], 'strip', makeId);
        expect(npc.signatureKit).toBeUndefined();
    });

    it('isekai: full import + transmigration framing prepended to storyRelevance', () => {
        const [npc] = prepareImportedNpcs([sampleExport()], 'isekai', makeId);
        expect(npc.transmigrated).toBe(true);
        expect(npc.storyRelevance.startsWith('[TRANSMIGRATED]')).toBe(true);
        // original memory preserved after the framing
        expect(npc.storyRelevance).toContain("Warder's Knot seal");
        // plot fields still present (full import)
        expect(npc.goals).toContain('Escape the manor');
    });

    it('isekai: still frames an NPC that had no storyRelevance', () => {
        const entry = { ...sampleExport(), storyRelevance: '' };
        const [npc] = prepareImportedNpcs([entry], 'isekai', makeId);
        expect(npc.storyRelevance.startsWith('[TRANSMIGRATED]')).toBe(true);
        // no origin memory to append → framing stands alone, no separator
        expect(npc.storyRelevance).not.toContain('\n\n');
    });
});
