import { describe, it, expect } from 'vitest';
import { buildPayload } from '../payloadBuilder';
import { DEFAULT_RULES } from '../defaultRules';
import type { GameContext, AppSettings } from '../../types';

const baseContext = (): GameContext => ({
    loreRaw: '',
    rulesRaw: '',
    canonState: '',
    headerIndex: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    inventoryLastScene: 'Never',
    characterProfile: '',
    characterProfileLastScene: 'Never',
    surpriseDC: 95,
    encounterDC: 198,
    worldEventDC: 498,
    canonStateActive: false,
    headerIndexActive: false,
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    surpriseEngineActive: true,
    encounterEngineActive: true,
    worldEngineActive: true,
    diceFairnessActive: true,
    sceneNote: '',
    sceneNoteActive: false,
    sceneNoteDepth: 3,
    diceConfig: { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 },
    surpriseConfig: { initialDC: 95, dcReduction: 3, types: [], tones: [] },
    encounterConfig: { initialDC: 198, dcReduction: 2, types: [], tones: [] },
    worldVibe: '',
    enemyPlayerActive: false,
    neutralPlayerActive: false,
    allyPlayerActive: false,
    enemyPlayerPrompt: '',
    neutralPlayerPrompt: '',
    allyPlayerPrompt: '',
    interventionChance: 25,
    enemyCooldown: 2,
    neutralCooldown: 2,
    allyCooldown: 2,
    interventionQueue: [],
    notebook: [],
    notebookActive: true,
    worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
} as GameContext);

const baseSettings = (): AppSettings => ({
    debugMode: true,
    contextLimit: 8192,
} as unknown as AppSettings);

describe('buildPayload — default rules fallback', () => {
    it('injects DEFAULT_RULES when rulesRaw is empty', () => {
        const ctx = baseContext();
        ctx.rulesRaw = '';
        const result = buildPayload(baseSettings(), ctx, [], 'I look around');
        const firstSystem = result.messages.find(m => m.role === 'system');
        expect(firstSystem).toBeDefined();
        expect(firstSystem!.content).toContain('<SYS>');
        expect(firstSystem!.content).toContain('Impartial GM');
    });

    it('uses user-provided rulesRaw instead of DEFAULT_RULES', () => {
        const ctx = baseContext();
        ctx.rulesRaw = '# My Custom Rules\nNo magic allowed.';
        const result = buildPayload(baseSettings(), ctx, [], 'I look around');
        const firstSystem = result.messages.find(m => m.role === 'system');
        expect(firstSystem).toBeDefined();
        expect(firstSystem!.content).toContain('My Custom Rules');
        expect(firstSystem!.content).not.toContain(DEFAULT_RULES);
    });

    it('DEFAULT_RULES contains all expected sections', () => {
        expect(DEFAULT_RULES).toContain('<OUTPUT_RULES>');
        expect(DEFAULT_RULES).toContain('<NPC_ENGINE>');
        expect(DEFAULT_RULES).toContain('<NAME_GEN>');
        expect(DEFAULT_RULES).toContain('<LORE_TOOL>');
        expect(DEFAULT_RULES).toContain('<ACTION_RESOLUTION>');
        expect(DEFAULT_RULES).toContain('<EVENT_PROTOCOL>');
    });
});