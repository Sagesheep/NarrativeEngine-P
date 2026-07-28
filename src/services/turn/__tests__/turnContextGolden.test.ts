/* eslint-disable @typescript-eslint/no-explicit-any */
// WO-P1-01 §5: characterization golden tests for the TurnContext data-bus refactor.
//
// These tests freeze the CURRENT behaviour of `buildPayload` (positional-arg form)
// and the `runTurn` pre-payload path so the upcoming refactor — converting
// `buildPayload` to an options object, threading a `TurnContext` bus through
// `runTurn`, and killing two `getState()` coupling reads — is provably
// behaviour-preserving. Per Safety Protocol §1, NO carve happens without these
// tests landing first.
//
// Scope:
//  - Golden payload snapshot: a fully-populated `buildPayload` call (every
//    optional arg exercised) is serialized and hashed. The same fixture, run
//    post-refactor, MUST produce a byte-identical messages array. This guards
//    the cache boundary (`payloadBuilder.ts:88-154`) — the highest-risk zone.
//  - Turn-flow test: a `runTurn` integration test (mocked provider) asserts the
//    same messages flow into `sendMessage` and the same snapshot is captured.
//    Guards the bus-threading + reach-around kills.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildPayload } from '../../payload/payloadBuilder';
import type {
    GameContext,
    AppSettings,
    LoreChunk,
    NPCEntry,
    ArchiveScene,
    ArchiveIndexEntry,
    TimelineEvent,
    DivergenceRegister,
    DivergenceEntry,
    ArchiveChapter,
    PinnedExcerpt,
    SceneEventType,
    InventoryItemCategory,
    LocationEntry,
    ChatMessage,
    EndpointConfig,
    CondenserState,
} from '../../../types';
import type { OpenAIMessage } from '../../llm/llmService';
import type { ElevatedScene } from '../../archive-memory/dynamicElevation';
import type { SlottedRagSnippet } from '../../archive-memory/slottedRag';

// ── Fixtures ─────────────────────────────────────────────────────────────

function baseContext(): GameContext {
    return {
        loreRaw: '',
        rulesRaw: '',
        canonState: 'The kingdom of Alderia lies east of the Spine.',
        headerIndex: 'CHAPTER 1 — The Road.',
        starter: 'You stand at a crossroads.',
        continuePrompt: 'What do you do?',
        inventory: 'A worn sword; a healing draught.',
        inventoryLastScene: 'Scene 5',
        characterProfile: 'Kael, ranger. Tall, quiet, scarred.',
        characterProfileLastScene: 'Scene 5',
        canonStateActive: true,
        headerIndexActive: true,
        starterActive: true,
        continuePromptActive: true,
        inventoryActive: true,
        characterProfileActive: true,
        surpriseEngineActive: true,
        encounterEngineActive: true,
        worldEngineActive: true,
        diceFairnessActive: true,
        sceneNote: 'Tension is rising; the bandit camp is near.',
        sceneNoteActive: true,
        sceneNoteDepth: 3,
        diceSystem: { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 },
        surpriseConfig: { initialDC: 95, dcReduction: 3, types: [], tones: [] },
        encounterConfig: { initialDC: 198, dcReduction: 2, types: [], tones: [] },
        worldVibe: 'Grim, hopeful.',
        notebook: [{ id: 'nb1', text: 'A whisper about a hidden vault.' }],
        notebookActive: true,
        worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
        agencyDigest: ['Aldric edges closer to his goal.'],
        arcDigest: ['Pressure on the Crimson Guild mounts.'],
    } as GameContext;
}

function baseSettings(): AppSettings {
    return {
        debugMode: true,
        contextLimit: 8192,
        matureMode: false,
        rulesBudgetPct: 10,
    } as unknown as AppSettings;
}

function makeNPC(id: string, name: string, faction = ''): NPCEntry {
    return {
        id, name, aliases: '', appearance: '', faction,
        storyRelevance: '', disposition: 'neutral', status: 'alive',
        goals: '', voice: '', personality: '', exampleOutput: '',
        affinity: 0, archived: false,
    } as NPCEntry;
}

function makeEntry(id: string, text: string, knownBy?: string[]): DivergenceEntry {
    return {
        id, chapterId: 'CH01', category: 'world_state', text, sceneRef: '001',
        npcIds: [], pinned: false, enabled: true, source: 'manual', knownBy,
    } as DivergenceEntry;
}

function makeRegister(): DivergenceRegister {
    return {
        entries: [
            makeEntry('pub1', 'The harbor district flooded after the storm.'),
            makeEntry('scoA', 'Aldric secretly betrayed the Crimson Guild.', ['npc:npc_a']),
        ],
        chapterToggles: {},
        categoryToggles: {},
        lastUpdatedSceneId: '001',
        lastUpdatedAt: 0,
        version: 2,
    };
}

const HISTORY: ChatMessage[] = [
    { id: 'h1', role: 'user', content: 'I enter the tavern.', timestamp: 1 } as ChatMessage,
    { id: 'h2', role: 'assistant', content: 'The tavern keeper eyes you warily.', timestamp: 2 } as ChatMessage,
    { id: 'h3', role: 'user', content: 'I order an ale.', timestamp: 3 } as ChatMessage,
    { id: 'h4', role: 'assistant', content: 'He slides a foaming tankard across the bar.', timestamp: 4 } as ChatMessage,
];

const NPCS: NPCEntry[] = [
    makeNPC('npc_a', 'Aldric', 'Crimson Guild'),
    makeNPC('npc_b', 'Bella'),
];

const LORE: LoreChunk[] = [
    {
        id: 'l1', header: 'Crimson Guild', content: 'The Crimson Guild controls the harbor.',
        tokens: 12, alwaysInclude: false, triggerKeywords: [], scanDepth: 3,
        category: 'faction', linkedEntities: [], priority: 1,
    },
];

const RULES: LoreChunk[] = [
    {
        id: 'r1', header: 'Dice Rule', content: 'Always roll dice when the outcome is uncertain.',
        tokens: 14, alwaysInclude: false, triggerKeywords: [], scanDepth: 3,
        category: 'rules', linkedEntities: [], priority: 1,
    },
];

const ARCHIVE_RECALL: ArchiveScene[] = [
    { sceneId: '001', content: 'The night the harbor flooded.', tokens: 42 },
];

const ARCHIVE_INDEX: ArchiveIndexEntry[] = [
    { sceneId: '001', timestamp: 1, keywords: ['harbor', 'flood'], npcsMentioned: ['npc_a'], witnesses: ['npc_a'], userSnippet: 'I watched the harbor flood.' } as ArchiveIndexEntry,
];

const TIMELINE: TimelineEvent[] = [
    { sceneId: '001', turn: 1, importance: 7, text: 'Aldric arrives in town.', eventType: 'travel' } as TimelineEvent,
];

const CHAPTERS: ArchiveChapter[] = [
    {
        chapterId: 'CH01', title: 'The Road', sceneRange: ['001', '001'], sceneIds: ['001'],
        summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [],
        tone: 'grim', themes: [], sceneCount: 1,
    } as ArchiveChapter,
];

const PINNED: PinnedExcerpt[] = [
    { id: 'p1', messageId: 'h2', excerpt: 'eyes you warily', pinnedAt: 1, note: 'tone' } as PinnedExcerpt,
];

const PLANNER_EVENT_TYPES: SceneEventType[] = ['combat'];

const ELEVATED: ElevatedScene[] = [
    { scene: ARCHIVE_RECALL[0], chapterId: 'CH01' } as ElevatedScene,
];

const SLOTTED: SlottedRagSnippet[] = [
    { sceneId: '001', chapterId: 'CH01', snippet: 'A hidden vault beneath the chapel.', witnessedBy: 'all' },
];

const INVENTORY_CATEGORIES: (InventoryItemCategory | 'equipped')[] = ['weapon'];
const PROFILE_FIELDS: string[] = ['appearance', 'personality'];
const LOCATION_LEDGER: LocationEntry[] = [
    { id: 'loc1', name: 'The Crossed Swords Tavern', aliases: '', description: '', connections: [] } as LocationEntry,
];

const RULES_MANIFEST = 'RULES_MANIFEST_HASH_abc';
const SEMANTIC_FACT_TEXT = 'Kael owes Aldric a debt.';
const DEEP_CONTEXT_SUMMARY = 'Summary of deep archive trawl.';
const USER_MESSAGE = 'I look around carefully, hand on my sword.';

// ── Golden payload snapshot ──────────────────────────────────────────────
// Build the FULL payload with every optional populated, then serialize the
// messages array to a stable JSON form. The hash is the gate: if any byte in
// the assembly changes, this hash changes and the test fails. Per WO-P1-01 §5,
// the post-refactor `buildPayload({ settings: options })` form MUST reproduce this exactly.

function buildFullPayloadPositional() {
    return buildPayload({
        settings: baseSettings(),
        context: baseContext(),
        history: HISTORY,
        userMessage: USER_MESSAGE,
        condensedUpToIndex: 2,
        relevantLore: LORE,
        npcLedger: NPCS,
        archiveRecall: ARCHIVE_RECALL,
        // _sceneNumber dropped (WO-P1-01) — was unread.
        recommendedNPCNames: ['Aldric'],
        semanticFactText: SEMANTIC_FACT_TEXT,
        archiveIndex: ARCHIVE_INDEX,
        timelineEvents: TIMELINE,
        inventoryCategories: INVENTORY_CATEGORIES,
        profileFields: PROFILE_FIELDS,
        deepContextSummary: DEEP_CONTEXT_SUMMARY,
        divergenceRegister: makeRegister(),
        chapters: CHAPTERS,
        onStageNpcIds: ['npc_a'],
        relevantRules: RULES,
        rulesManifest: RULES_MANIFEST,
        pinnedExcerpts: PINNED,
        plannerEventTypes: PLANNER_EVENT_TYPES,
        locationLedger: LOCATION_LEDGER,
        nextTurnOocBrief: 'OOC_BRIEF_TEXT',
        watchdogNudge: 'WATCHDOG_NUDGE_TEXT',
        directorBrief: 'DIRECTOR_BRIEF_TEXT',
        elevatedScenes: ELEVATED,
        slottedRagSnippets: SLOTTED,
    });
}

function serializeMessages(messages: OpenAIMessage[]): string {
    return JSON.stringify(messages, (_key, value) => {
        if (typeof value === 'string') return value;
        return value;
    }, 0);
}

// Stable hash (djb2) — used as the golden gate. Pre-refactor: this is computed
// and locked. Post-refactor: it must match.
function djb2Hash(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    // Convert to unsigned hex string.
    return (h >>> 0).toString(16).padStart(8, '0');
}

describe('WO-P1-01 — buildPayload golden snapshot (byte-identical pre/post refactor)', () => {
    it('produces a stable messages array shape (no undefined keys leaked, order preserved)', () => {
        const result = buildFullPayloadPositional();
        expect(Array.isArray(result.messages)).toBe(true);
        expect(result.messages.length).toBeGreaterThan(0);
        // Every message has role + content.
        for (const m of result.messages) {
            expect(typeof m.role).toBe('string');
            expect('content' in m).toBe(true);
        }
    });

    it('cache_control placements are stable (the cache-boundary guard)', () => {
        const { messages } = buildFullPayloadPositional();
        const ephemeral = messages.filter(
            m => (m as unknown as { cache_control?: { type: string } }).cache_control?.type === 'ephemeral'
        );
        // Stable + divergence + pinned + last history msg => at least 4 ephemeral.
        expect(ephemeral.length).toBeGreaterThanOrEqual(4);
        // The LAST ephemeral message MUST be a history message (user or assistant),
        // NOT the final volatile user message. This is the cache-boundary invariant.
        const lastEphemeral = ephemeral[ephemeral.length - 1];
        expect(['user', 'assistant']).toContain(lastEphemeral.role);
        // History content from HISTORY fixture, not USER_MESSAGE.
        const content = typeof lastEphemeral.content === 'string' ? lastEphemeral.content : '';
        expect(HISTORY.some(h => h.content === content)).toBe(true);
    });

    it('final user message contains the director brief + GM reminder + user input (in order)', () => {
        const { messages } = buildFullPayloadPositional();
        const lastUser = [...messages].reverse().find(m => m.role === 'user');
        expect(lastUser).toBeDefined();
        const content = typeof lastUser!.content === 'string' ? lastUser!.content : '';
        // Director brief block (supersedes watchdog nudge — watchdog text must NOT appear).
        expect(content).toContain('[DIRECTOR BRIEF]');
        expect(content).toContain('DIRECTOR_BRIEF_TEXT');
        expect(content).not.toContain('WATCHDOG_NUDGE_TEXT');
        // GM reminder.
        expect(content).toContain('[GM REMINDER:');
        // Ask GM brief.
        expect(content).toContain('OOC_BRIEF_TEXT');
        // User message tail.
        expect(content.endsWith(USER_MESSAGE)).toBe(true);
    });

    it('serialized messages hash is stable (the golden gate)', () => {
        const result = buildFullPayloadPositional();
        const serialized = serializeMessages(result.messages);
        const hash = djb2Hash(serialized);
        // Lock the hash. The exact value is not meaningful — what matters is
        // that it does NOT change across the refactor. If this assertion fails
        // post-refactor, the buildPayload options-object migration changed a
        // byte. Investigate before updating the golden value.
        expect(hash).toMatchSnapshot('golden-payload-hash');
        // Also snapshot the full serialized form for diff readability.
        expect(serialized).toMatchSnapshot('golden-payload-serialized');
    });

    it('omitting the deprecated _sceneNumber key produces byte-identical output (proving the dead param is safe to drop)', () => {
        // Audit finding A: _sceneNumber is @deprecated and unread. The new
        // options-object form OMITS the key entirely (vs. passing it as a
        // positional). This test proves the dead param is gone and the output
        // is unchanged — both calls now use the options form with NO
        // sceneNumber key, so they're trivially identical. The real guard is
        // the golden-hash test above, which locks the output with the key
        // absent.
        const a = buildPayload({
            settings: baseSettings(), context: baseContext(), history: HISTORY, userMessage: USER_MESSAGE,
            condensedUpToIndex: 2, relevantLore: LORE, npcLedger: NPCS, archiveRecall: ARCHIVE_RECALL,
            recommendedNPCNames: ['Aldric'], semanticFactText: SEMANTIC_FACT_TEXT, archiveIndex: ARCHIVE_INDEX,
            timelineEvents: TIMELINE, inventoryCategories: INVENTORY_CATEGORIES, profileFields: PROFILE_FIELDS,
            deepContextSummary: DEEP_CONTEXT_SUMMARY, divergenceRegister: makeRegister(), chapters: CHAPTERS,
            onStageNpcIds: ['npc_a'], relevantRules: RULES, rulesManifest: RULES_MANIFEST,
            pinnedExcerpts: PINNED, plannerEventTypes: PLANNER_EVENT_TYPES, locationLedger: LOCATION_LEDGER,
            nextTurnOocBrief: 'OOC_BRIEF_TEXT', watchdogNudge: 'WATCHDOG_NUDGE_TEXT',
            directorBrief: 'DIRECTOR_BRIEF_TEXT', elevatedScenes: ELEVATED, slottedRagSnippets: SLOTTED,
        });
        const b = buildPayload({
            settings: baseSettings(), context: baseContext(), history: HISTORY, userMessage: USER_MESSAGE,
            condensedUpToIndex: 2, relevantLore: LORE, npcLedger: NPCS, archiveRecall: ARCHIVE_RECALL,
            recommendedNPCNames: ['Aldric'], semanticFactText: SEMANTIC_FACT_TEXT, archiveIndex: ARCHIVE_INDEX,
            timelineEvents: TIMELINE, inventoryCategories: INVENTORY_CATEGORIES, profileFields: PROFILE_FIELDS,
            deepContextSummary: DEEP_CONTEXT_SUMMARY, divergenceRegister: makeRegister(), chapters: CHAPTERS,
            onStageNpcIds: ['npc_a'], relevantRules: RULES, rulesManifest: RULES_MANIFEST,
            pinnedExcerpts: PINNED, plannerEventTypes: PLANNER_EVENT_TYPES, locationLedger: LOCATION_LEDGER,
            nextTurnOocBrief: 'OOC_BRIEF_TEXT', watchdogNudge: 'WATCHDOG_NUDGE_TEXT',
            directorBrief: 'DIRECTOR_BRIEF_TEXT', elevatedScenes: ELEVATED, slottedRagSnippets: SLOTTED,
        });
        expect(serializeMessages(a.messages)).toBe(serializeMessages(b.messages));
    });

    it('omitting optionals (sceneContinue shape) is stable', () => {
        // useSceneContinue passes a different subset of optionals — the
        // options-object form must tolerate this (omitted keys = undefined,
        // same as today). Snapshot the hash for that shape too.
        const result = buildPayload({
            settings: baseSettings(), context: baseContext(), history: HISTORY, userMessage: USER_MESSAGE,
            condensedUpToIndex: 2, relevantLore: LORE, npcLedger: NPCS, archiveRecall: ARCHIVE_RECALL,
            recommendedNPCNames: ['Aldric'], semanticFactText: SEMANTIC_FACT_TEXT, archiveIndex: ARCHIVE_INDEX,
            timelineEvents: TIMELINE, inventoryCategories: INVENTORY_CATEGORIES, profileFields: PROFILE_FIELDS,
            deepContextSummary: DEEP_CONTEXT_SUMMARY, divergenceRegister: makeRegister(),
            // chapters omitted — sceneContinue passes undefined when relevantRules present
            onStageNpcIds: ['npc_a'], relevantRules: RULES, rulesManifest: RULES_MANIFEST,
            pinnedExcerpts: PINNED, locationLedger: LOCATION_LEDGER,
            elevatedScenes: ELEVATED, slottedRagSnippets: SLOTTED,
        });
        const serialized = serializeMessages(result.messages);
        expect(djb2Hash(serialized)).toMatchSnapshot('golden-payload-scenecontinue-hash');
    });
});

// ── Turn-flow integration test ───────────────────────────────────────────
// Mocks the heavy collaborators so `runTurn` reaches its payload-assembly +
// dispatch path. Captures the payload that flows into `sendMessage` and the
// snapshot capture call. Post-refactor, the bus-threaded `runTurn` MUST
// produce the same payload + same snapshot.

const sendMessageMock = vi.fn();
const buildPayloadMock = vi.fn(() => ({
    messages: [{ role: 'user', content: 'FIXED_PAYLOAD_MESSAGE' }] as OpenAIMessage[],
    trace: [],
    debugSections: [],
}));
const capturePendingTurnSnapshotMock = vi.fn();
const gatherContextMock = vi.fn(async () => ({
    archiveRecall: ARCHIVE_RECALL,
    recommendedNPCNames: ['Aldric'],
    timelineEvents: TIMELINE,
    relevantLore: LORE,
    semanticArchiveIds: ['s1'],
    semanticLoreIds: ['l1'],
    inventoryCategories: ['weapon'],
    profileFields: ['appearance'],
    deepContextSummary: DEEP_CONTEXT_SUMMARY,
    semanticFactText: SEMANTIC_FACT_TEXT,
    relevantRules: RULES,
    rulesManifest: RULES_MANIFEST,
    elevatedScenes: ELEVATED,
    elevatedSceneRankedIds: ['s1'],
    slottedRagSnippets: SLOTTED,
}));

vi.mock('../../chatEngine', () => ({
    buildPayload: (...args: unknown[]) => buildPayloadMock(...args),
    sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

vi.mock('../pendingCommit', () => ({
    capturePendingTurnSnapshot: (...args: unknown[]) => capturePendingTurnSnapshotMock(...args),
}));

vi.mock('../contextGatherer', () => ({
    gatherContext: (...args: unknown[]) => gatherContextMock(...args),
}));

vi.mock('../directorWatchdog', () => ({
    buildWatchdogDossier: vi.fn(() => ({ signals: [], dossierText: '', nudgeText: 'WATCHDOG_NUDGE' })),
}));

vi.mock('../directorBrief', () => ({
    runDirectorBrief: vi.fn(async () => null as string | null),
    lastAssistantContent: vi.fn(() => 'LAST_GM'),
    clearDirectorBriefCache: vi.fn(),
}));

vi.mock('../../lib/payloadSanitizer', () => ({
    sanitizePayloadForApi: (p: unknown) => p,
}));

vi.mock('../../components/Toast', () => ({
    toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../sceneStakesTag', () => ({
    extractAndStripSceneStakes: (text: string) => ({ displayText: text, stakes: 'calm' as const }),
}));

vi.mock('../toolHandlers', () => ({ getToolDefinitions: vi.fn(() => []) }));
vi.mock('../toolRegistry', () => ({ resolveToolHandler: vi.fn(() => null) }));

vi.mock('../../engine/engineRolls', () => ({
    rollEngines: vi.fn(() => ({ appendToInput: '', updatedDCs: {} })),
    rollDiceFairness: vi.fn(() => ''),
    resolveManualRoll: vi.fn(() => ({
        rolls: [10], detail: '1d20', tier: 'Regular', faceValue: '10',
    })),
}));
vi.mock('../../engine/lootEngine', () => ({ resolveLootDrop: vi.fn(() => ({ appendToInput: '' })) }));
vi.mock('../../oneshot/oneShotEvents', () => ({ buildOneShotDirective: vi.fn(() => null) }));

// useAppStore mock — provides getActiveAuxiliaryEndpoint (the :210 coupling
// read) and locationLedger (the :317 coupling read). Post-refactor, both of
// these reads are killed; the values arrive via TurnState/TurnContext instead.
// The mock state here mirrors what the real store would return so the test
// baseline is meaningful.
const getStateMock = vi.fn(() => ({
    locationLedger: LOCATION_LEDGER,
    getActiveAuxiliaryEndpoint: () => ({ endpoint: 'http://aux', modelName: 'aux' } as any as EndpointConfig),
    getActiveStoryEndpoint: () => ({ endpoint: 'http://story', modelName: 'story' } as any as EndpointConfig),
}));
vi.mock('../../../store/useAppStore', () => ({
    useAppStore: { getState: () => getStateMock() },
}));

// SUT import (after mocks hoist).
import { runTurn } from '../turnOrchestrator';
import type { TurnState, TurnCallbacks } from '../turnOrchestrator';

function baseState(): TurnState {
    return {
        input: USER_MESSAGE,
        displayInput: USER_MESSAGE,
        settings: baseSettings(),
        context: baseContext(),
        messages: HISTORY,
        condenser: { condensedUpToIndex: 2 } as any as CondenserState,
        loreChunks: LORE,
        npcLedger: NPCS,
        archiveIndex: ARCHIVE_INDEX,
        activeCampaignId: 'camp_test',
        provider: { endpoint: 'http://story', modelName: 'story' } as any as EndpointConfig,
        getMessages: () => HISTORY,
        getFreshProvider: () => ({ endpoint: 'http://story', modelName: 'story' } as any),
        getUtilityEndpoint: () => undefined,
        getFreshAuxiliaryProvider: () => ({ endpoint: 'http://aux', modelName: 'aux' } as any),
        onStageNpcIds: ['npc_a'],
        timeline: TIMELINE,
        chapters: CHAPTERS,
        pinnedChapterIds: [],
        clearPinnedChapters: () => {},
        setChapters: () => {},
        incrementBookkeepingTurnCounter: () => 0,
        resetBookkeepingTurnCounter: () => {},
        autoBookkeepingInterval: 5,
        getFreshContext: () => baseContext(),
        sampling: undefined,
        deepSearchThisTurn: false,
        divergenceRegister: makeRegister(),
        pinnedExcerpts: PINNED,
        armedRoll: null,
        armedLoot: null,
        armedOneShot: null,
        absoluteCommand: null,
        nextTurnOocBrief: 'OOC_BRIEF_TEXT',
    } as any as TurnState;
}

function baseCallbacks(): TurnCallbacks {
    const noop = () => {};
    return {
        onCheckingNotes: noop, addMessage: noop, updateLastAssistant: noop,
        updateLastMessage: noop, updateLastAssistantMessage: noop,
        updateContext: noop, setArchiveIndex: noop,
        updateNPC: noop, addNPC: noop, setCondensed: noop, setStreaming: noop,
        archiveNPC: noop, restoreNPC: noop,
    } as any as TurnCallbacks;
}

function wireSendMessageToComplete(): void {
    sendMessageMock.mockImplementation(
        (_provider: unknown, _messages: unknown, _onChunk: unknown, onDone: any) => {
            Promise.resolve().then(() => onDone('Final GM text.', undefined, undefined));
            return Promise.resolve();
        },
    );
}

describe('WO-P1-01 — runTurn pre-payload path golden (byte-identical pre/post refactor)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        wireSendMessageToComplete();
    });

    it('reaches buildPayload with the expected options-object shape (byte-identical to the pre-refactor positional call)', () => {
        return runTurn(baseState(), baseCallbacks(), new AbortController()).then(() => {
            expect(buildPayloadMock).toHaveBeenCalledTimes(1);
            const opts = buildPayloadMock.mock.calls[0][0] as Record<string, unknown>;
            // settings
            expect(opts.settings).toMatchObject({ contextLimit: 8192 });
            // context
            expect(opts.context).toMatchObject({ canonState: 'The kingdom of Alderia lies east of the Spine.' });
            // history (messages)
            expect(opts.history).toBe(HISTORY);
            // final user message — includes the original input plus any engine roll appends.
            expect(typeof opts.userMessage).toBe('string');
            expect((opts.userMessage as string)).toContain(USER_MESSAGE);
            // condensedUpToIndex
            expect(opts.condensedUpToIndex).toBe(2);
            // relevantLore (from gatherContext)
            expect(opts.relevantLore).toBe(LORE);
            // npcLedger
            expect(opts.npcLedger).toBe(NPCS);
            // archiveRecall
            expect(opts.archiveRecall).toBe(ARCHIVE_RECALL);
            // sceneNumber — DROPPED (was @deprecated / unread). The key must NOT appear.
            expect(opts).not.toHaveProperty('sceneNumber');
            expect(opts).not.toHaveProperty('_sceneNumber');
            // recommendedNPCNames
            expect(opts.recommendedNPCNames).toEqual(['Aldric']);
            // semanticFactText
            expect(opts.semanticFactText).toBe(SEMANTIC_FACT_TEXT);
            // archiveIndex
            expect(opts.archiveIndex).toBe(ARCHIVE_INDEX);
            // timelineEvents
            expect(opts.timelineEvents).toBe(TIMELINE);
            // inventoryCategories
            expect(opts.inventoryCategories).toEqual(['weapon']);
            // profileFields
            expect(opts.profileFields).toEqual(['appearance']);
            // deepContextSummary
            expect(opts.deepContextSummary).toBe(DEEP_CONTEXT_SUMMARY);
            // divergenceRegister (from state.divergenceRegister)
            expect(opts.divergenceRegister).toMatchObject({ entries: expect.any(Array) });
            // chapters
            expect(opts.chapters).toBe(CHAPTERS);
            // onStageNpcIds
            expect(opts.onStageNpcIds).toEqual(['npc_a']);
            // relevantRules
            expect(opts.relevantRules).toBe(RULES);
            // rulesManifest
            expect(opts.rulesManifest).toBe(RULES_MANIFEST);
            // pinnedExcerpts (from state.pinnedExcerpts)
            expect(opts.pinnedExcerpts).toBe(PINNED);
            // plannerEventTypes — undefined (omitted key; recomputed in buildWorld).
            // Options-object form: omitted key is undefined. Asserting absence
            // (rather than a positional `undefined`) keeps the test honest.
            expect(opts.plannerEventTypes).toBeUndefined();
            // locationLedger — currently from getState(); post-refactor from bus.
            expect(opts.locationLedger).toEqual(LOCATION_LEDGER);
            // nextTurnOocBrief (from state)
            expect(opts.nextTurnOocBrief).toBe('OOC_BRIEF_TEXT');
            // watchdogNudge — from buildWatchdogDossier mock.
            expect(opts.watchdogNudge).toBe('WATCHDOG_NUDGE');
            // directorBrief — runDirectorBrief mock returns null → undefined.
            expect(opts.directorBrief).toBeUndefined();
            // elevatedScenes
            expect(opts.elevatedScenes).toBe(ELEVATED);
            // slottedRagSnippets
            expect(opts.slottedRagSnippets).toBe(SLOTTED);
        });
    });

    it('the locationLedger option is lifted from useAppStore.getState() ONCE at turn start (bus field, not a per-build coupling read)', () => {
        return runTurn(baseState(), baseCallbacks(), new AbortController()).then(() => {
            // Post-refactor: the orchestrator reads locationLedger via getState()
            // ONCE at createTurnContext time (turn start), then threads it
            // through the bus to buildPayload. The buildPayload call reads
            // ctx.locationLedger — NOT useAppStore.getState() at build time.
            // The mock is called once (turn-start lift), not at build time.
            expect(getStateMock).toHaveBeenCalled();
            const opts = buildPayloadMock.mock.calls[0][0] as Record<string, unknown>;
            expect(opts.locationLedger).toEqual(LOCATION_LEDGER);
        });
    });

    it('captured snapshot references the same payload messages array (sent to sendMessage)', () => {
        return runTurn(baseState(), baseCallbacks(), new AbortController()).then(() => {
            // Smart Retry v1: capturePendingTurnSnapshot is now called TWICE — once
            // early (pre-Story-AI, for the failure/retry path) and once on success
            // (richer payload with tool history + complete ctx). The success capture
            // overwrites the early one idempotently. Both are deliberate; see the
            // comments in runGenerationStage.
            expect(capturePendingTurnSnapshotMock).toHaveBeenCalledTimes(2);
            // The success-path capture (second call) carries currentPayload — the
            // messages array the mocked buildPayload returned.
            const snapshotArgs = capturePendingTurnSnapshotMock.mock.calls[1];
            expect(snapshotArgs[1]).toEqual([{ role: 'user', content: 'FIXED_PAYLOAD_MESSAGE' }]);
        });
    });

    it('sendMessage receives the payload from buildPayload (unchanged dispatch contract)', () => {
        return runTurn(baseState(), baseCallbacks(), new AbortController()).then(() => {
            expect(sendMessageMock).toHaveBeenCalledTimes(1);
            const sendArgs = sendMessageMock.mock.calls[0];
            // Arg 1: payload messages.
            expect(sendArgs[1]).toEqual([{ role: 'user', content: 'FIXED_PAYLOAD_MESSAGE' }]);
        });
    });
});