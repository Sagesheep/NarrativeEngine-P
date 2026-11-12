import { afterEach, describe, expect, it } from 'vitest';
import { buildPayload } from '../../payload/payloadBuilder';
import { createFinalUserRegistry } from '../../payload/contributions/builtins';
import { setExtensionModules } from '../../payload/contributions/extensions';
import { buildCombatNoteRegistry, makeCombatNote } from '../combatTurnNotes';
import type { AppSettings, GameContext } from '../../../types';
import type { OpenAIMessage } from '../../llm/llmService';

const context = (): GameContext => ({
    loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '', starter: '', continuePrompt: '',
    inventory: '', inventoryLastScene: 'Never', characterProfile: '', characterProfileLastScene: 'Never',
    canonStateActive: false, headerIndexActive: false, starterActive: false, continuePromptActive: false,
    inventoryActive: false, characterProfileActive: false, surpriseEngineActive: true, encounterEngineActive: true,
    worldEngineActive: true, diceFairnessActive: true, sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 3,
    worldVibe: '', notebook: [], notebookActive: true,
} as unknown as GameContext);

const settings = { debugMode: false, contextLimit: 8192 } as unknown as AppSettings;

const finalUser = (messages: OpenAIMessage[]) => String(messages[messages.length - 1].content);

function probeRegistry() {
    const registry = createFinalUserRegistry();
    registry.register({
        id: 'test.probe', name: 'probe', description: '', source: 'builtin', defaultEnabled: true,
        produce: (input) => [{ id: 'test.probe', slot: 'final-user', order: 900, source: 'builtin', text: `PROBE inCombat=${String(input.facts?.inCombat)}` }],
    });
    return registry;
}

afterEach(() => setExtensionModules([]));

describe('inCombat host value (A9)', () => {
    it('is false by default and true while an engine fight is active', () => {
        const base = { settings, context: context(), history: [], userMessage: 'hi', finalUserRegistry: probeRegistry() };
        expect(finalUser(buildPayload(base).messages)).toContain('PROBE inCombat=false');
        expect(finalUser(buildPayload({ ...base, engineCombatActive: true }).messages)).toContain('PROBE inCombat=true');
    });

    it('a mod with no opinion leaves the host value, and a claimed value still wins', () => {
        const base = { settings, context: context(), history: [], userMessage: 'hi', finalUserRegistry: probeRegistry(), engineCombatActive: true };
        const noOpinion = buildPayload({ ...base, publishedFacts: { facts: {}, conflicts: [] } });
        expect(finalUser(noOpinion.messages)).toContain('PROBE inCombat=true');
        const claimed = buildPayload({ ...base, publishedFacts: { facts: { inCombat: false }, conflicts: [] } });
        expect(finalUser(claimed.messages)).toContain('PROBE inCombat=false');
    });

    it('leaves the payload byte-identical when engineCombatActive is absent or false', () => {
        const base = { settings, context: context(), history: [], userMessage: 'hi' };
        expect(JSON.stringify(buildPayload({ ...base, engineCombatActive: false }).messages)).toBe(JSON.stringify(buildPayload(base).messages));
    });
});

describe('combat notes contribution', () => {
    it('adds the aftermath below the cache boundary and keeps the cached prefix unchanged', () => {
        const plain = context();
        const withNote = { ...plain, combatAftermath: makeCombatNote('Outcome: victory.\nCasualties: Bandit (down).') };
        const before = buildPayload({ settings, context: plain, history: [], userMessage: 'I search the bodies.' }).messages;
        const after = buildPayload({ settings, context: withNote, history: [], userMessage: 'I search the bodies.', finalUserRegistry: buildCombatNoteRegistry(withNote) }).messages;
        expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
        const text = finalUser(after);
        expect(text).toContain('[COMBAT AFTERMATH]');
        expect(text).toContain('Do not replay or re-narrate the fight.');
        expect(text.indexOf('[COMBAT AFTERMATH]')).toBeLessThan(text.indexOf('I search the bodies.'));
        expect(finalUser(before)).not.toContain('COMBAT');
    });
});
