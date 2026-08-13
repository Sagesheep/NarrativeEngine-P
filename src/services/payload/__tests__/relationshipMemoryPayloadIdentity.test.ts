import { describe, expect, it } from 'vitest';
import { buildPayload } from '../payloadBuilder';
import type { AppSettings, GameContext } from '../../../types';

const baseContext = (relationshipMemory: boolean): GameContext => ({
    loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '',
    starter: '', continuePrompt: '', inventory: '', inventoryLastScene: 'Never',
    characterProfile: '', characterProfileLastScene: 'Never',
    canonStateActive: false, headerIndexActive: false,
    starterActive: false, continuePromptActive: false,
    inventoryActive: false, characterProfileActive: false,
    surpriseEngineActive: true, encounterEngineActive: true,
    worldEngineActive: true, diceFairnessActive: true,
    sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 3,
    worldVibe: '', notebook: [], notebookActive: true,
    relationshipMemory,
} as GameContext);

const baseSettings = (): AppSettings => ({
    debugMode: true,
    contextLimit: 8192,
} as unknown as AppSettings);

describe('relationship memory payload isolation', () => {
    it('keeps the story payload byte-identical with the flag off and on', () => {
        const withoutFeature = buildPayload({
            settings: baseSettings(), context: baseContext(false), history: [], userMessage: 'I greet Elara.',
        });
        const withFeature = buildPayload({
            settings: baseSettings(), context: baseContext(true), history: [], userMessage: 'I greet Elara.',
        });

        expect(JSON.stringify(withFeature.messages)).toBe(JSON.stringify(withoutFeature.messages));
    });
});