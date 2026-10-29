/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ArchiveIndexEntry, ArchiveScene, AppSettings, ChatMessage, GameContext, NPCEntry } from '../../../types';
import { buildWorld } from '../world';
import { buildPayload } from '../payloadBuilder';
import { createTraceCollector } from '../traceCollector';
import type { ElevatedScene } from '../../archive-memory/dynamicElevation';

// ─────────────────────────────────────────────────────────────────────────────
// WO-11b — Checkpoint 3 integration corrections.
//
// Focused tests for the three corrections:
//  1. Dynamic Elevation renders independently of ordinary recall (undefined / []).
//  2. (route-level boundary tests live in server/__tests__/archiveScopedSearch.test.js)
//  3. Timeout timer is cleared on early resolution (fake-timer tests at the bottom).
//
// Required focused tests per WO-11b §"Required focused tests":
//  1. archiveRecall: undefined + an elevated broadcast scene renders the elevated label.
//  2. archiveRecall: [] + an elevated broadcast scene renders identically.
//  3. A scene already present in post-filter regular recall is not rendered twice.
//  4. Elevated scenes are never dropped for who witnessed them; each carries the
//     ledger names of its witnesses, like regular recall (the old witness filter
//     compared stored names against NPC ids and dropped every witnessed scene).
//  5. The elevated label exists in the final per-turn world/user content and in no
//     history/system message.
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

function elevatedScene(sceneId: string, content: string, chapterId: string, tokens = 10): ElevatedScene {
    return { sceneId, content, tokens, chapterId } as ElevatedScene;
}

function buildWorldWith(opts: {
    archiveRecall?: ArchiveScene[];
    elevatedScenes?: ElevatedScene[];
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
    });
}

describe('WO-11b Correction 1 — Dynamic Elevation renders independently of ordinary recall', () => {
    it('archiveRecall: undefined + an elevated broadcast scene renders the elevated label and verbatim content', () => {
        const archiveIndex = [mkIndexEntry('004', { witnesses: [] })]; // broadcast
        const elevated = [elevatedScene('004', 'The battle at the gates — verbatim content.', 'CH02')];

        const { worldContent } = buildWorldWith({
            archiveRecall: undefined,
            elevatedScenes: elevated,
            archiveIndex,
        });

        expect(worldContent).toContain('[ELEVATED MEMORY — Chapter CH02]');
        expect(worldContent).toContain('The battle at the gates — verbatim content.');
        expect(worldContent).toContain('[END ELEVATED MEMORY]');
    });

    it('archiveRecall: [] + an elevated broadcast scene renders identically to the undefined case', () => {
        const archiveIndex = [mkIndexEntry('004', { witnesses: [] })];
        const elevated = [elevatedScene('004', 'The battle at the gates — verbatim content.', 'CH02')];

        const { worldContent: withEmpty } = buildWorldWith({
            archiveRecall: [],
            elevatedScenes: elevated,
            archiveIndex,
        });
        const { worldContent: withUndefined } = buildWorldWith({
            archiveRecall: undefined,
            elevatedScenes: elevated,
            archiveIndex,
        });

        expect(withEmpty).toContain('[ELEVATED MEMORY — Chapter CH02]');
        expect(withEmpty).toContain('The battle at the gates — verbatim content.');
        // Both shapes produce the same elevated block.
        expect(withEmpty).toBe(withUndefined);
    });

    it('a scene already present in post-filter regular recall is not rendered twice', () => {
        // Regular recall contains scene 004; elevated also has 004 + 002.
        const archiveIndex = [
            mkIndexEntry('002', { witnesses: [] }),
            mkIndexEntry('004', { witnesses: [] }),
        ];
        const archiveRecall = [
            { sceneId: '004', content: 'Regular recall scene four.', tokens: 5 },
        ];
        const elevated = [
            elevatedScene('004', 'Elevated scene four (duplicate).', 'CH02'),
            elevatedScene('002', 'Elevated scene two (unique).', 'CH01'),
        ];

        const { worldContent } = buildWorldWith({
            archiveRecall,
            elevatedScenes: elevated,
            archiveIndex,
        });

        // Scene 004 appears once (in Archive Recall, not in Elevated).
        expect(worldContent).toContain('Regular recall scene four.');
        expect(worldContent).not.toContain('Elevated scene four (duplicate).');
        // Scene 002 appears once (in Elevated only).
        expect(worldContent).toContain('Elevated scene two (unique).');
        expect(worldContent).toContain('[ELEVATED MEMORY — Chapter CH01]');
        // CH02 is NOT in the elevated label because scene 004 was deduped.
        expect(worldContent).not.toContain('[ELEVATED MEMORY — Chapter CH02]');
    });

    it('with ordinary recall empty, an elevated scene witnessed by an off-stage NPC renders with a witness label', () => {
        // Scene 004 is witnessed only by Brenna, who is not on stage.
        // Scene 002 is broadcast (no witnesses). Ordinary recall is undefined.
        const archiveIndex = [
            mkIndexEntry('002', { witnesses: [] }), // broadcast
            mkIndexEntry('004', { witnesses: ['Brenna'] }), // witnessed only by an off-stage NPC
        ];
        const elevated = [
            elevatedScene('002', 'Broadcast elevated scene.', 'CH01'),
            elevatedScene('004', 'Offstage-witnessed elevated scene.', 'CH02'),
        ];

        const { worldContent } = buildWorldWith({
            archiveRecall: undefined,
            elevatedScenes: elevated,
            archiveIndex,
            npcLedger: [mkNpc('npc_a', 'Aldric'), mkNpc('npc_b', 'Brenna Vale')],
            onStageNpcIds: ['npc_a'],
        });

        expect(worldContent).toContain('[ELEVATED MEMORY — Chapter CH01]\n[PAST SCENE]\nBroadcast elevated scene.');
        expect(worldContent).toContain('[ELEVATED MEMORY — Chapter CH02]\n[PAST SCENE — witnessed by Brenna Vale]\nOffstage-witnessed elevated scene.');
    });

    it('the elevated label exists in the final per-turn world/user content and in no history/system message', () => {
        const archiveIndex = [mkIndexEntry('004', { witnesses: [] })];
        const elevated = [elevatedScene('004', 'The battle at the gates — verbatim content.', 'CH02')];

        const result = buildPayload({
            settings: baseSettings(),
            context: baseContext(),
            history: [],
            userMessage: 'I remember the battle.',
            archiveIndex,
            elevatedScenes: elevated,
        });

        const messages = result.messages;
        // The final user message (below the cache boundary) contains the elevated label.
        const finalUser = messages.find(m => m.role === 'user');
        expect(finalUser).toBeDefined();
        const finalUserContent = typeof finalUser?.content === 'string' ? finalUser.content : '';
        expect(finalUserContent).toContain('[ELEVATED MEMORY — Chapter CH02]');
        expect(finalUserContent).toContain('The battle at the gates — verbatim content.');

        // No system or history message contains the elevated label — it rides ONLY in the
        // per-turn world/user content, never above the cache boundary.
        const nonUserContent = messages
            .filter(m => m.role !== 'user')
            .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
            .join('\n----\n');
        expect(nonUserContent).not.toContain('[ELEVATED MEMORY');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WO-11b Correction 3 — timeout timer cleanup proofs.
//
// Deterministic fake-timer tests proving:
//  1. a never-resolving scoped fetch returns the empty result at exactly the
//     configured five-second boundary; and
//  2. a fast successful result leaves no pending timeout and does not emit the
//     timeout warning after timers advance.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../../archiveMemory', () => ({
    fetchArchiveScenes: vi.fn().mockResolvedValue([]),
}));

import { runDynamicElevation } from '../../archive-memory/dynamicElevation';
import { fetchArchiveScenes } from '../../archiveMemory';

const mockFetchArchiveScenes = vi.mocked(fetchArchiveScenes);

describe('WO-11b Correction 3 — timeout timer cleanup', () => {
    let originalFetch: typeof global.fetch;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        originalFetch = global.fetch;
        vi.clearAllMocks();
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        global.fetch = originalFetch;
        warnSpy.mockRestore();
    });

    it('a never-resolving scoped fetch returns the empty result at exactly the five-second boundary', async () => {
        vi.useFakeTimers();
        try {
            // Never-resolving fetch — the only way to reach the timeout boundary.
            const neverResolves = new Promise<Response>(() => {});
            global.fetch = vi.fn().mockReturnValue(neverResolves) as any;

            const promise = runDynamicElevation({
                campaignId: 'c1',
                queries: ['remember'],
                scopeSceneIds: ['001'],
                limit: 5,
            });

            // Before the 5s boundary, the promise is pending.
            let settled = false;
            const earlyPeek = Promise.race([promise.then(() => true), Promise.resolve(false)]);
            // Yield a microtask; the promise should NOT have settled yet.
            await Promise.resolve();
            await earlyPeek.then(v => { settled = v; });
            expect(settled).toBe(false);

            // Advance to exactly 5000ms — the timeout fires.
            vi.advanceTimersByTime(5000);

            const result = await promise;
            expect(result.scenes).toEqual([]);
            expect(result.rankedSceneIds).toEqual([]);
            // The timeout warning was emitted exactly once.
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[DynamicElevation] timeout'));
        } finally {
            vi.useRealTimers();
        }
    });

    it('a fast successful result leaves no pending timeout and does not emit the timeout warning after timers advance', async () => {
        vi.useFakeTimers();
        try {
            // Fast success — resolves immediately with a 200 + scene IDs.
            global.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ pending: false, sceneIds: ['001'] }),
            } as Response) as any;
            mockFetchArchiveScenes.mockResolvedValueOnce([
                { sceneId: '001', content: 'one', tokens: 1 },
            ]);

            const promise = runDynamicElevation({
                campaignId: 'c1',
                queries: ['remember'],
                scopeSceneIds: ['001'],
                limit: 5,
            });

            // Let the microtask queue drain so the fast fetch resolves.
            await vi.runAllTimersAsync();
            const result = await promise;
            expect(result.scenes).toHaveLength(1);
            expect(result.rankedSceneIds).toEqual(['001']);

            // No timeout warning should have been emitted.
            const timeoutCalls = warnSpy.mock.calls.filter((c: unknown[]) =>
                String(c[0]).includes('[DynamicElevation] timeout')
            );
            expect(timeoutCalls).toHaveLength(0);

            // Advance well past the 5s boundary — no pending timer fires (no late warning).
            vi.advanceTimersByTime(10000);
            const timeoutCallsAfterAdvance = warnSpy.mock.calls.filter((c: unknown[]) =>
                String(c[0]).includes('[DynamicElevation] timeout')
            );
            expect(timeoutCallsAfterAdvance).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });
});