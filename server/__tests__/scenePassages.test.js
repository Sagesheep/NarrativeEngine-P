import { describe, it, expect, vi, beforeEach } from 'vitest';

// The model is replaced by a recorder: the tests check WHAT gets embedded.
const seen = vi.hoisted(() => ({ inputs: [] }));
vi.mock('@huggingface/transformers', () => ({
    pipeline: async () => async (texts) => {
        seen.inputs.push(...texts);
        return { data: new Float32Array(texts.length * 4) };
    },
}));

const { buildScenePassages, embedQuery, embedText } = await import('../lib/embedder.js');

const STATUS = 'Scene #533 | 📅 Saturday, ~Ninth Bell, Day 1,324 | 📍 Soll Estate, Study | 👥 [**Rin**], [**Therese Soll**]';

describe('buildScenePassages', () => {
    it('embeds the prose: player message, then the GM reply, with markup and roll lines removed', () => {
        const gm = [
            STATUS, '', '---', '',
            '[SOCIAL: Normal: Failure | KNOWLEDGE: Normal: Success]', '', '---', '',
            '[**Therese Soll**]: "Fusion." She leans **forward**.', '',
            '| Field | Detail |', '|---|---|', '| **Local Contact** | [**Maren Solweggin**] |', '',
            '**In exchange:** Grey shares his findings first.',
        ].join('\n');
        const [passage, ...rest] = buildScenePassages('I ask about the *still*.', gm);

        expect(rest).toEqual([]);
        expect(passage).toBe([
            'Soll Estate, Study — Rin, Therese Soll',
            'Player: I ask about the still.',
            '',
            'Therese Soll: "Fusion." She leans forward.',
            '',
            '| Field | Detail |',
            '| Local Contact | Maren Solweggin |',
            '',
            'In exchange: Grey shares his findings first.',
        ].join('\n'));
    });

    it('packs paragraphs into passages of at most 1,500 characters, each led by the context line', () => {
        const para = 'x'.repeat(700);
        const passages = buildScenePassages('go', [STATUS, '', para, '', para, '', para, '', para].join('\n'));

        expect(passages.length).toBe(2);
        for (const p of passages) {
            expect(p.startsWith('Soll Estate, Study — Rin, Therese Soll\n')).toBe(true);
            expect(p.length - 'Soll Estate, Study — Rin, Therese Soll\n'.length).toBeLessThanOrEqual(1500);
        }
        expect(passages.join('').split('x').length - 1).toBe(2800); // nothing dropped
    });

    it('splits an over-long paragraph at sentence ends, and the end of the scene is still embedded', () => {
        const sentence = 'Rin weighs the offer in silence. ';
        const long = sentence.repeat(80).trim(); // ~2,600 characters, one paragraph
        const passages = buildScenePassages('', `${long}\n\nTherese offers a letter in exchange for the findings.`);

        expect(passages.length).toBeGreaterThan(1);
        expect(passages.every(p => p.length <= 1500)).toBe(true);
        expect(passages.at(-1)).toContain('in exchange for the findings');
    });

    it('without a status line there is no context line, and an empty scene has no passages', () => {
        expect(buildScenePassages('hello', 'The rain falls.')).toEqual(['Player: hello\n\nThe rain falls.']);
        expect(buildScenePassages('', '')).toEqual([]);
    });

    it('adds one cast card naming the scene\'s people, de-duplicated, after the prose', () => {
        expect(buildScenePassages('hello', 'The rain falls.', ['Rin', 'Helena Broadmarsh', 'Rin', ' '])).toEqual([
            'Player: hello\n\nThe rain falls.',
            'Rin, Helena Broadmarsh',
        ]);
        expect(buildScenePassages('', '', ['Rin'])).toEqual(['Rin']);
    });

    it('caps a very long scene at 16 passages', () => {
        const paras = Array.from({ length: 40 }, (_, i) => `${i} ${'y'.repeat(1200)}`).join('\n\n');
        expect(buildScenePassages('', paras).length).toBe(16);
    });
});

describe('embedQuery', () => {
    beforeEach(() => { seen.inputs.length = 0; });

    it('prefixes the retrieval instruction the model expects on queries', async () => {
        await embedQuery('what did we promise Therese?');
        expect(seen.inputs).toEqual(['Represent this sentence for searching relevant passages: what did we promise Therese?']);
    });

    it('passages are embedded without it', async () => {
        await embedText('Therese offers a letter.');
        expect(seen.inputs).toEqual(['Therese offers a letter.']);
    });

    it('an empty query embeds nothing', async () => {
        const vec = await embedQuery('   ');
        expect(seen.inputs).toEqual([]);
        expect(vec.every(v => v === 0)).toBe(true);
    });
});
