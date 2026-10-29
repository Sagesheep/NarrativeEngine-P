import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NPCEntry, EndpointConfig, ProviderConfig, ChatMessage, PersonalityHex } from '../../types';

// WO: NPC Signature Kit — profile.ts now imports sanitizeSignatureKit from ./shared.
// Partial-mock it alongside sendMessageAndParseJson so the real sanitizer runs (it is
// a pure helper; no network). Without this, vi.mock replaces the whole module and
// `sanitizeSignatureKit` is undefined, breaking generation.
vi.mock('./shared', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./shared')>();
    return {
        ...actual,
        sendMessageAndParseJson: vi.fn(),
    };
});

import { sendMessageAndParseJson } from './shared';
import { generateNPCProfile } from './profile';

const mockSend = vi.mocked(sendMessageAndParseJson);

// ── Seeded RNG (mulberry32) — same helper as hexRoll.test.ts. Deterministic across runs.
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const AXES: readonly (keyof PersonalityHex)[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];

/**
 * Drive the mock sendMessageAndParseJson so the FIRST call of a generation (the PROPOSE call)
 * returns a fixed candidate pool + anchor traits, and the SECOND call (the RENDER call) returns
 * a minimal profile. `callIndex` is tracked across the whole test so multiple NPCs each consume a
 * propose+render pair.
 */
function mockProposeThenRender(proposalObj: object, renderObj: object) {
    let callIndex = 0;
    mockSend.mockImplementation(async () => {
        callIndex++;
        return callIndex % 2 === 1
            ? { parsed: proposalObj, rawStr: '' }
            : { parsed: renderObj, rawStr: '' };
    });
}

describe('generateNPCProfile — Phase-1 refit (propose → roll → render)', () => {
    const provider = { endpoint: 'http://mock-llm', modelName: 'mock-model' } as unknown as EndpointConfig | ProviderConfig;
    const history: ChatMessage[] = [
        { id: '1', role: 'user', content: 'Three street kids loiter by the alley.', timestamp: 0 } as ChatMessage,
    ];

    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('3 NPCs from the same candidate pool yield 3 measurably different hexes (headline acceptance)', async () => {
        const proposal = {
            candidateGroups: ['scholar', 'brute', 'fool'],
            anchorTraits: ['curious'],
        };
        // The render model emits a bogus personalityHex + traits — these MUST be ignored on the
        // new path (hex from ROLL, traits from anchors + engine draw).
        const render = {
            name: 'Street Kid',
            aliases: '',
            status: 'Alive',
            faction: 'Street',
            storyRelevance: 'A street kid',
            disposition: 'Wary',
            goals: 'Survive',
            voice: 'clipped',
            appearance: '[inferred] thin, scuffed shoes',
            personality: 'guarded',
            exampleOutput: '"...what do you want?"',
            longWant: 'get off the street',
            region: 'the alley',
            // BOGUS model-emitted personality numbers — must be DISCARDED by the new path:
            personalityHex: { drive: 3, diligence: 3, boldness: 3, warmth: 3, empathy: 3, composure: 3 },
            traits: ['sadistic', 'bloodthirsty'], // also bogus (and mature-gated) — must be discarded
        };

        const rng = mulberry32(2026);
        const created: NPCEntry[] = [];
        const addNpc = (npc: NPCEntry) => created.push(npc);

        for (let i = 0; i < 3; i++) {
            // Each NPC gets its own propose→render pair, but the mocked payloads are identical.
            mockProposeThenRender(proposal, render);
            await generateNPCProfile(provider, history, `kid-${i}`, addNpc, [], false, rng);
        }

        expect(created.length).toBe(3);

        // 1) Headline: 3 measurably different hexes (variance, not copy-paste).
        const sigs = created.map(n => AXES.map(a => n.personalityHex![a]).join(','));
        const unique = new Set(sigs);
        expect(unique.size, 'three NPCs from one pool must produce >1 distinct hex').toBeGreaterThan(1);

        // 2) No NPC hex comes from model output. The model emitted all-+3; the rolled hex must not
        //    equal the model-emitted object. At least one of the three differs on >= 3 axes
        //    (proves the model output is wholesale discarded, not merged).
        for (const npc of created) {
            const modelHex: PersonalityHex = { drive: 3, diligence: 3, boldness: 3, warmth: 3, empathy: 3, composure: 3 };
            const diffs = AXES.filter(a => npc.personalityHex![a] !== modelHex[a]).length;
            expect(diffs, 'rolled hex must not equal the model-emitted all-+3 hex').toBeGreaterThan(0);
        }
        const maxDiffs = Math.max(...created.map(n => AXES.filter(a => n.personalityHex![a] !== 3).length));
        expect(maxDiffs).toBeGreaterThanOrEqual(3);
    });

    it('hex comes from the ROLL: matches rollHex(primary, secondary, anchors, same seed) exactly', async () => {
        const { rollHex, pickGroups } = await import('../npc/hexRoll');
        const { GROUP_KEYS } = await import('../npc/dispositionGroups');

        const proposal = {
            candidateGroups: ['scholar', 'brute', 'fool'],
            anchorTraits: ['curious'],
        };
        const render = {
            name: 'Kid', status: 'Alive', faction: 'Street', disposition: 'Wary', goals: 'Survive',
            voice: 'clipped', appearance: '', personality: 'guarded', exampleOutput: '"..."',
            longWant: 'get off the street', region: 'alley',
            personalityHex: { drive: -3, diligence: -3, boldness: -3, warmth: -3, empathy: -3, composure: -3 },
            traits: ['depraved'],
        };

        const seed = 4242;
        const rng = mulberry32(seed);
        // Pre-compute the engine skeleton with the SAME rng sequence the generation will consume.
        const expected = pickGroups(['scholar', 'brute', 'fool'], rng);
        const expectedHex = rollHex(expected.primary, expected.secondary, ['curious'], rng);

        // NOTE: generateNPCProfile calls drawShortWants/drawMediumWants AFTER rollHex, which
        // also consume rng. The pre-computed skeleton here only covers pickGroups + rollHex
        // (the first rng consumers), so the stored hex must match expectedHex exactly.

        const rng2 = mulberry32(seed);
        mockProposeThenRender(proposal, render);
        const created: NPCEntry[] = [];
        await generateNPCProfile(provider, history, 'Kid', n => created.push(n), [], false, rng2);

        expect(created[0].personalityHex).toEqual(expectedHex);
        expect(created[0].primaryGroup).toBe(expected.primary);
        expect(created[0].secondaryGroup).toBe(expected.secondary);
        expect((GROUP_KEYS as readonly string[]).includes(created[0].primaryGroup!)).toBe(true);
        if (created[0].secondaryGroup !== undefined) {
            expect(created[0].secondaryGroup).not.toBe(created[0].primaryGroup);
            expect((GROUP_KEYS as readonly string[]).includes(created[0].secondaryGroup)).toBe(true);
        }
    });

    it('no personalityHex / numeric axes asked of the render model (prompt hygiene)', async () => {
        const proposal = { candidateGroups: ['scholar'], anchorTraits: [] };
        const render = { name: 'Kid', status: 'Alive', faction: 'X', disposition: 'Wary', goals: 'g', voice: 'v', appearance: '', personality: 'p', exampleOutput: '"..."', longWant: 'l', region: '' };

        mockProposeThenRender(proposal, render);
        const created: NPCEntry[] = [];
        await generateNPCProfile(provider, history, 'Kid', n => created.push(n), [], false, mulberry32(1));

        // The 2nd sendMessageAndParseJson call (the render) is at index 1; its messages arg is [OpenAIMessage].
        const renderCallArg = mockSend.mock.calls[1][1] as unknown[];
        const renderPrompt = String((renderCallArg[0] as { content: string }).content);
        // The legacy all-zeros hex schema example must be gone (it invited the model to emit hex):
        expect(renderPrompt).not.toContain('"personalityHex": {"drive":0,"diligence":0,"boldness":0,"warmth":0,"empathy":0,"composure":0}');
        // The axis legend ("rate each as an INTEGER from -3 to +3") must be gone from the generation prompt:
        expect(renderPrompt).not.toContain('rate each as an INTEGER from -3 to +3');
        // And the prompt must explicitly forbid the model from emitting hex:
        expect(renderPrompt).toContain('Do NOT emit a "personalityHex" field');
    });

    // One motivation system: new NPCs get agency wants, never legacy drives (2026-10-04).
    it('new NPCs are born with wants and no drives; the render prompt does not ask for drives', async () => {
        const proposal = { candidateGroups: ['scholar'], anchorTraits: [] };
        const render = {
            name: 'Kid', status: 'Alive', faction: 'X', disposition: 'Wary', goals: 'g', voice: 'v', appearance: '',
            personality: 'p', exampleOutput: '"..."', longWant: 'get off the street', region: '',
            drives: { coreWant: 'c', sessionWant: 's', sceneWant: 'x' }, // a stale model habit — ignored
        };

        mockProposeThenRender(proposal, render);
        const created: NPCEntry[] = [];
        await generateNPCProfile(provider, history, 'Kid', n => created.push(n), [], false, mulberry32(1));

        expect(created[0].drives).toBeUndefined();
        expect(created[0].wants?.long).toBe('get off the street');
        expect(created[0].wants?.short.length).toBeGreaterThan(0);
        const renderPrompt = String(((mockSend.mock.calls[1][1] as unknown[])[0] as { content: string }).content);
        expect(renderPrompt).not.toContain('"drives"');
        expect(renderPrompt).not.toContain('sessionWant');
    });

    it('safe fallback when the propose call returns garbage: all GROUP_KEYS + no anchors, still generates', async () => {
        // Propose throws (unparseable) → proposeGroupsAndTraits catches + returns fallback.
        // Render still runs. NPC is created with a rolled hex + group drawn from all GROUP_KEYS.
        let callIndex = 0;
        mockSend.mockImplementation(async () => {
            callIndex++;
            if (callIndex === 1) throw new Error('parse fail');
            return { parsed: { name: 'Kid', status: 'Alive', faction: 'X', disposition: 'Wary', goals: 'g', voice: 'v', appearance: '', personality: 'p', exampleOutput: '"..."', longWant: 'l', region: '' }, rawStr: '' };
        });

        const created: NPCEntry[] = [];
        await generateNPCProfile(provider, history, 'Kid', n => created.push(n), [], false, mulberry32(7));

        expect(created.length).toBe(1);
        expect(created[0].personalityHex).toBeDefined();
        expect(created[0].primaryGroup).toBeDefined();
        for (const axis of AXES) {
            expect(created[0].personalityHex![axis]).toBeGreaterThanOrEqual(-3);
            expect(created[0].personalityHex![axis]).toBeLessThanOrEqual(3);
        }
    });

    it('existing saves load unchanged: NPCEntry without primaryGroup/secondaryGroup is valid', () => {
        const legacy: NPCEntry = {
            id: 'old-1', name: 'Old NPC', aliases: '', appearance: '', faction: 'X',
            storyRelevance: '', disposition: 'Neutral', status: 'Alive', goals: '', voice: '',
            personality: '', exampleOutput: '', affinity: 50,
            personalityHex: { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 },
        };
        expect(legacy.primaryGroup).toBeUndefined();
        expect(legacy.secondaryGroup).toBeUndefined();
        const json = JSON.stringify(legacy);
        const parsed = JSON.parse(json) as NPCEntry;
        expect(parsed.personalityHex).toEqual({ drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 });
        expect(parsed.primaryGroup).toBeUndefined();
    });
});