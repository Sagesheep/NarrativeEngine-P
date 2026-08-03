// Phase 0.5 — Zero-mod base-app gate fixture.
//
// A fresh, fixed, minimal campaign that exercises payload construction and
// post-turn persistence without exercising any subsystem the gate does not
// own. One player message + one deterministic GM completion + a pending-turn
// commit. No NPC ledger entries, no chapters, no timeline, no archive index —
// the smallest shape that still flows through the real runTurn + commit
// pipeline and writes a scene to the (mocked) archive API.
//
// Fixture discipline (Phase 0.5 §3): this is a TEST ARTIFACT, not campaign
// data. No user campaign may be read or written. The campaign id is fixed
// and never collides with anything on disk.

import type {
    AppSettings,
    GameContext,
    ChatMessage,
    CondenserState,
    EndpointConfig,
    NPCEntry,
    ArchiveIndexEntry,
    TimelineEvent,
    DivergenceRegister,
    ArchiveChapter,
    PinnedExcerpt,
    LoreChunk,
} from '../../../../types';

export const FIXTURE_CAMPAIGN_ID = 'camp-base-app-gate';
export const FIXTURE_USER_MESSAGE = 'I step through the tavern door, scanning the room for trouble.';
export const FIXTURE_GM_COMPLETION =
    'Scene #001 | 📍 [The Crossed Swords Tavern] | 👥 [Present]\n\n' +
    'The common room is half-empty at this hour. A fire crackles low. The barkeep ' +
    'polishes a tankard without looking up. You smell woodsmoke and old ale.';

export const FIXTURE_NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20Z — fixed
export const FIXTURE_SCENE_ID = '001';

export function fixtureSettings(): AppSettings {
    return {
        presets: [],
        activePresetId: '',
        providers: [],
        contextLimit: 4096,
        debugMode: false,
        aiTier: 'pro',
        matureMode: false,
        rulesBudgetPct: 10,
        autoCondenseEnabled: false,
        autoArchiveStaleNPCsTurns: 0,
        moduleEnabled: {},
    } as unknown as AppSettings;
}

export function fixtureContext(): GameContext {
    return {
        loreRaw: '',
        rulesRaw: '',
        canonState: 'The kingdom of Alderia lies east of the Spine.',
        headerIndex: 'CHAPTER 1 — The Road.',
        starter: 'You stand at a crossroads.',
        continuePrompt: 'What do you do?',
        inventory: 'A worn sword; a healing draught.',
        inventoryLastScene: '',
        characterProfile: 'Kael, ranger. Tall, quiet, scarred.',
        characterProfileLastScene: '',
        canonStateActive: true,
        headerIndexActive: true,
        starterActive: true,
        continuePromptActive: true,
        inventoryActive: true,
        characterProfileActive: false,
        surpriseEngineActive: true,
        encounterEngineActive: true,
        worldEngineActive: true,
        diceFairnessActive: true,
        sceneNote: '',
        sceneNoteActive: false,
        sceneNoteDepth: 3,
        // diceSystem null = legacy d20 pool path (rollDiceFairnessLegacy).
        // The new generalized path needs DieType[] + DiceCategory[]; using
        // null keeps the fixture minimal and exercises the legacy code path
        // the gate is meant to freeze.
        diceSystem: null as unknown as GameContext['diceSystem'],
        diceConfig: { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 },
        surpriseConfig: { initialDC: 95, dcReduction: 3, types: [], tones: [] },
        encounterConfig: { initialDC: 198, dcReduction: 2, types: [], tones: [] },
        worldVibe: 'Grim, hopeful.',
        notebook: [],
        notebookActive: false,
        worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
        agencyDigest: '',
        arcDigest: '',
    } as GameContext;
}

export function fixtureHistory(): ChatMessage[] {
    return [
        { id: 'hist-user-1', role: 'user', content: 'I enter the tavern.', timestamp: 1 } as ChatMessage,
        { id: 'hist-gm-1', role: 'assistant', content: 'The tavern keeper eyes you warily.', timestamp: 2, sceneId: '000' } as ChatMessage,
    ];
}

export function fixtureNpcLedger(): NPCEntry[] {
    return [];
}

export function fixtureLoreChunks(): LoreChunk[] {
    return [];
}

export function fixtureArchiveIndex(): ArchiveIndexEntry[] {
    return [
        { sceneId: '000', timestamp: 1, keywords: ['tavern'], npcsMentioned: [], witnesses: [], userSnippet: 'I enter the tavern.' } as ArchiveIndexEntry,
    ];
}

export function fixtureTimeline(): TimelineEvent[] {
    return [];
}

export function fixtureChapters(): ArchiveChapter[] {
    return [
        {
            chapterId: 'CH01',
            title: 'The Road',
            sceneRange: ['000', '000'],
            sceneIds: ['000'],
            summary: '',
            keywords: [],
            npcs: [],
            majorEvents: [],
            unresolvedThreads: [],
            tone: 'grim',
            themes: [],
            sceneCount: 1,
        } as ArchiveChapter,
    ];
}

export function fixtureDivergenceRegister(): DivergenceRegister {
    return {
        entries: [],
        chapterToggles: {},
        categoryToggles: {},
        lastUpdatedSceneId: '',
        lastUpdatedAt: 0,
        version: 2,
    };
}

export function fixturePinnedExcerpts(): PinnedExcerpt[] {
    return [];
}

export function fixtureCondenser(): CondenserState {
    return { condensedUpToIndex: 0 } as CondenserState;
}

export function fixtureProvider(): EndpointConfig {
    return {
        endpoint: 'http://localhost:11434/v1/chat/completions',
        apiKey: 'test-key',
        modelName: 'test-gm-model',
    } as unknown as EndpointConfig;
}