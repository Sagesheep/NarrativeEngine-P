import { describe, it, expect } from 'vitest';
import {
    parseCustomQuestions,
    applyCustomQuestions,
    customQuestionsTemplate,
} from '../aiGuidedGeneration';
import type { CharacterCreationDraft } from '../../../types';

const seven = ['Q-a', 'Q-b', 'Q-c', 'Q-d', 'Q-e', 'Q-f', 'Q-g'];

function expectAll(result: ReturnType<typeof parseCustomQuestions>) {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stockSlots).toEqual([]);
    expect([2, 3, 4, 5, 6, 7, 8].map(s => result.questions[s as 2])).toEqual(seven);
}

describe('parseCustomQuestions', () => {
    it('reads the same numbered format the AI outputs', () => {
        expectAll(parseCustomQuestions(seven.map((q, i) => `${i + 1}) ${q}`).join('\n')));
    });

    it('round-trips the template', () => {
        const r = parseCustomQuestions(customQuestionsTemplate());
        expect(r.ok && r.stockSlots).toEqual([]);
    });

    it('reads markdown lists, headings and bold numbers, skipping a title', () => {
        const md = [
            '# My questionnaire',
            '',
            ...seven.map((q, i) => (i % 3 === 0 ? `## ${i + 1}. ${q}` : i % 3 === 1 ? `- **${i + 1}.** ${q}` : `${i + 1}. ${q}`)),
        ].join('\n');
        expectAll(parseCustomQuestions(md));
    });

    it('joins wrapped lines onto the question above', () => {
        const r = parseCustomQuestions('1) Where are you from?\nFor instance the Iron Ward.\n2) Who do you serve?');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.questions[2]).toBe('Where are you from? For instance the Iron Ward.');
        expect(r.questions[3]).toBe('Who do you serve?');
    });

    it('reads JSON arrays, numbered objects and { questions }', () => {
        expectAll(parseCustomQuestions(JSON.stringify(seven)));
        expectAll(parseCustomQuestions(JSON.stringify({ questions: seven.map(question => ({ question })) })));
        expectAll(parseCustomQuestions('```json\n' + JSON.stringify(Object.fromEntries(seven.map((q, i) => [String(i + 1), q]))) + '\n```'));
    });

    it('treats a 2–8 list with no 1 as slot numbers', () => {
        expectAll(parseCustomQuestions(seven.map((q, i) => `${i + 2}) ${q}`).join('\n')));
    });

    it('reads plain unnumbered lines in order', () => {
        expectAll(parseCustomQuestions(seven.join('\n')));
    });

    it('keeps stock wording for missing questions', () => {
        const r = parseCustomQuestions('1) Custom origin\n4) Custom bearing');
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.questions[2]).toBe('Custom origin');
        expect(r.questions[5]).toBe('Custom bearing');
        expect(r.stockSlots).toEqual([3, 4, 6, 7, 8]);
        expect(r.questions[3]).toMatch(/allegiance/i);
    });

    it('rejects empty input and too many unnumbered lines', () => {
        expect(parseCustomQuestions('   ').ok).toBe(false);
        expect(parseCustomQuestions([...seven, 'extra'].join('\n')).ok).toBe(false);
    });
});

describe('applyCustomQuestions', () => {
    it('fills the draft like the AI path and keeps answers', () => {
        const base = { name: 'Ash', questions: {}, answers: { 2: 'kept' } } as unknown as CharacterCreationDraft;
        const r = parseCustomQuestions(JSON.stringify(seven));
        if (!r.ok) throw new Error('parse');
        const d = applyCustomQuestions(base, r.questions);
        expect(d.questions?.[1]).toMatch(/name/i);
        expect(d.questions?.[9]).toMatch(/appearance/i);
        expect(d.questions?.[8]).toBe('Q-g');
        expect(d.answers?.[2]).toBe('kept');
    });
});
