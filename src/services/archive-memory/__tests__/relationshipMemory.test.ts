import { describe, expect, it } from 'vitest';
import {
    buildRelationshipMemoryPrompt,
    mergeRelationshipMemoryCollections,
    normaliseRelationshipMemoryRecords,
    rateRelationshipMemory,
    type RelationshipMemoryParticipants,
} from '../relationshipMemory';
import type { NPCEntry } from '../../../types';

function makeNpc(id: string, name: string): NPCEntry {
    return {
        id,
        name,
        aliases: '',
        appearance: '',
        faction: '',
        storyRelevance: '',
        disposition: '',
        status: '',
        goals: '',
        voice: '',
        personality: '',
        exampleOutput: '',
        affinity: 0,
        archived: false,
        isPC: false,
    };
}

function makeParticipants(names = ['A', 'B'], playerCharacter: NPCEntry | null = null): RelationshipMemoryParticipants {
    return {
        presentNames: names,
        onStageNpcs: names.map((name) => makeNpc(name.toLowerCase(), name)),
        playerCharacter,
    };
}

describe('relationship memory recorder', () => {
    it('rejects invalid vocabulary and faults the scene', () => {
        const result = normaliseRelationshipMemoryRecords('001', [{
            subject: 'A', target: 'B', mood: 'excited', impact: 'passing', event: 'said hello', outcome: 'looked away',
        }], makeParticipants());

        expect(result.faults).toHaveLength(1);
        expect(result.npcToMc).toHaveLength(0);
        expect(result.npcToNpc).toHaveLength(0);
    });

    it('downgrades carried without a carried note to formative', () => {
        const result = normaliseRelationshipMemoryRecords('001', [{
            subject: 'A', target: 'B', mood: 'fraught', impact: 'carried', event: 'left the room suddenly', outcome: 'left the room',
        }], makeParticipants());

        expect(result.faults).toHaveLength(0);
        expect(result.npcToNpc[0]?.impact).toBe('formative');
        expect(result.npcToNpc[0]?.carriedNote).toBeUndefined();
    });

    it('keeps emission sparse when no pair interacted', () => {
        const result = normaliseRelationshipMemoryRecords('001', [], makeParticipants());

        expect(result.npcToMc).toEqual([]);
        expect(result.npcToNpc).toEqual([]);
    });

    it('writes NPC-to-MC and NPC-to-NPC records into separate collections', () => {
        const result = normaliseRelationshipMemoryRecords('001', [
            { subject: 'A', target: 'MC', mood: 'tender', impact: 'remembered', event: 'offered tea', outcome: 'accepted the tea' },
            { subject: 'A', target: 'B', mood: 'hostile', impact: 'passing', event: 'raised a blade', outcome: 'stepped back' },
        ], makeParticipants());

        expect(result.npcToMc).toHaveLength(1);
        expect(result.npcToNpc).toHaveLength(1);
        expect(result.npcToMc[0]?.target).toBe('MC');
        expect(result.npcToNpc[0]?.target).toBe('b');
    });

    it('isolates parse failure without changing existing records', async () => {
        const existing = [{
            sceneId: '000', subject: 'a', target: 'MC', mood: 'tender', impact: 'passing',
            outcome: 'smiled', source: 'user' as const,
        }];
        const failed = await rateRelationshipMemory('001', 'scene', makeParticipants(), async () => ({ content: 'not json' }));
        const merged = mergeRelationshipMemoryCollections(existing, [], failed);

        expect(failed.faults).toHaveLength(1);
        expect(merged.npcToMc).toEqual(existing);
        expect(merged.npcToNpc).toEqual([]);
    });

    it('marks an MC subject as inferred when no player character is flagged', () => {
        const result = normaliseRelationshipMemoryRecords('001', [{
            subject: 'A', target: 'MC', mood: 'grave', impact: 'remembered', event: 'stood vigil beside the body', outcome: 'bowed silently',
        }], makeParticipants(['A'], null));

        expect(result.npcToMc[0]?.subjectInferred).toBe(true);
    });

    it('uses the supplied prompt wording and only substitutes scene inputs', () => {
        const prompt = buildRelationshipMemoryPrompt('A committed scene.', makeParticipants(['A'], null));

        expect(prompt).toContain('ongoing story —');
        expect(prompt).toContain('mood — the emotional register');
        expect(prompt).toContain('`passing`');
        expect(prompt).toContain('event — what the OTHER person did');
        expect(prompt).toContain('[SCENE]\nA committed scene.');
        expect(prompt).toContain('[PRESENT]\nA');
        expect(prompt).not.toContain('?');
    });

    // ─── WO-3.5 §7 — Fix A/D tests ───

    it('a rater record with no event faults and is not stored', () => {
        const result = normaliseRelationshipMemoryRecords('001', [
            { subject: 'A', target: 'MC', mood: 'tender', impact: 'remembered', outcome: 'accepted the tea' },
        ], makeParticipants(['A'], null));

        expect(result.npcToMc).toHaveLength(0);
        expect(result.faults).toHaveLength(1);
        expect(result.faults[0].message).toContain('no event');
    });

    it('a rater record with event is stored alongside a faulted sibling that lacks event', () => {
        const result = normaliseRelationshipMemoryRecords('001', [
            { subject: 'A', target: 'MC', mood: 'tender', impact: 'remembered', event: 'offered tea', outcome: 'accepted it' },
            { subject: 'A', target: 'MC', mood: 'hostile', impact: 'passing', outcome: 'walked away' },
        ], makeParticipants(['A'], null));

        expect(result.npcToMc).toHaveLength(1);
        expect(result.npcToMc[0].event).toBe('offered tea');
        expect(result.faults).toHaveLength(1);
        expect(result.faults[0].message).toContain('no event');
    });
});