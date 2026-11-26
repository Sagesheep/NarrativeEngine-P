/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ArchiveChapter, ArchiveIndexEntry, ChatMessage } from '../../../types';
import type { TurnState } from '../../turn/turnOrchestrator';

vi.mock('../../archiveMemory', () => ({
    fetchArchiveScenes: vi.fn().mockResolvedValue([]),
}));

import { computeSynopsisScope, runDynamicElevation, gatherDynamicElevation, dedupElevatedScenes } from '../dynamicElevation';
import { fetchArchiveScenes } from '../../archiveMemory';

const mockFetchArchiveScenes = vi.mocked(fetchArchiveScenes);

function mkChapter(over: Partial<ArchiveChapter> & { chapterId: string }): ArchiveChapter {
    return {
        title: `Chapter ${over.chapterId}`,
        sceneRange: [over.chapterId.replace('CH', '').padStart(3, '0'), over.chapterId.replace('CH', '').padStart(3, '0')],
        sceneIds: [over.chapterId.replace('CH', '').padStart(3, '0')],
        summary: `Summary of ${over.chapterId}.`,
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount: 1,
        sealedAt: 1,
        ...over,
    } as ArchiveChapter;
}

function mkIndexEntry(sceneId: string, over: Partial<ArchiveIndexEntry> = {}): ArchiveIndexEntry {
    return {
        sceneId,
        timestamp: 0,
        keywords: [],
        npcsMentioned: [],
        witnesses: [],
        userSnippet: '',
        ...over,
    } as ArchiveIndexEntry;
}

function mkMessage(sceneId: string | undefined, role: 'user' | 'assistant' = 'assistant'): ChatMessage {
    return {
        id: `msg_${sceneId ?? 'none'}_${Math.random().toString(36).slice(2, 8)}`,
        role,
        content: 'x',
        timestamp: 0,
        sceneId,
    } as ChatMessage;
}

function makeState(overrides: Partial<TurnState> = {}): TurnState {
    return {
        input: 'remember the battle',
        displayInput: 'remember the battle',
        settings: { aiTier: 'pro', lodSummaryChapters: 7, lodImportanceBonus: 2, lodElevateScenes: 2 } as any,
        context: {} as any,
        messages: [],
        condenser: { condensedUpToIndex: -1 },
        loreChunks: [],
        npcLedger: [],
        archiveIndex: [],
        activeCampaignId: 'c1',
        provider: undefined,
        getMessages: () => [],
        getFreshProvider: () => undefined,
        chapters: [],
        pinnedChapterIds: [],
        clearPinnedChapters: vi.fn(),
        setChapters: vi.fn(),
        incrementBookkeepingTurnCounter: vi.fn().mockReturnValue(1),
        resetBookkeepingTurnCounter: vi.fn(),
        autoBookkeepingInterval: 5,
        getFreshContext: () => ({}) as any,
        ...overrides,
    } as any as TurnState;
}

describe('WO-11 — Dynamic Elevation', () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
        vi.clearAllMocks();
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    describe('computeSynopsisScope', () => {
        it('returns only synopsis-tier scene IDs (summary chapters excluded)', () => {
            const sealed: ArchiveChapter[] = [
                mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
                mkChapter({ chapterId: 'CH02', sceneRange: ['004', '006'], sceneIds: ['004', '005', '006'] }),
                mkChapter({ chapterId: 'CH03', sceneRange: ['007', '009'], sceneIds: ['007', '008', '009'] }),
                mkChapter({ chapterId: 'CH04', sceneRange: ['010', '012'], sceneIds: ['010', '011', '012'] }),
            ];
            const msgs: ChatMessage[] = [];
            for (let i = 1; i <= 12; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
            const archiveIndex: ArchiveIndexEntry[] = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012']
                .map(s => mkIndexEntry(s, { witnesses: [] }));

            const { scopeSceneIds, sceneIdToChapterId } = computeSynopsisScope({
                chapters: sealed,
                archiveIndex,
                condensedUpToIndex: 11,
                messages: msgs,
                config: { summaryChapters: 2, importanceBonus: 0 },
            });

            // CH03 + CH04 → summary; CH01 + CH02 → synopsis.
            expect(scopeSceneIds).toEqual(expect.arrayContaining(['001', '002', '003', '004', '005', '006']));
            expect(scopeSceneIds).not.toContain('007');
            expect(scopeSceneIds).not.toContain('010');
            expect(sceneIdToChapterId.get('001')).toBe('CH01');
            expect(sceneIdToChapterId.get('006')).toBe('CH02');
        });

        it('empty synopsis set: all chapters are summary-tier → no scope', () => {
            const sealed: ArchiveChapter[] = [
                mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
            ];
            const msgs: ChatMessage[] = [];
            for (let i = 1; i <= 3; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
            const archiveIndex = ['001', '002', '003'].map(s => mkIndexEntry(s, { witnesses: [] }));

            const { scopeSceneIds } = computeSynopsisScope({
                chapters: sealed,
                archiveIndex,
                condensedUpToIndex: 2,
                messages: msgs,
                config: { summaryChapters: 7, importanceBonus: 0 },
            });

            expect(scopeSceneIds).toEqual([]);
        });
    });

    describe('runDynamicElevation', () => {
        it('sends scopeSceneIds in the request body and fetches top-N verbatim scenes', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ pending: false, sceneIds: ['004', '002', '001', '006'] }),
            } as Response);
            global.fetch = fetchMock as any;
            mockFetchArchiveScenes.mockResolvedValueOnce([
                { sceneId: '004', content: 'four', tokens: 4 },
                { sceneId: '002', content: 'two', tokens: 2 },
            ]);

            const result = await runDynamicElevation({
                campaignId: 'c1',
                queries: ['remember the battle'],
                scopeSceneIds: ['001', '002', '003', '004', '005', '006'],
                limit: 2,
            });

            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0];
            expect(String(url)).toContain('/archive/semantic-candidates');
            const body = JSON.parse((init as RequestInit).body as string);
            expect(body.query).toBe('remember the battle');
            expect(body.scopeSceneIds).toEqual(['001', '002', '003', '004', '005', '006']);
            expect(result.rankedSceneIds).toEqual(['004', '002', '001', '006']);
            expect(mockFetchArchiveScenes).toHaveBeenCalledWith('c1', ['004', '002'], 3000);
            expect(result.scenes).toHaveLength(2);
        });

        it('uses queries array when multiple queries are provided', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ pending: false, sceneIds: ['004'] }),
            } as Response);
            global.fetch = fetchMock as any;
            mockFetchArchiveScenes.mockResolvedValueOnce([{ sceneId: '004', content: 'four', tokens: 4 }]);

            await runDynamicElevation({
                campaignId: 'c1',
                queries: ['remember the battle', 'alt phrasing'],
                scopeSceneIds: ['001', '002'],
                limit: 5,
            });

            const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
            expect(body.queries).toEqual(['remember the battle', 'alt phrasing']);
            expect(body.query).toBeUndefined();
        });

        it('scoping respected: empty scope → no-op', async () => {
            const fetchMock = vi.fn();
            global.fetch = fetchMock as any;

            const result = await runDynamicElevation({
                campaignId: 'c1',
                queries: ['remember'],
                scopeSceneIds: [],
                limit: 5,
            });

            expect(fetchMock).not.toHaveBeenCalled();
            expect(result.scenes).toEqual([]);
            expect(result.rankedSceneIds).toEqual([]);
        });

        it('empty query → no-op', async () => {
            const fetchMock = vi.fn();
            global.fetch = fetchMock as any;

            const result = await runDynamicElevation({
                campaignId: 'c1',
                queries: ['   '],
                scopeSceneIds: ['001'],
                limit: 5,
            });

            expect(fetchMock).not.toHaveBeenCalled();
            expect(result.scenes).toEqual([]);
        });

        it('limit = 0 → no fetch', async () => {
            const fetchMock = vi.fn();
            global.fetch = fetchMock as any;

            const result = await runDynamicElevation({
                campaignId: 'c1',
                queries: ['remember'],
                scopeSceneIds: ['001'],
                limit: 0,
            });

            expect(fetchMock).not.toHaveBeenCalled();
            expect(result.scenes).toEqual([]);
        });

        it('pending: true response → empty result (model warming up)', async () => {
            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ pending: true }),
            } as Response);
            global.fetch = fetchMock as any;

            const result = await runDynamicElevation({
                campaignId: 'c1',
                queries: ['remember'],
                scopeSceneIds: ['001'],
                limit: 5,
            });

            expect(result.scenes).toEqual([]);
            expect(result.rankedSceneIds).toEqual([]);
        });

        it('non-ok response → empty result', async () => {
            const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 } as Response);
            global.fetch = fetchMock as any;

            const result = await runDynamicElevation({
                campaignId: 'c1',
                queries: ['remember'],
                scopeSceneIds: ['001'],
                limit: 5,
            });

            expect(result.scenes).toEqual([]);
        });

        it('failure → empty result (never throws)', async () => {
            const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
            global.fetch = fetchMock as any;

            const result = await runDynamicElevation({
                campaignId: 'c1',
                queries: ['remember'],
                scopeSceneIds: ['001'],
                limit: 5,
            });

            expect(result.scenes).toEqual([]);
            expect(result.rankedSceneIds).toEqual([]);
        });
    });

    describe('gatherDynamicElevation — tier gating', () => {
        it('lite tier: no-op even with full state', async () => {
            const fetchMock = vi.fn();
            global.fetch = fetchMock as any;
            const state = makeState({ settings: { aiTier: 'lite' } as any });

            const result = await gatherDynamicElevation(state, { chapters: [] });

            expect(fetchMock).not.toHaveBeenCalled();
            expect(result.scenes).toEqual([]);
        });

        it('no activeCampaignId → no-op', async () => {
            const fetchMock = vi.fn();
            global.fetch = fetchMock as any;
            const state = makeState({ activeCampaignId: null });

            const result = await gatherDynamicElevation(state, { chapters: [] });

            expect(fetchMock).not.toHaveBeenCalled();
            expect(result.scenes).toEqual([]);
        });

        it('no chapters → no-op', async () => {
            const fetchMock = vi.fn();
            global.fetch = fetchMock as any;
            const state = makeState({ chapters: [] });

            const result = await gatherDynamicElevation(state, { chapters: [] });

            expect(fetchMock).not.toHaveBeenCalled();
            expect(result.scenes).toEqual([]);
        });

        it('nothing condensed (condensedUpToIndex = -1) → no-op', async () => {
            const fetchMock = vi.fn();
            global.fetch = fetchMock as any;
            const state = makeState({
                condenser: { condensedUpToIndex: -1 },
                chapters: [mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] })],
            });

            const result = await gatherDynamicElevation(state, { chapters: state.chapters });

            expect(fetchMock).not.toHaveBeenCalled();
            expect(result.scenes).toEqual([]);
        });

        it('empty synopsis set (all summary) → no-op', async () => {
            const fetchMock = vi.fn();
            global.fetch = fetchMock as any;
            const sealed = [mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] })];
            const msgs: ChatMessage[] = [];
            for (let i = 1; i <= 3; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
            const archiveIndex = ['001', '002', '003'].map(s => mkIndexEntry(s, { witnesses: [] }));
            const state = makeState({
                chapters: sealed,
                archiveIndex,
                messages: msgs,
                condenser: { condensedUpToIndex: 2 },
            });

            const result = await gatherDynamicElevation(state, { chapters: sealed });

            expect(fetchMock).not.toHaveBeenCalled();
            expect(result.scenes).toEqual([]);
        });

        it('pro tier with synopsis scope: attaches chapterId to elevated scenes', async () => {
            const sealed: ArchiveChapter[] = [
                mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
                mkChapter({ chapterId: 'CH02', sceneRange: ['004', '006'], sceneIds: ['004', '005', '006'] }),
                mkChapter({ chapterId: 'CH03', sceneRange: ['007', '009'], sceneIds: ['007', '008', '009'] }),
                mkChapter({ chapterId: 'CH04', sceneRange: ['010', '012'], sceneIds: ['010', '011', '012'] }),
            ];
            const msgs: ChatMessage[] = [];
            for (let i = 1; i <= 12; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
            const archiveIndex: ArchiveIndexEntry[] = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012']
                .map(s => mkIndexEntry(s, { witnesses: [] }));

            const fetchMock = vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ pending: false, sceneIds: ['004', '002', '001'] }),
            } as Response);
            global.fetch = fetchMock as any;
            mockFetchArchiveScenes.mockResolvedValueOnce([
                { sceneId: '004', content: 'four', tokens: 4 },
                { sceneId: '002', content: 'two', tokens: 2 },
            ]);

            const state = makeState({
                chapters: sealed,
                archiveIndex,
                messages: msgs,
                condenser: { condensedUpToIndex: 11 },
                settings: { aiTier: 'pro', lodSummaryChapters: 2, lodImportanceBonus: 0, lodElevateScenes: 2 } as any,
            });

            const result = await gatherDynamicElevation(state, { chapters: sealed });

            expect(result.scenes).toHaveLength(2);
            expect(result.scenes[0].chapterId).toBe('CH02'); // scene 004 belongs to CH02
            expect(result.scenes[1].chapterId).toBe('CH01'); // scene 002 belongs to CH01
            expect(result.rankedSceneIds).toEqual(['004', '002', '001']);
        });

        it('failure in scoped fetch → empty result and turn proceeds', async () => {
            const sealed: ArchiveChapter[] = [
                mkChapter({ chapterId: 'CH01', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'] }),
                mkChapter({ chapterId: 'CH02', sceneRange: ['004', '006'], sceneIds: ['004', '005', '006'] }),
                mkChapter({ chapterId: 'CH03', sceneRange: ['007', '009'], sceneIds: ['007', '008', '009'] }),
                mkChapter({ chapterId: 'CH04', sceneRange: ['010', '012'], sceneIds: ['010', '011', '012'] }),
            ];
            const msgs: ChatMessage[] = [];
            for (let i = 1; i <= 12; i++) msgs.push(mkMessage(String(i).padStart(3, '0')));
            const archiveIndex: ArchiveIndexEntry[] = ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012']
                .map(s => mkIndexEntry(s, { witnesses: [] }));

            const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
            global.fetch = fetchMock as any;

            const state = makeState({
                chapters: sealed,
                archiveIndex,
                messages: msgs,
                condenser: { condensedUpToIndex: 11 },
                settings: { aiTier: 'pro', lodSummaryChapters: 2, lodImportanceBonus: 0, lodElevateScenes: 2 } as any,
            });

            const result = await gatherDynamicElevation(state, { chapters: sealed });

            expect(result.scenes).toEqual([]);
            expect(result.rankedSceneIds).toEqual([]);
        });
    });

    describe('dedupElevatedScenes', () => {
        it('skips scenes already present in regular recall', () => {
            const elevated = [
                { sceneId: '004', content: 'four', tokens: 4, chapterId: 'CH02' },
                { sceneId: '002', content: 'two', tokens: 2, chapterId: 'CH01' },
                { sceneId: '001', content: 'one', tokens: 1, chapterId: 'CH01' },
            ];
            const regularIds = new Set(['002', '005']);

            const result = dedupElevatedScenes(elevated, regularIds);

            expect(result.map(s => s.sceneId)).toEqual(['004', '001']);
        });

        it('keeps all when regular recall is empty', () => {
            const elevated = [
                { sceneId: '004', content: 'four', tokens: 4, chapterId: 'CH02' },
                { sceneId: '002', content: 'two', tokens: 2, chapterId: 'CH01' },
            ];

            const result = dedupElevatedScenes(elevated, new Set());

            expect(result).toHaveLength(2);
        });

        it('drops all when regular recall contains them all', () => {
            const elevated = [
                { sceneId: '004', content: 'four', tokens: 4, chapterId: 'CH02' },
                { sceneId: '002', content: 'two', tokens: 2, chapterId: 'CH01' },
            ];
            const regularIds = new Set(['002', '004']);

            const result = dedupElevatedScenes(elevated, regularIds);

            expect(result).toEqual([]);
        });
    });
});