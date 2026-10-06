import { describe, expect, it } from 'vitest';
import { extractPresentNames, getRelationshipMemoryParticipants } from '../relationshipMemory';
import type { NPCEntry } from '../../../types';

const npc = (id: string, name: string, over: Partial<NPCEntry> = {}) => ({ id, name, aliases: '', ...over }) as NPCEntry;
const ledger = [npc('n1', 'Rin Holmes'), npc('n2', 'Sanna'), npc('n3', 'Therese Soll'), npc('pc', 'Grey Holmes', { isPC: true })];

describe('relationship-memory participants', () => {
    it('reads the default ruleset header', () => {
        expect(extractPresentNames('📍 [Location] Docks | 👥 [Present] Rin, Sanna')).toEqual(['Rin', 'Sanna']);
    });

    // The old exact `[Present]` match found nobody on headers like these, so the track
    // returned before its rating call (0 of ~1,600 headers in the owner's campaigns).
    it('reads the bracket-and-bold header custom rulesets write, and resolves short names', () => {
        const p = getRelationshipMemoryParticipants('📍 Kitchen | 👥 [**Grey**], [**Rin**], [**Sanna**]\n\nThe kettle sings.', ledger, null);
        expect(p.presentNames).toEqual(['Grey', 'Rin', 'Sanna']);
        expect(p.onStageNpcs.map(n => n.id)).toEqual(['n1', 'n2']); // the PC is a participant, not an on-stage NPC
    });

    it('nobody on stage when the header says so', () => {
        expect(getRelationshipMemoryParticipants('👥 Nobody', ledger, null).onStageNpcs).toEqual([]);
    });
});
