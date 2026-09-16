import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    resolveAdaptationEndpoint,
    describeAdaptationEndpoint,
    makeModelCaller,
    buildCardExtract,
    batchTargets,
    buildAdaptationMessages,
    parseAdaptationResponse,
    applyAdaptedWants,
    runAdaptation,
    MAX_BATCH_CARDS,
    type CardExtract,
} from '../adaptation';
import { ADAPTATION_WANT_LIMITS } from '../adaptationTypes';
import type { AdaptationTarget, AdaptationModelCall, AdaptationProgress, AdaptationResult } from '../adaptationTypes';
import type { STCard } from '../stCardTypes';
import type { LLMProvider, NPCEntry } from '../../../types';
import { sendMessage } from '../../llm/llmService';

vi.mock('../../llm/llmService', () => ({
    sendMessage: vi.fn(),
}));

const mockedSend = vi.mocked(sendMessage);

// ─── fixtures ────────────────────────────────────────────────────────────────

function card(over: Partial<STCard> = {}): STCard {
    return {
        name: 'Aria',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        alternate_greetings: [],
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        creator: '',
        creator_notes: '',
        spec: 'v2',
        ...over,
    };
}

function npc(over: Partial<NPCEntry> = {}): NPCEntry {
    return {
        id: 'npc-1',
        name: 'Aria',
        aliases: '',
        appearance: '',
        faction: '',
        storyRelevance: 'Aria — imported character',
        disposition: '',
        status: 'Alive',
        goals: '',
        voice: '',
        personality: 'Shy but kind.',
        exampleOutput: '',
        affinity: 50,
        tier: 'recurring',
        condition: 'healthy',
        wants: { short: ['eat', 'rest'], medium: ['earn wealth'], long: '' },
        wantsProvenance: 'pool',
        ...over,
    };
}

function target(id: string, name: string, cardOver: Partial<STCard> = {}, npcOver: Partial<NPCEntry> = {}): AdaptationTarget {
    return {
        id,
        name,
        card: card({ name, ...cardOver }),
        npc: npc({ id, name, ...npcOver }),
    };
}

function provider(over: Partial<LLMProvider> = {}): LLMProvider {
    return { id: 'p1', label: 'Utility', endpoint: 'http://localhost:1234/v1', apiKey: '', modelName: 'tiny-3b', ...over };
}

const ex = (id: string, tokens: number): CardExtract => ({ id, name: id.toUpperCase(), text: `extract ${id}`, tokens });

function line(text: string, label: string): string {
    const found = text.split('\n').find(l => l.startsWith(`${label}: `));
    return found ? found.slice(label.length + 2) : '';
}

/** A fake model that reads the ids out of the prompt and answers for each. */
function idsInPrompt(user: string): string[] {
    return [...user.matchAll(/CHARACTER id: (\S+) \|/g)].map(m => m[1]);
}

const echoModel: AdaptationModelCall = async (messages) => {
    const user = messages.find(m => m.role === 'user')?.content ?? '';
    return JSON.stringify(idsInPrompt(user).map(id => ({
        id,
        short: ['rest by the fire'],
        medium: ['earn a steady wage'],
        long: 'Keep the shop open through the winter.',
    })));
};

// ─── buildCardExtract ────────────────────────────────────────────────────────

describe('buildCardExtract (WO-C §9.3 — bounded card text)', () => {
    it('carries name, personality, description, scenario, tags and prose creator notes', () => {
        const extract = buildCardExtract(target('t1', 'Aria', {
            personality: 'Shy but kind.',
            description: 'A tailor in the lower ward.',
            scenario: 'The guild is auditing the ward.',
            tags: ['fantasy', 'tailor'],
            creator_notes: 'Written for a slice-of-life campaign.',
        }));
        expect(extract.id).toBe('t1');
        expect(extract.name).toBe('Aria');
        expect(extract.text).toContain('Name: Aria');
        expect(extract.text).toContain('Shy but kind.');
        expect(extract.text).toContain('A tailor in the lower ward.');
        expect(extract.text).toContain('The guild is auditing the ward.');
        expect(extract.text).toContain('Tags: fantasy, tailor');
        expect(extract.text).toContain('Written for a slice-of-life campaign.');
        expect(extract.tokens).toBeGreaterThan(0);
    });

    it('NEVER includes the lorebook, system prompt, greetings or example dialogue', () => {
        const extract = buildCardExtract(target('t1', 'Aria', {
            description: 'A tailor in the lower ward.',
            first_mes: 'GREETINGMARKER — she looks up from the loom.',
            alternate_greetings: ['ALTGREETINGMARKER'],
            mes_example: '<START>\n{{char}}: EXAMPLEDIALOGUEMARKER',
            system_prompt: 'SYSTEMPROMPTMARKER: you are Aria.',
            post_history_instructions: 'POSTHISTORYMARKER',
            character_book: {
                name: 'Aria lore',
                entries: [{
                    keys: ['ward'],
                    secondary_keys: [],
                    content: 'LOREBOOKMARKER — the lower ward burned in 1102.',
                    comment: 'LOREBOOKCOMMENTMARKER',
                    constant: true,
                    enabled: true,
                    insertion_order: 0,
                }],
            },
        }));
        for (const marker of [
            'GREETINGMARKER', 'ALTGREETINGMARKER', 'EXAMPLEDIALOGUEMARKER',
            'SYSTEMPROMPTMARKER', 'POSTHISTORYMARKER', 'LOREBOOKMARKER', 'LOREBOOKCOMMENTMARKER',
        ]) {
            expect(extract.text).not.toContain(marker);
        }
    });

    it('respects the per-field caps', () => {
        const long = (unit: string, times: number) => Array.from({ length: times }, () => unit).join(' ');
        const extract = buildCardExtract(target('t1', 'Aria', {
            personality: long('She is patient and exacting in every stitch.', 40),
            description: long('The shop sits at the end of Candle Row.', 60),
            scenario: long('The audit begins at dawn.', 40),
            creator_notes: long('Use her sparingly.', 40),
        }));
        expect(line(extract.text, 'Personality').length).toBeLessThanOrEqual(400);
        expect(line(extract.text, 'Description').length).toBeLessThanOrEqual(600);
        expect(line(extract.text, 'Scenario').length).toBeLessThanOrEqual(300);
        expect(line(extract.text, 'Creator notes').length).toBeLessThanOrEqual(200);
    });

    it('turns W++ personality into trait lines, never raw brackets', () => {
        const extract = buildCardExtract(target('t1', 'Rin', {
            personality: '[Character("Rin"){Age("17") Likes("tea","rain")}]',
        }));
        expect(extract.text).toContain('Age: 17');
        expect(extract.text).toContain('Likes: tea, rain');
        expect(extract.text).not.toContain('[');
        expect(extract.text).not.toContain('Character(');
    });

    it('drops structured creator notes but keeps a structured description as trait lines', () => {
        const extract = buildCardExtract(target('t1', 'Rin', {
            description: '[Character("Rin"){Job("courier")}]',
            creator_notes: 'Notes("v3","fixed typo")',
        }));
        expect(extract.text).toContain('Job: courier');
        expect(extract.text).not.toContain('Creator notes:');
    });

    it('shows the current pool wants as replaceable placeholders', () => {
        const extract = buildCardExtract(target('t1', 'Aria'));
        expect(extract.text).toContain('Placeholder motivations (replace)');
        expect(extract.text).toContain('eat');
        expect(extract.text).toContain('earn wealth');
    });

    it('omits the placeholder line when the NPC has no wants yet', () => {
        const extract = buildCardExtract(target('t1', 'Aria', {}, { wants: undefined }));
        expect(extract.text).not.toContain('Placeholder motivations');
    });
});

// ─── batchTargets ────────────────────────────────────────────────────────────

describe('batchTargets (WO-C §9.3 — bounded groups by input-token size)', () => {
    it('fills greedily in order up to the budget', () => {
        const batches = batchTargets([ex('a', 100), ex('b', 100), ex('c', 100)], 250);
        expect(batches.map(b => b.map(e => e.id))).toEqual([['a', 'b'], ['c']]);
    });

    it('isolates an over-budget extract instead of dropping or splitting it', () => {
        const batches = batchTargets([ex('a', 100), ex('big', 5000), ex('c', 100)], 250);
        expect(batches.map(b => b.map(e => e.id))).toEqual([['a'], ['big'], ['c']]);
    });

    it('caps a pile of tiny cards at the 4-8 card target', () => {
        const tiny = Array.from({ length: 10 }, (_, i) => ex(`t${i}`, 1));
        const batches = batchTargets(tiny, 1800);
        expect(batches).toHaveLength(2);
        expect(batches[0]).toHaveLength(MAX_BATCH_CARDS);
        expect(batches[1]).toHaveLength(10 - MAX_BATCH_CARDS);
    });

    it('lands typical cards in 4-8 card batches at the default budget', () => {
        const typical = Array.from({ length: 12 }, (_, i) => ex(`c${i}`, 300));
        for (const batch of batchTargets(typical)) {
            expect(batch.length).toBeGreaterThanOrEqual(1);
            expect(batch.length).toBeLessThanOrEqual(MAX_BATCH_CARDS);
        }
        expect(batchTargets(typical)[0]).toHaveLength(6); // 6 × 300 = 1800
    });

    it('returns no batches for no extracts', () => {
        expect(batchTargets([])).toEqual([]);
    });
});

// ─── buildAdaptationMessages ─────────────────────────────────────────────────

describe('buildAdaptationMessages (WO-C §9.3 — the prompt)', () => {
    const batch = [ex('id-a', 40), ex('id-b', 40)];

    it('is a system + user pair carrying the import id and every card id and name', () => {
        const msgs = buildAdaptationMessages(batch, 'import-777');
        expect(msgs.map(m => m.role)).toEqual(['system', 'user']);
        const user = msgs[1].content;
        expect(user).toContain('import-777');
        expect(user).toContain('CHARACTER id: id-a | name: ID-A');
        expect(user).toContain('CHARACTER id: id-b | name: ID-B');
        expect(user).toContain('extract id-a');
        expect(user).toContain('extract id-b');
        expect(user).toContain('"id-a", "id-b"');
    });

    it('states the card-is-canonical / no-external-canon rule', () => {
        const system = buildAdaptationMessages(batch, 'i1')[0].content;
        expect(system).toContain('The card text is canonical.');
        expect(system).toContain('no external canon');
        expect(system).toMatch(/alternate-universe, age-shifted, or rewritten/);
    });

    it('demands JSON only, with the shape and the caps spelled out', () => {
        const system = buildAdaptationMessages(batch, 'i1')[0].content;
        expect(system).toContain('Output ONLY a JSON array');
        expect(system).toContain('no markdown code fences');
        expect(system).toContain('at most 60 characters');
        expect(system).toContain('at most 80 characters');
        expect(system).toContain('at most 160 characters');
    });

    it('forbids wants that justify major irreversible actions', () => {
        const system = buildAdaptationMessages(batch, 'i1')[0].content;
        expect(system).toContain('never justify a major irreversible action');
        expect(system).toContain('marry the player');
    });

    it('allows a card-established relationship with the player, but not as a romantic/violent/coercive object', () => {
        const system = buildAdaptationMessages(batch, 'i1')[0].content;
        expect(system).toContain('Refer to the player character only when the card itself establishes that relationship');
        expect(system).toContain('never as the object of a romantic, violent, or coercive want');
        // The old blanket ban is gone — cards written around the player are normal.
        expect(system).not.toContain('never name or target the player character');
    });

    it('adds the mature guard when matureMode is off and drops it when on', () => {
        expect(buildAdaptationMessages(batch, 'i1', { matureMode: false })[0].content).toContain('non-explicit');
        expect(buildAdaptationMessages(batch, 'i1')[0].content).toContain('non-explicit');
        expect(buildAdaptationMessages(batch, 'i1', { matureMode: true })[0].content).not.toContain('non-explicit');
    });
});

// ─── parseAdaptationResponse ─────────────────────────────────────────────────

describe('parseAdaptationResponse (WO-C §9.3 — isolated JSON results)', () => {
    const expected = [{ id: 'a', name: 'Aria' }, { id: 'b', name: 'Bran' }];

    const clean = JSON.stringify([
        { id: 'a', short: ['rest', 'eat well'], medium: ['earn a wage'], long: 'Keep the shop open.' },
        { id: 'b', short: ['sharpen tools'], medium: ['train a apprentice'], long: 'Retire to the coast.' },
    ]);

    it('parses a clean array in expected order', () => {
        const results = parseAdaptationResponse(clean, expected);
        expect(results.map(r => r.id)).toEqual(['a', 'b']);
        expect(results.every(r => r.status === 'adapted')).toBe(true);
        expect(results[0].wants).toEqual({ short: ['rest', 'eat well'], medium: ['earn a wage'], long: 'Keep the shop open.' });
    });

    it('tolerates a preamble, code fences and a trailing note', () => {
        const messy = `Sure! Here is the JSON:\n\`\`\`json\n${clean}\n\`\`\`\nLet me know if you want changes.`;
        const results = parseAdaptationResponse(messy, expected);
        expect(results.every(r => r.status === 'adapted')).toBe(true);
    });

    it('salvages the complete objects out of a truncated array', () => {
        const truncated = '[{"id":"a","short":["rest"],"medium":["earn a wage"],"long":"Keep the shop open."},{"id":"b","short":["sharp';
        const results = parseAdaptationResponse(truncated, expected);
        expect(results[0].status).toBe('adapted');
        expect(results[1].status).toBe('failed');
        expect(results[1].error).toBeTruthy();
    });

    it('clamps item counts and lengths', () => {
        const overlong = JSON.stringify([{
            id: 'a',
            short: ['s1 '.repeat(40), 's2', 's3', 's4', 's5', 's6'],
            medium: ['m1 '.repeat(50), 'm2', 'm3', 'm4'],
            long: 'L '.repeat(200),
        }]);
        const [result] = parseAdaptationResponse(overlong, [{ id: 'a', name: 'Aria' }]);
        expect(result.status).toBe('adapted');
        expect(result.wants!.short).toHaveLength(ADAPTATION_WANT_LIMITS.shortItems);
        expect(result.wants!.medium).toHaveLength(ADAPTATION_WANT_LIMITS.mediumItems);
        for (const s of result.wants!.short) expect(s.length).toBeLessThanOrEqual(ADAPTATION_WANT_LIMITS.shortChars);
        for (const m of result.wants!.medium) expect(m.length).toBeLessThanOrEqual(ADAPTATION_WANT_LIMITS.mediumChars);
        expect(result.wants!.long.length).toBeLessThanOrEqual(ADAPTATION_WANT_LIMITS.longChars);
    });

    it('trims, drops empties and dedupes case-insensitively', () => {
        const dupes = JSON.stringify([{ id: 'a', short: ['  rest  ', 'Rest', '', '   ', '- rest'], medium: ['"earn a wage"'], long: ' Keep going. ' }]);
        const [result] = parseAdaptationResponse(dupes, [{ id: 'a', name: 'Aria' }]);
        expect(result.wants!.short).toEqual(['rest']);
        expect(result.wants!.medium).toEqual(['earn a wage']);
        expect(result.wants!.long).toBe('Keep going.');
    });

    it('drops ids nobody asked for and fails the ones that never arrived', () => {
        const strays = JSON.stringify([
            { id: 'zzz', short: ['loiter'], medium: ['lurk'], long: 'Be a stranger.' },
            { id: 'a', short: ['rest'], medium: ['earn a wage'], long: 'Keep the shop open.' },
        ]);
        const results = parseAdaptationResponse(strays, expected);
        expect(results.map(r => r.id)).toEqual(['a', 'b']);
        expect(results[0].status).toBe('adapted');
        expect(results[1].status).toBe('failed');
    });

    it('ignores personalityHex, traits, relations, pcRelation and affinity if the model volunteers them', () => {
        const volunteered = JSON.stringify([{
            id: 'a',
            short: ['rest'],
            medium: ['earn a wage'],
            long: 'Keep the shop open.',
            personalityHex: { drive: 3, diligence: 3, boldness: 3, warmth: 3, empathy: 3, composure: 3 },
            traits: ['ruthless', 'vengeful'],
            relations: { b: -3 },
            pcRelation: 3,
            affinity: 95,
        }]);
        const [result] = parseAdaptationResponse(volunteered, [{ id: 'a', name: 'Aria' }]);
        expect(Object.keys(result).sort()).toEqual(['id', 'name', 'status', 'wants']);
        expect(Object.keys(result.wants!).sort()).toEqual(['long', 'medium', 'short']);
        expect(JSON.stringify(result)).not.toContain('personalityHex');
        expect(JSON.stringify(result)).not.toContain('ruthless');
    });

    it('accepts a bare string where an array was asked for, and an array where a string was', () => {
        const loose = JSON.stringify([{ id: 'a', short: 'rest', medium: 'earn a wage', long: ['Keep the shop open.', 'ignored'] }]);
        const [result] = parseAdaptationResponse(loose, [{ id: 'a', name: 'Aria' }]);
        expect(result.wants).toEqual({ short: ['rest'], medium: ['earn a wage'], long: 'Keep the shop open.' });
    });

    it('fails every expected id when nothing parses', () => {
        const results = parseAdaptationResponse('I am sorry, I cannot help with that request.', expected);
        expect(results.map(r => r.status)).toEqual(['failed', 'failed']);
        expect(results[0].error).toContain('JSON');
    });

    it('fails an entry that arrived with no usable wants', () => {
        const empty = JSON.stringify([{ id: 'a', short: [], medium: [], long: '' }]);
        const [result] = parseAdaptationResponse(empty, [{ id: 'a', name: 'Aria' }]);
        expect(result.status).toBe('failed');
        expect(result.wants).toBeUndefined();
    });
});

// ─── applyAdaptedWants ───────────────────────────────────────────────────────

describe('applyAdaptedWants (WO-C §9.3 — wants only, provenance stamped)', () => {
    const entry = npc({
        personalityHex: { drive: 1, diligence: 2, boldness: -1, warmth: 2, empathy: 1, composure: 0 },
        traits: ['loyal'],
        portrait: '/uploads/aria.png',
        populated: true,
    });

    it('replaces only the wants and stamps the inferred provenance', () => {
        const out = applyAdaptedWants(entry, { short: ['rest'], medium: ['earn a wage'], long: 'Keep the shop open.' });
        expect(out.wants).toEqual({ short: ['rest'], medium: ['earn a wage'], long: 'Keep the shop open.' });
        expect(out.wantsProvenance).toBe('inferred');
        expect(out.personalityHex).toEqual(entry.personalityHex);
        expect(out.traits).toEqual(entry.traits);

        // Every other field byte-identical.
        const withoutWants = (e: NPCEntry): Record<string, unknown> => {
            const copy: Record<string, unknown> = { ...e };
            delete copy.wants;
            delete copy.wantsProvenance;
            return copy;
        };
        expect(withoutWants(out)).toEqual(withoutWants(entry));
    });

    it('falls back to the pool entry for any tier the model left empty', () => {
        const out = applyAdaptedWants(entry, { short: [], medium: ['earn a wage'], long: '' });
        expect(out.wants!.short).toEqual(entry.wants!.short);
        expect(out.wants!.medium).toEqual(['earn a wage']);
        expect(out.wants!.long).toBe('');
        expect(out.wantsProvenance).toBe('inferred');
    });

    it('clamps defensively and never mutates its input', () => {
        const before = JSON.stringify(entry);
        const out = applyAdaptedWants(entry, { short: ['x'.repeat(300)], medium: [], long: 'y'.repeat(400) });
        expect(JSON.stringify(entry)).toBe(before);
        expect(out).not.toBe(entry);
        expect(out.wants!.short[0].length).toBeLessThanOrEqual(ADAPTATION_WANT_LIMITS.shortChars);
        expect(out.wants!.long.length).toBeLessThanOrEqual(ADAPTATION_WANT_LIMITS.longChars);
    });
});

// ─── endpoint resolution ─────────────────────────────────────────────────────

describe('resolveAdaptationEndpoint (WO-A2 §2.2 chain)', () => {
    const utility = provider({ id: 'u', label: 'Utility' });
    const auxiliary = provider({ id: 'x', label: 'Auxiliary' });
    const summarizer = provider({ id: 's', label: 'Summarizer' });
    const story = provider({ id: 'y', label: 'Story' });
    const none = () => undefined;

    it('prefers utility, then auxiliary, then summarizer, then story', () => {
        expect(resolveAdaptationEndpoint({ utility: () => utility, auxiliary: () => auxiliary, summarizer: () => summarizer, story: () => story })?.id).toBe('u');
        expect(resolveAdaptationEndpoint({ utility: none, auxiliary: () => auxiliary, summarizer: () => summarizer, story: () => story })?.id).toBe('x');
        expect(resolveAdaptationEndpoint({ utility: none, auxiliary: none, summarizer: () => summarizer, story: () => story })?.id).toBe('s');
        expect(resolveAdaptationEndpoint({ utility: none, auxiliary: none, summarizer: none, story: () => story })?.id).toBe('y');
        expect(resolveAdaptationEndpoint({ utility: none, auxiliary: none, summarizer: none, story: none })).toBeUndefined();
    });

    it('describes the endpoint for the Review step, with fallbacks for blanks', () => {
        expect(describeAdaptationEndpoint(provider({ label: 'Utility', modelName: 'tiny-3b' }))).toEqual({ label: 'Utility', modelName: 'tiny-3b' });
        expect(describeAdaptationEndpoint(provider({ label: '', modelName: '' }))).toEqual({ label: 'Unnamed endpoint', modelName: 'unknown model' });
    });
});

// ─── makeModelCaller ─────────────────────────────────────────────────────────

describe('makeModelCaller (streaming sendMessage, never llmCall)', () => {
    beforeEach(() => { mockedSend.mockReset(); });

    it('resolves with the final content and inherits sampling + thinking effort', async () => {
        mockedSend.mockImplementation(async (_p, _m, onChunk, onDone) => {
            onChunk('Keep');
            onDone('Keep the shop open.');
        });
        const call = makeModelCaller(provider());
        await expect(call([{ role: 'user', content: 'hi' }], new AbortController().signal)).resolves.toBe('Keep the shop open.');

        const args = mockedSend.mock.calls[0];
        expect(args[5]).toBeUndefined();               // tools
        expect(args[6]).toBeInstanceOf(AbortController); // its own controller
        expect(args[7]).toBeUndefined();               // sampling — inherit
        expect(args[8]).toBeUndefined();               // thinkingEffort — inherit the provider
        expect(args[9]).toBe('st-import-adaptation');  // trackingLabel
    });

    it('honors a custom tracking label', async () => {
        mockedSend.mockImplementation(async (_p, _m, _c, onDone) => { onDone('ok'); });
        await makeModelCaller(provider(), { trackingLabel: 'retry-pass' })([{ role: 'user', content: 'hi' }], new AbortController().signal);
        expect(mockedSend.mock.calls[0][9]).toBe('retry-pass');
    });

    it('rejects on a transport error', async () => {
        mockedSend.mockImplementation(async (_p, _m, _c, _d, onError) => { onError('endpoint refused the connection'); });
        const call = makeModelCaller(provider());
        await expect(call([{ role: 'user', content: 'hi' }], new AbortController().signal))
            .rejects.toThrow('endpoint refused the connection');
    });

    it('rejects and aborts the underlying controller when the caller aborts mid-call', async () => {
        mockedSend.mockImplementation(async () => { /* never settles */ });
        const controller = new AbortController();
        const call = makeModelCaller(provider());
        const promise = call([{ role: 'user', content: 'hi' }], controller.signal);
        controller.abort();
        await expect(promise).rejects.toThrow('aborted');
        const inner = mockedSend.mock.calls[0][6] as AbortController;
        expect(inner.signal.aborted).toBe(true);
    });

    it('never calls the model at all on an already-aborted signal', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(makeModelCaller(provider())([{ role: 'user', content: 'hi' }], controller.signal)).rejects.toThrow('aborted');
        expect(mockedSend).not.toHaveBeenCalled();
    });

    it('rejects when sendMessage itself throws', async () => {
        mockedSend.mockImplementation(async () => { throw new Error('boom'); });
        await expect(makeModelCaller(provider())([{ role: 'user', content: 'hi' }], new AbortController().signal))
            .rejects.toThrow('boom');
    });
});

// ─── runAdaptation ───────────────────────────────────────────────────────────

describe('runAdaptation (WO-C §9.3 — batched, isolated, cancellable)', () => {
    const three = [target('a', 'Aria'), target('b', 'Bran'), target('c', 'Cass')];

    it('returns exactly one result per target, in target order', async () => {
        const results = await runAdaptation(three, { callModel: echoModel }, { importId: 'imp-1' });
        expect(results.map(r => r.id)).toEqual(['a', 'b', 'c']);
        expect(results.every(r => r.status === 'adapted')).toBe(true);
        expect(results[0].wants!.long).toBe('Keep the shop open through the winter.');
    });

    it('keeps target order even when the model answers out of order', async () => {
        const reversing: AdaptationModelCall = async (messages) => {
            const ids = idsInPrompt(messages.find(m => m.role === 'user')?.content ?? '').reverse();
            return JSON.stringify(ids.map(id => ({ id, short: ['rest'], medium: ['earn a wage'], long: 'Stay put.' })));
        };
        const results = await runAdaptation(three, { callModel: reversing }, { importId: 'imp-1' });
        expect(results.map(r => r.id)).toEqual(['a', 'b', 'c']);
    });

    it('returns nothing for no targets and never calls the model', async () => {
        const callModel = vi.fn(echoModel);
        await expect(runAdaptation([], { callModel }, { importId: 'imp-1' })).resolves.toEqual([]);
        expect(callModel).not.toHaveBeenCalled();
    });

    it('isolates a failing batch — the other batches still land', async () => {
        let call = 0;
        const flaky: AdaptationModelCall = async (messages) => {
            call += 1;
            if (call === 2) throw new Error('502 Bad Gateway from the endpoint');
            return echoModel(messages, new AbortController().signal);
        };
        const results = await runAdaptation(three, { callModel: flaky }, { importId: 'imp-1', batchTokenBudget: 1 });
        expect(results.map(r => r.status)).toEqual(['adapted', 'failed', 'adapted']);
        expect(results[1].error).toContain('502 Bad Gateway');
        expect(results[1].wants).toBeUndefined();
    });

    it('cancels every remaining NPC when the signal is aborted before a batch starts', async () => {
        const controller = new AbortController();
        let call = 0;
        const model: AdaptationModelCall = async (messages) => {
            call += 1;
            if (call === 1) controller.abort();
            return echoModel(messages, controller.signal);
        };
        const results = await runAdaptation(three, { callModel: model, signal: controller.signal }, { importId: 'imp-1', batchTokenBudget: 1 });
        expect(results.map(r => r.status)).toEqual(['adapted', 'cancelled', 'cancelled']);
        expect(call).toBe(1);
    });

    it('cancels every NPC when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        const callModel = vi.fn(echoModel);
        const results = await runAdaptation(three, { callModel, signal: controller.signal }, { importId: 'imp-1' });
        expect(results.map(r => r.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
        expect(callModel).not.toHaveBeenCalled();
    });

    it('marks the in-flight batch cancelled (not failed) when the abort lands mid-call', async () => {
        const controller = new AbortController();
        let call = 0;
        const model: AdaptationModelCall = async (messages) => {
            call += 1;
            if (call === 2) { controller.abort(); throw new Error('aborted'); }
            return echoModel(messages, controller.signal);
        };
        const results = await runAdaptation(three, { callModel: model, signal: controller.signal }, { importId: 'imp-1', batchTokenBudget: 1 });
        expect(results.map(r => r.status)).toEqual(['adapted', 'cancelled', 'cancelled']);
        expect(results[1].error).toBe('cancelled');
    });

    it('reports progress per batch and a result per NPC as soon as its batch resolves', async () => {
        const progress: AdaptationProgress[] = [];
        const seen: AdaptationResult[] = [];
        await runAdaptation(three, {
            callModel: echoModel,
            onProgress: p => progress.push(p),
            onResult: r => seen.push(r),
        }, { importId: 'imp-1', batchTokenBudget: 1 });

        expect(progress).toEqual([
            { done: 0, total: 3, batchIndex: 0, batchCount: 3, inFlight: ['Aria'] },
            { done: 1, total: 3, batchIndex: 1, batchCount: 3, inFlight: ['Bran'] },
            { done: 2, total: 3, batchIndex: 2, batchCount: 3, inFlight: ['Cass'] },
        ]);
        expect(seen.map(r => r.id)).toEqual(['a', 'b', 'c']);
        expect(seen.every(r => r.status === 'adapted')).toBe(true);
    });

    it('groups typical cards into one batch and names them all in flight', async () => {
        const progress: AdaptationProgress[] = [];
        await runAdaptation(three, { callModel: echoModel, onProgress: p => progress.push(p) }, { importId: 'imp-1' });
        expect(progress).toHaveLength(1);
        expect(progress[0]).toEqual({ done: 0, total: 3, batchIndex: 0, batchCount: 1, inFlight: ['Aria', 'Bran', 'Cass'] });
    });

    it('threads matureMode into the prompt, defaulting to the guarded wording', async () => {
        const systems: string[] = [];
        const spy: AdaptationModelCall = async (messages) => {
            systems.push(messages.find(m => m.role === 'system')?.content ?? '');
            return echoModel(messages, new AbortController().signal);
        };

        await runAdaptation(three, { callModel: spy }, { importId: 'imp-1', matureMode: true });
        expect(systems[0]).not.toContain('non-explicit');

        await runAdaptation(three, { callModel: spy }, { importId: 'imp-1', matureMode: false });
        expect(systems[1]).toContain('non-explicit');

        await runAdaptation(three, { callModel: spy }, { importId: 'imp-1' });
        expect(systems[2]).toContain('non-explicit');
    });

    it('sends the import id and no lorebook text to the model', async () => {
        const sent: string[] = [];
        const spy: AdaptationModelCall = async (messages) => {
            sent.push(messages.map(m => m.content).join('\n'));
            return echoModel(messages, new AbortController().signal);
        };
        const withBook = [target('a', 'Aria', {
            description: 'A tailor.',
            character_book: { entries: [{ keys: ['x'], secondary_keys: [], content: 'LOREBOOKMARKER', comment: '', constant: false, enabled: true, insertion_order: 0 }] },
        })];
        await runAdaptation(withBook, { callModel: spy }, { importId: 'imp-42' });
        expect(sent[0]).toContain('imp-42');
        expect(sent[0]).not.toContain('LOREBOOKMARKER');
    });

    it('retrying is just another run over the failed targets', async () => {
        const failing: AdaptationModelCall = async () => { throw new Error('offline'); };
        const first = await runAdaptation(three, { callModel: failing }, { importId: 'imp-1' });
        expect(first.every(r => r.status === 'failed')).toBe(true);

        const retryTargets = three.filter(t => first.some(r => r.id === t.id && r.status === 'failed'));
        const second = await runAdaptation(retryTargets, { callModel: echoModel }, { importId: 'imp-1' });
        expect(second.map(r => r.status)).toEqual(['adapted', 'adapted', 'adapted']);
    });
});
