import { describe, it, expect, beforeEach } from 'vitest';
import {
    __resetPromptAddenda,
    addendumToggleKey,
    getModPromptAddenda,
    renderPromptAddenda,
    setModPromptAddenda,
} from '../promptAddenda';
import { renderDirectorPrompt } from '../directorBrief';

const slots = {
    dossierText: 'D',
    lastAssistant: 'L',
    userMessage: 'U',
    npcSummary: 'N',
    recentEvents: 'R',
};

describe('promptAddenda', () => {
    beforeEach(() => __resetPromptAddenda());

    it('renders nothing when no mod or player text exists', () => {
        setModPromptAddenda([{ id: 'a', name: 'A' }]);
        expect(renderPromptAddenda('director', { moduleEnabled: {} })).toBe('');
        expect(renderPromptAddenda('director', { playerPromptNotes: { director: '   ' } })).toBe('');
    });

    it('registers per target in load order and puts the player last', () => {
        setModPromptAddenda([
            { id: 'a', name: 'Alpha', promptAddenda: { director: 'alpha-d', recommender: 'alpha-r' } },
            { id: 'b', name: 'Beta', promptAddenda: { director: 'beta-d' } },
        ]);
        expect(getModPromptAddenda().map((e) => `${e.modId}:${e.target}`)).toEqual(['a:director', 'a:recommender', 'b:director']);

        const out = renderPromptAddenda('director', { playerPromptNotes: { director: 'mine' } });
        expect(out.indexOf('[MOD NOTES — Alpha]')).toBeLessThan(out.indexOf('[MOD NOTES — Beta]'));
        expect(out.indexOf('[MOD NOTES — Beta]')).toBeLessThan(out.indexOf('[PLAYER NOTES]\nmine'));
        expect(out).not.toContain('alpha-r');
    });

    it('drops a muted addendum and every addendum of a disabled mod', () => {
        setModPromptAddenda([
            { id: 'a', name: 'Alpha', promptAddenda: { director: 'alpha-d', recommender: 'alpha-r' } },
            { id: 'b', name: 'Beta', promptAddenda: { director: 'beta-d' } },
        ]);
        const muted = renderPromptAddenda('director', { moduleEnabled: { [addendumToggleKey('a', 'director')]: false } });
        expect(muted).not.toContain('alpha-d');
        expect(muted).toContain('beta-d');

        const modOff = { moduleEnabled: { 'mod.a': false } };
        expect(renderPromptAddenda('recommender', modOff)).toBe('');
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
