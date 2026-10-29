import { describe, it, expect } from 'vitest';
import type { ArchiveIndexEntry, ArchiveScene, AppSettings, ChatMessage, GameContext, NPCEntry } from '../../../types';
import { buildWorld } from '../world';
import { buildPayload } from '../payloadBuilder';
import { createTraceCollector } from '../traceCollector';
import type { ElevatedScene } from '../../archive-memory/dynamicElevation';
import type { SlottedRagSnippet } from '../../archive-memory/slottedRag';

// ─────────────────────────────────────────────────────────────────────────────
// WO-12 — Slotted RAG integration tests.
//
// Focused tests for the [ARCHIVE FLASHES] block rendering in world.ts and the
// payload-builder thread-through. Verifies:
//  - the [ARCHIVE FLASHES] label renders in the final per-turn world/user
//    content (below the cache boundary) and in no history/system message.
//  - empty snippets → no block emitted.
//  - exclusion of elevated scenes (the snippets passed in are already
//    WO-11-minus-elevated; this test confirms the rendering layer does not
//    re-introduce elevated scenes).
//  - witness filter already applied at snippet-build time (rendering layer
//    trusts the snippet list — it does not re-filter).
// ─────────────────────────────────────────────────────────────────────────────

function baseContext(): GameContext {
    return {
        loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '',
        starter: '', continuePrompt: '', inventory: '',
        inventoryLastScene: 'Never', characterProfile: '',
        characterProfileLastScene: 'Never', canonStateActive: false,
        headerIndexActive: false, starterActive: false, continuePromptActive: false,
        inventoryActive: false, characterProfileActive: false,
        surpriseEngineActive: false, encounterEngineActive: true,
        worldEngineActive: true, diceFairnessActive: true,
        sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 3,
        worldVibe: '', notebook: [], notebookActive: false,
        worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
    } as unknown as GameContext;
}

function baseSettings(over: Partial<AppSettings> = {}): AppSettings {
    return {
        debugMode: true,
        contextLimit: 8192,
        lodSummaryChapters: 7,
        lodImportanceBonus: 2,
        ...over,
    } as unknown as AppSettings;
}

function mkIndexEntry(sceneId: string, over: Partial<ArchiveIndexEntry> = {}): ArchiveIndexEntry {
    return {
        sceneId, timestamp: 0, keywords: [], npcsMentioned: [],
        witnesses: [], userSnippet: '', ...over,
    } as ArchiveIndexEntry;
}

function mkNpc(id: string, name: string, archived = false): NPCEntry {
    return { id, name, aliases: '', archived, affinity: 50 } as unknown as NPCEntry;
}

function mkSnippet(sceneId: string, chapterId: string, snippet: string, witnessedBy: string[] | 'all' = 'all'): SlottedRagSnippet {
    return { sceneId, chapterId, snippet, witnessedBy };
}

function buildWorldWith(opts: {
    archiveRecall?: ArchiveScene[];
    elevatedScenes?: ElevatedScene[];
    slottedRagSnippets?: SlottedRagSnippet[];
    archiveIndex?: ArchiveIndexEntry[];
    npcLedger?: NPCEntry[];
    onStageNpcIds?: string[];
    isDebug?: boolean;
    budgetWorld?: number;
    npcBudgetFloor?: number;
    history?: ChatMessage[];
}) {
    return buildWorld({
        history: opts.history ?? [],
        userMessage: 'remember the old battle',
        relevantLore: undefined,
        npcLedger: opts.npcLedger ?? [mkNpc('npc_a', 'Aldric')],
        archiveRecall: opts.archiveRecall,
        semanticFactText: undefined,
        archiveIndex: opts.archiveIndex ?? [],
        timelineEvents: undefined,
        deepContextSummary: undefined,
        divergenceRegister: undefined,
        chapters: undefined,
        onStageNpcIds: opts.onStageNpcIds ?? ['npc_a'],
        budgetWorld: opts.budgetWorld ?? 8192,
        npcBudgetFloor: opts.npcBudgetFloor ?? 2048,
        matureMode: false,
        collector: createTraceCollector(opts.isDebug ?? false),
        elevatedScenes: opts.elevatedScenes,
        slottedRagSnippets: opts.slottedRagSnippets,
    });
}

describe('WO-12 — Slotted RAG world rendering', () => {
    it('renders the [ARCHIVE FLASHES] block when snippets are present', () => {
        const snippets = [
            mkSnippet('001', 'CH01', 'The gates fell at dawn.'),
            mkSnippet('005', 'CH02', 'A pact was sealed.', ['Aldric']),
        ];

        const { worldContent } = buildWorldWith({ slottedRagSnippets: snippets });

        expect(worldContent).toContain('[ARCHIVE FLASHES]');
        expect(worldContent).toContain('- (Chapter CH01, witnessed by all) "The gates fell at dawn."');
        expect(worldContent).toContain('- (Chapter CH02, witnessed by Aldric) "A pact was sealed."');
    });

    it('empty snippets → no [ARCHIVE FLASHES] block emitted', () => {
        const { worldContent } = buildWorldWith({ slottedRagSnippets: [] });
        expect(worldContent).not.toContain('[ARCHIVE FLASHES]');
    });

    it('undefined snippets → no [ARCHIVE FLASHES] block emitted', () => {
        const { worldContent } = buildWorldWith({ slottedRagSnippets: undefined });
        expect(worldContent).not.toContain('[ARCHIVE FLASHES]');
    });

    it('the [ARCHIVE FLASHES] block rides ONLY in the final per-turn world/user content (below the cache boundary) — non-vacuous proof', () => {
        // WO-12b Correction 3: non-vacuous cache-placement proof.
        // The fixture supplies at least one user-role AND one assistant-role
        // history message so the "every message before the final message lacks
        // [ARCHIVE FLASHES]" check cannot pass vacuously. The final per-turn
        // message is identified as messages.at(-1) and asserted to be role
        // 'user'. Every message before it, regardless of role, is asserted to
        // lack the [ARCHIVE FLASHES] label.
        const snippets = [mkSnippet('001', 'CH01', 'The gates fell at dawn.')];

        // Real history with one user-role and one assistant-role message, so
        // the "no earlier message contains [ARCHIVE FLASHES]" assertion is
        // meaningful (the fixture actually contains earlier messages).
        const history: ChatMessage[] = [
            { id: 'h1', role: 'user', content: 'I walked into the tavern.', timestamp: 1 } as ChatMessage,
            { id: 'h2', role: 'assistant', content: 'The bard looked up from his lute.', timestamp: 2 } as ChatMessage,
        ];

        const result = buildPayload({
            settings: baseSettings(),
            context: baseContext(),
            history: history,
            userMessage: 'I remember the battle.',
            slottedRagSnippets: snippets,
        });

        const messages = result.messages;

        // Non-vacuous proof: the fixture actually contains an earlier user-role
        // message (from history). If buildPayload ever stopped emitting history,
        // this assertion would fail — preventing the cache-placement check from
        // passing vacuously on an empty history.
        const earlierUserMessages = messages.slice(0, -1).filter(m => m.role === 'user');
        expect(earlierUserMessages.length).toBeGreaterThanOrEqual(1);

        // The final per-turn message is messages.at(-1) and is role 'user'.
        const finalMessage = messages.at(-1);
        expect(finalMessage).toBeDefined();
        expect(finalMessage?.role).toBe('user');
        const finalContent = typeof finalMessage?.content === 'string' ? finalMessage.content : '';
        expect(finalContent).toContain('[ARCHIVE FLASHES]');
        expect(finalContent).toContain('The gates fell at dawn.');

        // Every message before the final message, regardless of role, lacks
        // [ARCHIVE FLASHES]. This is the cache-placement proof: the label
        // appears ONLY in the final per-turn user message (below the cache
        // boundary), never in any history/system/assistant message above it.
        for (let i = 0; i < messages.length - 1; i++) {
            const m = messages[i];
            const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
            expect(content).not.toContain('[ARCHIVE FLASHES]');
        }
    });

    it('slotted RAG and Dynamic Elevation can coexist (both blocks render in the world content)', () => {
        const archiveIndex = [
            mkIndexEntry('004', { witnesses: [] }), // broadcast — passes elevation witness filter
        ];
        const elevated = [{ sceneId: '004', content: 'Elevated verbatim scene content.', tokens: 10, chapterId: 'CH02' }] as ElevatedScene[];
        const snippets = [mkSnippet('001', 'CH01', 'A snippet from a non-elevated scene.')];

        const { worldContent } = buildWorldWith({
            elevatedScenes: elevated,
            slottedRagSnippets: snippets,
            archiveIndex,
        });

        // Both labels appear — Slotted RAG does NOT replace Dynamic Elevation.
        expect(worldContent).toContain('[ELEVATED MEMORY — Chapter CH02]');
        expect(worldContent).toContain('Elevated verbatim scene content.');
        expect(worldContent).toContain('[ARCHIVE FLASHES]');
        expect(worldContent).toContain('A snippet from a non-elevated scene.');
    });

    it('the Slotted RAG trace entry is recorded in debug mode with source: "Slotted RAG"', () => {
        const snippets = [mkSnippet('001', 'CH01', 'The gates fell at dawn.')];
        const collector = createTraceCollector(true);

        buildWorld({
            history: [],
            userMessage: 'remember the battle',
            npcLedger: [mkNpc('npc_a', 'Aldric')],
            archiveIndex: [],
            onStageNpcIds: ['npc_a'],
            budgetWorld: 8192,
            npcBudgetFloor: 2048,
            collector,
            elevatedScenes: undefined,
            slottedRagSnippets: snippets,
        });

        const slottedTrace = collector.trace.find(t => t.source === 'Slotted RAG');
        expect(slottedTrace).toBeDefined();
        expect(slottedTrace?.included).toBe(true);
        expect(slottedTrace?.position).toBe('system_dynamic');
        expect(slottedTrace?.reason).toContain('Synopsis-tier snippet flashes');
    });

    it('no Slotted RAG trace entry is recorded when snippets are empty', () => {
        const collector = createTraceCollector(true);

        buildWorld({
            history: [],
            userMessage: 'remember the battle',
            npcLedger: [mkNpc('npc_a', 'Aldric')],
            archiveIndex: [],
            onStageNpcIds: ['npc_a'],
            budgetWorld: 8192,
            npcBudgetFloor: 2048,
            collector,
            elevatedScenes: undefined,
            slottedRagSnippets: [],
        });

        const slottedTrace = collector.trace.find(t => t.source === 'Slotted RAG');
        expect(slottedTrace).toBeUndefined();
    });
});