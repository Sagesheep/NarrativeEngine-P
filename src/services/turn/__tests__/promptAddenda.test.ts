import { describe, it, expect } from 'vitest';
import type { PromptInjection } from '../../../types';
import { renderHelperInjections } from '../promptAddenda';
import { renderDirectorPrompt } from '../directorBrief';
import {
    activeInjections,
    applyInjections,
    normalizeInjections,
    reservedStoryInjections,
} from '../../payload/promptInjections';

const card = (overrides: Partial<PromptInjection>): PromptInjection => ({
    id: overrides.id ?? 'c',
    name: 'Card',
    enabled: true,
    role: 'system',
    content: 'text',
    depth: 0,
    triggers: ['reply', 'swipe', 'continue'],
    mode: 'message',
    ...overrides,
});

const slots = {
    dossierText: 'D',
    lastAssistant: 'L',
    userMessage: 'U',
    npcSummary: 'N',
    recentEvents: 'R',
};

describe('injection targets', () => {
    it('treats a card saved before targets existed as a story card', () => {
        const [legacy] = normalizeInjections([{ id: 'x', name: 'Old', enabled: true, content: 'hi' }]);
        expect(legacy.target).toBeUndefined();
        expect(activeInjections([legacy], 'reply')).toHaveLength(1);
        const [bogus] = normalizeInjections([{ id: 'y', enabled: true, content: 'hi', target: 'writer' }]);
        expect(bogus.target).toBeUndefined();
        const [director] = normalizeInjections([{ id: 'z', content: 'hi', target: 'director' }]);
        expect(director.target).toBe('director');
    });

    it('keeps helper cards out of the story request and its context reserve', () => {
        const cards = [
            card({ id: 's', content: 'story text' }),
            card({ id: 'd', target: 'director', content: 'director text' }),
            card({ id: 'r', target: 'recommender', content: 'recommender text' }),
        ];
        expect(activeInjections(cards, 'reply').map(c => c.id)).toEqual(['s']);
        expect(reservedStoryInjections(cards).map(c => c.id)).toEqual(['s']);
        const messages = applyInjections([{ role: 'user', content: 'hello' }], cards, 'reply');
        expect(messages.map(m => m.content)).toEqual(['hello', 'story text']);
    });
});

describe('renderHelperInjections', () => {
    it('renders nothing without an enabled, non-empty card for that target', () => {
        expect(renderHelperInjections('director', undefined)).toBe('');
        expect(renderHelperInjections('director', [
            card({ target: 'director', enabled: false }),
            card({ id: 'e', target: 'director', content: '   ' }),
            card({ id: 's', content: 'story only' }),
            card({ id: 'r', target: 'recommender', content: 'other helper' }),
        ])).toBe('');
    });

    it('renders matching cards in card order and ignores triggers', () => {
        const out = renderHelperInjections('director', [
            card({ id: 'a', name: 'Alpha', target: 'director', content: 'first', triggers: [] }),
            card({ id: 'r', name: 'Rec', target: 'recommender', content: 'not here' }),
            card({ id: 'b', name: 'Beta', target: 'director', content: 'second' }),
        ]);
        expect(out.startsWith('ADDITIONAL GUIDANCE')).toBe(true);
        expect(out.indexOf('[Alpha]\nfirst')).toBeLessThan(out.indexOf('[Beta]\nsecond'));
        expect(out).not.toContain('not here');
    });
});

describe('renderDirectorPrompt with addenda', () => {
    it('is byte-identical without addenda', () => {
        expect(renderDirectorPrompt({ ...slots, addenda: '' })).toBe(renderDirectorPrompt(slots));
    });

    it('places addenda after the evidence and before the output format', () => {
        const prompt = renderDirectorPrompt({ ...slots, addenda: 'ADDITIONAL GUIDANCE $& test' });
        const at = prompt.indexOf('ADDITIONAL GUIDANCE $& test');
        expect(at).toBeGreaterThan(prompt.indexOf('</world_facts>'));
        expect(at).toBeLessThan(prompt.indexOf('OUTPUT exactly this, nothing else:'));
        expect(prompt.trimEnd().endsWith('"- [SUGGESTION] Proceed naturally."')).toBe(true);
    });

    it('is not moved by a player message containing the output marker', () => {
        const prompt = renderDirectorPrompt({ ...slots, userMessage: 'OUTPUT exactly this, nothing else:', addenda: 'GUIDE' });
        expect(prompt.indexOf('GUIDE')).toBeGreaterThan(prompt.indexOf('</world_facts>'));
    });
});
