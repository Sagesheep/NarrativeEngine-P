import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, NPCEntry, RelationshipMemoryFault, RelationshipMemoryRecord, RelationshipStanceSlots } from '../../types';
import { createTraceCollector } from '../payload/traceCollector';
import { buildHistory } from '../payload/history';
import {
    buildRelationshipStancePrompt,
    clearRelationshipStanceCache,
    computeRelationshipStances,
    formatRelationshipStanceRecord,
    renderRelationshipStanceBlock,
    type RelationshipStanceInput,
} from './relationshipStance';

function npc(id: string): NPCEntry {
    return {
        id, name: id, aliases: '', appearance: '', faction: '', storyRelevance: '',
        disposition: 'guarded', status: 'standing at the door', goals: '', voice: '',
        personality: '', exampleOutput: '', affinity: 0, hardBoundaries: ['do not touch the sealed door'],
    };
}

function memory(
    subject: string,
    sceneId: string,
    outcome: string,
    mood: RelationshipMemoryRecord['mood'] = 'tender',
    impact: RelationshipMemoryRecord['impact'] = 'formative',
    event?: string,
): RelationshipMemoryRecord {
    return { sceneId, subject, target: 'MC', mood, impact, outcome, source: 'recorded', ...(event ? { event } : {}) };
}

function validStance(): RelationshipStanceSlots {
    return {
        wantsNow: 'an answer before the silence grows',
        hiding: 'how frightened she is',
        wont: 'open the sealed door',
        inTension: [],
        believes: 'the player is testing her',
        manner: 'contained and precise',
        strain: 'close to breaking her usual restraint',
        considered: ['ask directly', 'leave'],
        readRoomAs: 'a controlled confrontation',
    };
}

function validModelContent(): string {
    const stance = validStance();
    return JSON.stringify({
        wants_now: stance.wantsNow,
        hiding: stance.hiding,
        wont: stance.wont,
        in_tension: stance.inTension,
        believes: stance.believes,
        manner: stance.manner,
        strain: stance.strain,
        considered: stance.considered,
        read_room_as: stance.readRoomAs,
    });
}

function input(overrides: Partial<RelationshipStanceInput> = {}): RelationshipStanceInput {
    return {
        campaignId: 'campaign-test',
        enabled: true,
        aiTier: 'pro',
        npcs: [npc('Mira')],
        onStageNpcIds: ['Mira'],
        relationshipMemoriesNpcToMc: [
            memory('Mira', '010', 'headpat, academy, flustered', 'tender', 'formative', 'put a hand on her head'),
            memory('Mira', '011', 'left her behind at the gate', 'hostile', 'formative', 'walked away without her'),
        ],
        playerCharacter: { name: 'Ari' } as never,
        sceneId: '012',
        sceneKey: 'room-a',
        sceneMood: 'hostile',
        sceneContext: 'The player chose to close the door and wait.',
        modelCall: vi.fn(async () => ({ content: validModelContent() })),
        ...overrides,
    };
}

describe('relationship stance reasoning', () => {
    beforeEach(() => clearRelationshipStanceCache());

    it('stamps every deep-history line and keeps full history unfiltered', () => {
        const records = Array.from({ length: 7 }, (_, index) => memory(
            'Mira',
            String(index + 1).padStart(3, '0'),
            'recorded outcome ' + index,
            index % 2 ? 'hostile' : 'tender',
            index === 0 ? 'carried' : 'passing',
        ));
        const built = buildRelationshipStancePrompt(
            npc('Mira'), 'Ari', records,
            { currentScene: '012', sceneMood: 'hostile', presentParticipants: ['Mira', 'Ari'] },
            'The room is quiet.',
        );

        expect(built.fullHistory).toHaveLength(7);
        for (const record of records) expect(built.prompt).toContain(record.outcome);
        expect(built.fullHistory.every(record => record.line.includes('weight'))).toBe(true);
        expect(built.topRecords).toHaveLength(5);
    });

    it('caches a scene pass and does not make a second deep call', async () => {
        const first = input();
        const call = first.modelCall as ReturnType<typeof vi.fn>;
        const firstResult = await computeRelationshipStances(first);
        const secondResult = await computeRelationshipStances({ ...first, sceneContext: 'non-material narration change' });

        expect(call).toHaveBeenCalledTimes(1);
        expect(secondResult).toBe(firstResult);
    });

    it('recomputes after a material scene-key shift', async () => {
        const first = input();
        const call = first.modelCall as ReturnType<typeof vi.fn>;
        await computeRelationshipStances(first);
        await computeRelationshipStances({ ...first, sceneKey: 'room-b', sceneId: '013' });
        expect(call).toHaveBeenCalledTimes(2);
    });

    it('keeps tier selection stable for a cached scene', async () => {
        const first = input({ aiTier: 'max' });
        const firstResult = await computeRelationshipStances(first);
        const secondResult = await computeRelationshipStances({ ...first, aiTier: 'lite' });

        expect(firstResult[0].tier).toBe('deep');
        expect(secondResult[0].tier).toBe('deep');
        expect(first.modelCall).toHaveBeenCalledTimes(1);
    });

    it('does not call a model in cheap tier and keeps only top records', async () => {
        const call = vi.fn(async () => ({ content: validModelContent() }));
        const result = await computeRelationshipStances(input({
            aiTier: 'lite',
            modelCall: call,
            relationshipMemoriesNpcToMc: Array.from({ length: 8 }, (_, index) => memory(
                'Mira', String(index + 1).padStart(3, '0'), 'outcome ' + index,
                'tender', index < 2 ? 'formative' : 'passing',
            )),
        }));

        expect(call).not.toHaveBeenCalled();
        expect(result[0].tier).toBe('cheap');
        expect(result[0].topRecords).toHaveLength(5);
        expect(result[0].stance).toBeUndefined();
    });

    it('keeps the stance terminator when the renderer admits a whole stance', async () => {
        const result = await computeRelationshipStances(input({ aiTier: 'lite' }));
        const rendered = renderRelationshipStanceBlock(result, 320);

        expect(rendered).toContain('STANCE');
        expect(rendered.endsWith('[END NPC STANCES]')).toBe(true);
    });

    it('runs deep NPC calls in parallel', async () => {
        let active = 0;
        let maxActive = 0;
        const call = vi.fn(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active -= 1;
            return { content: validModelContent() };
        });
        const npcs = [npc('Mira'), npc('Sable'), npc('Tarin')];
        const records = npcs.flatMap((entry, index) => [
            memory(entry.id, '0' + (index + 1) + '0', 'warm outcome ' + index, 'tender', 'formative'),
            memory(entry.id, '0' + (index + 2) + '0', 'cold outcome ' + index, 'hostile', 'formative'),
        ]);
        const result = await computeRelationshipStances(input({
            aiTier: 'max',
            npcs,
            onStageNpcIds: npcs.map(entry => entry.id),
            relationshipMemoriesNpcToMc: records,
            modelCall: call,
        }));

        expect(result).toHaveLength(3);
        expect(call).toHaveBeenCalledTimes(3);
        expect(maxActive).toBe(3);
    });

    it('isolates one failed NPC call without retrying or dropping others', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let callNumber = 0;
        const call = vi.fn(async () => {
            callNumber += 1;
            if (callNumber === 2) throw new Error('provider unavailable');
            return { content: validModelContent() };
        });
        const result = await computeRelationshipStances(input({
            aiTier: 'max',
            npcs: [npc('Mira'), npc('Sable')],
            onStageNpcIds: ['Mira', 'Sable'],
            relationshipMemoriesNpcToMc: [
                memory('Mira', '010', 'warm Mira', 'tender', 'formative'),
                memory('Mira', '011', 'cold Mira', 'hostile', 'formative'),
                memory('Sable', '010', 'warm Sable', 'tender', 'formative'),
                memory('Sable', '011', 'cold Sable', 'hostile', 'formative'),
            ],
            modelCall: call,
        }));

        expect(result).toHaveLength(2);
        expect(result.find(entry => entry.npcId === 'Mira')?.stance).toEqual(validStance());
        expect(result.find(entry => entry.npcId === 'Sable')?.stance).toBeUndefined();
        expect(call).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });

    it('keeps stance metadata out of serialized story-model history', () => {
        const message = {
            id: 'assistant-1',
            role: 'assistant',
            content: 'The story response.',
            timestamp: 1,
            relationshipStances: [{
                npcId: 'Mira', npcName: 'Mira', targetName: 'Ari', sceneId: '012', sceneKey: 'room-a', statuses: 'standing at the door', nonNegotiables: 'do not touch the sealed door',
                tier: 'deep', tierScore: 101, clashCount: 1, pinCount: 2, forcedDeep: false,
                topRecords: [], stance: validStance(),
            }],
        } as ChatMessage;
        const base = {
            userMessage: 'Continue.', limit: 8192, stableTokens: 0,
            currentWorldTokens: 0, volatileTokens: 0, context: {} as never,
            collector: createTraceCollector(false),
        };
        const withMetadata = buildHistory({ ...base, history: [message] });
        const withoutMetadata = buildHistory({ ...base, history: [{ ...message, relationshipStances: undefined }] });

        expect(withMetadata).toEqual(withoutMetadata);
        expect(JSON.stringify(withMetadata)).not.toContain('wantsNow');
        expect(JSON.stringify(withMetadata)).not.toContain('room-a');
    });

    // ─── WO-3.5 §7 — tests whose absence let the defects ship ───

    it('leaves no unfilled placeholder in the built prompt', () => {
        const built = buildRelationshipStancePrompt(
            npc('Edelgard'),
            'Byleth',
            [memory('Edelgard', '010', 'went red and said nothing', 'tender', 'formative', 'put a hand on her head')],
            { currentScene: '012', sceneMood: 'hostile', presentParticipants: ['Edelgard', 'Byleth'] },
            'He came to the cell.',
        );

        // The de-gendered prompt names {name} 7 times and {target} 8. A string-pattern
        // `.replace` fills only the first of each, which shipped an identity header reading
        // literally "{name} — imprisoned". Assert on residue rather than on the two known
        // placeholders, so this also guards any placeholder added later.
        // Matches a brace group opening on a letter and holding no quote — which covers the
        // long placeholders too, while never matching the trailing "Return JSON only" object.
        expect(built.prompt.match(/\{[a-z][^"{}]*\}/gi) ?? []).toEqual([]);
        expect(built.prompt).toContain('Edelgard — ');
        expect(built.prompt).toContain('Edelgard will not, under any circumstance:');
        expect(built.prompt).toContain('EVERY MOMENT Edelgard REMEMBERS OF Byleth');
        expect(built.prompt).toContain('HOW Edelgard HAS ACTUALLY BEHAVED TOWARD Byleth');
    });

    it('does not interpret $ patterns in substituted text', () => {
        const built = buildRelationshipStancePrompt(
            npc('Edelgard'),
            'Byleth',
            [],
            { currentScene: '012', sceneMood: 'hostile', presentParticipants: [] },
            'He offered $& and $1 for her silence.',
        );

        expect(built.prompt).toContain('He offered $& and $1 for her silence.');
    });

    it('renders event — outcome when event is present, outcome-only when absent', () => {
        const withEvent = memory('Mira', '010', 'went red and said nothing', 'tender', 'formative', 'put a hand on her head');
        const withoutEvent = memory('Mira', '011', 'left her behind at the gate', 'hostile', 'formative');
        const lineWith = formatRelationshipStanceRecord(withEvent, 3.42);
        const lineWithout = formatRelationshipStanceRecord(withoutEvent, 1.5);

        expect(lineWith).toBe('#010 put a hand on her head — went red and said nothing [tender, formative; weight 3.42]');
        expect(lineWithout).toBe('#011 left her behind at the gate [hostile, formative; weight 1.50]');
        expect(lineWithout).not.toContain(' — ');
    });

    it('a populated tension survives round-trip — #010 and #011 produce two engine-rendered lines', async () => {
        const call = vi.fn(async () => ({ content: JSON.stringify({
            wants_now: 'him gone', hiding: 'she was waiting', wont: 'concede',
            in_tension: ['#010', '#011'],
            believes: 'he spared her out of feeling', manner: 'contained', strain: 'at her limit',
            considered: ['ask directly'], read_room_as: 'a confrontation',
        }) }));
        const result = await computeRelationshipStances(input({ modelCall: call }));
        const stance = result[0]?.stance;
        expect(stance).toBeDefined();
        expect(stance!.inTension).toHaveLength(2);
        expect(stance!.inTension[0]).toContain('#010');
        expect(stance!.inTension[0]).toContain('put a hand on her head');
        expect(stance!.inTension[1]).toContain('#011');
        expect(stance!.inTension[1]).toContain('walked away without her');
    });

    it('unknown citation degrades partially — one good line plus one fault, not a dropped stance', async () => {
        const faults: RelationshipMemoryFault[] = [];
        const call = vi.fn(async () => ({ content: JSON.stringify({
            wants_now: 'him gone', hiding: 'she was waiting', wont: 'concede',
            in_tension: ['#010', '#999'],
            believes: 'he spared her out of feeling', manner: 'contained', strain: 'at her limit',
            considered: [], read_room_as: 'a confrontation',
        }) }));
        const result = await computeRelationshipStances(input({
            modelCall: call,
            onFault: (f) => faults.push(f),
        }));
        const stance = result[0]?.stance;
        expect(stance).toBeDefined();
        expect(stance!.inTension).toHaveLength(1);
        expect(stance!.inTension[0]).toContain('#010');
        expect(faults).toHaveLength(1);
        expect(faults[0].message).toContain('#999');
    });

    it('no-clash edge accepts an empty tension and returns a stance, not null', async () => {
        const call = vi.fn(async () => ({ content: JSON.stringify({
            wants_now: 'nothing', hiding: 'nothing', wont: 'nothing',
            in_tension: [],
            believes: 'nothing', manner: 'quiet', strain: 'none',
            considered: [], read_room_as: 'a quiet scene',
        }) }));
        const result = await computeRelationshipStances(input({
            relationshipMemoriesNpcToMc: [
                memory('Mira', '010', 'bought bread', 'logistical', 'passing', 'sold her a loaf'),
            ],
            modelCall: call,
        }));
        expect(result[0]?.stance).toBeDefined();
        expect(result[0]!.stance!.inTension).toEqual([]);
    });

    it('every drop path emits a fault — malformed, unresolvable, and thrown', async () => {
        const faults: RelationshipMemoryFault[] = [];
        const onFault = (f: RelationshipMemoryFault) => faults.push(f);

        // malformed
        const malformedCall = vi.fn(async () => ({ content: 'not json at all' }));
        await computeRelationshipStances(input({ modelCall: malformedCall, onFault, sceneKey: 'malformed' }));
        expect(faults.some(f => f.message.includes('malformed response'))).toBe(true);

        // unresolvable citation
        faults.length = 0;
        const unresolvableCall = vi.fn(async () => ({ content: JSON.stringify({
            wants_now: 'x', hiding: 'x', wont: 'x',
            in_tension: ['#999'],
            believes: 'x', manner: 'x', strain: 'x',
            considered: [], read_room_as: 'x',
        }) }));
        await computeRelationshipStances(input({ modelCall: unresolvableCall, onFault, sceneKey: 'unresolvable' }));
        expect(faults.some(f => f.message.includes('#999'))).toBe(true);

        // thrown
        faults.length = 0;
        const throwingCall = vi.fn(async () => { throw new Error('provider unavailable'); });
        await computeRelationshipStances(input({ modelCall: throwingCall, onFault, sceneKey: 'thrown' }));
        expect(faults.some(f => f.message.includes('call failed'))).toBe(true);
    });
    it("passes the configured output cap to the owned model call", async () => {
        const call = vi.fn(async () => ({ content: validModelContent() }));
        await computeRelationshipStances(input({ modelCall: call, maxTokens: 3000, sceneKey: "token-cap" }));
        expect(call).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 3000 }));
    });

});

