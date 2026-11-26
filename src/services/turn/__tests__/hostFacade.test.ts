import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, ArchiveIndexEntry, ChatMessage, EndpointConfig, LoreChunk, NPCEntry, SemanticFact, TimelineEvent } from '../../../types';
import type { TurnCallbacks, TurnState } from '../turnOrchestrator';
import { buildHostFacade, type HostFacade } from '../hostFacade';

const endpoint = (modelName: string): EndpointConfig => ({
    endpoint: `http://${modelName}`,
    apiKey: `${modelName}-secret`,
    modelName,
});

const makeState = (activeCampaignId = 'campaign-a'): TurnState => ({
    input: 'player input',
    displayInput: 'player input',
    settings: {
        contextLimit: 8192,
        aiTier: 'max',
        archiveRecallDepth: 'deep',
        autoArchiveStaleNPCsTurns: 12,
        divergenceScanBudget: 2048,
        enableArchivePlanner: true,
        lodElevateScenes: 3,
        lodImportanceBonus: 4,
        lodSlottedMaxPerScene: 5,
        lodSummaryChapters: 8,
        apiKey: 'legacy-secret',
        providers: [{ apiKey: 'provider-secret' }],
    } as unknown as AppSettings,
    context: { currentPlaceId: 'place-a' } as TurnState['context'],
    messages: [{ id: 'm1', role: 'user', content: 'hello' } as unknown as ChatMessage],
    condenser: { condensedUpToIndex: 0 } as TurnState['condenser'],
    loreChunks: [{ id: 'l1', header: 'Lore', content: 'text' } as unknown as LoreChunk],
    npcLedger: [{ id: 'n1', name: 'Nadia' } as unknown as NPCEntry],
    archiveIndex: [{ sceneId: '001', summary: 'scene' } as unknown as ArchiveIndexEntry],
    activeCampaignId,
    provider: endpoint('story'),
    getMessages: () => [],
    getFreshProvider: () => endpoint('story'),
    getUtilityEndpoint: () => endpoint('utility'),
    getFreshAuxiliaryProvider: () => endpoint('auxiliary'),
    getRawAuxiliaryProvider: () => endpoint('raw-auxiliary'),
    getRawSummariserProvider: () => endpoint('raw-summariser'),
    onStageNpcIds: ['n1'],
    timeline: [{ sceneId: '001', summary: 'event' } as unknown as TimelineEvent],
    chapters: [],
    pinnedChapterIds: [],
    clearPinnedChapters: vi.fn(),
    setChapters: vi.fn(),
    incrementBookkeepingTurnCounter: vi.fn(() => 1),
    resetBookkeepingTurnCounter: vi.fn(),
    autoBookkeepingInterval: 5,
    getFreshContext: () => ({ currentPlaceId: 'place-a' } as TurnState['context']),
    divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
    semanticFacts: [{ id: 'f1', fact: 'fact' } as unknown as SemanticFact],
});

const makeCallbacks = (): TurnCallbacks => ({
    onCheckingNotes: vi.fn(),
    addMessage: vi.fn(),
    updateLastAssistant: vi.fn(),
    updateLastMessage: vi.fn(),
    updateLastAssistantMessage: vi.fn(),
    updateContext: vi.fn(),
    getFreshLocationState: vi.fn(() => ({ activeCampaignId: 'campaign-a', locationLedger: [], context: {} as TurnState['context'] })),
    setCharacterProfileData: vi.fn(),
    setInventoryItems: vi.fn(),
    setLocationLedger: vi.fn(),
    addLocationSuggestions: vi.fn(),
    setArchiveIndex: vi.fn(),
    updateNPC: vi.fn(),
    addNPC: vi.fn(),
    setCondensed: vi.fn(),
    setStreaming: vi.fn(),
    archiveNPC: vi.fn(),
    restoreNPC: vi.fn(),
});

function visit(value: unknown, path: string, onValue: (value: unknown, path: string) => void): void {
    onValue(value, path);
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`, onValue);
}

function expectDeeplyFrozen(value: unknown): void {
    visit(value, '$', (child) => {
        if (child !== null && typeof child === 'object') expect(Object.isFrozen(child)).toBe(true);
    });
}

describe('HostFacade', () => {
    it('deeply freezes the data snapshot and never exposes settings credentials', () => {
        const facade = buildHostFacade(makeState(), makeCallbacks());
        expectDeeplyFrozen(facade.data);

        const credentialPaths: string[] = [];
        visit(facade, '$', (value, path) => {
            if (typeof value === 'string' && /apiKey/i.test(value)) credentialPaths.push(path);
            if (path.toLowerCase().includes('apikey')) credentialPaths.push(path);
        });
        expect(credentialPaths).toEqual([]);
    });

    it('brokers all six model roles without returning an endpoint', async () => {
        const calls: Array<{ role: string; endpoint: string | undefined }> = [];
        const facade = buildHostFacade(makeState(), makeCallbacks(), {
            modelCall: async (role, _request, resolved) => {
                calls.push({ role, endpoint: resolved?.modelName });
                return { content: resolved?.modelName ?? 'none' };
            },
        });

        const roles = ['story', 'utility', 'auxiliary', 'summariser', 'raw-auxiliary', 'raw-summariser'] as const;
        const responses = await Promise.all(roles.map((role) => facade.model.call(role, { prompt: role })));

        expect(calls).toEqual([
            { role: 'story', endpoint: 'story' },
            { role: 'utility', endpoint: 'utility' },
            { role: 'auxiliary', endpoint: 'auxiliary' },
            { role: 'summariser', endpoint: 'raw-summariser' },
            { role: 'raw-auxiliary', endpoint: 'raw-auxiliary' },
            { role: 'raw-summariser', endpoint: 'raw-summariser' },
        ]);
        expect(responses.map((response) => response.content)).toEqual([
            'story', 'utility', 'auxiliary', 'raw-summariser', 'raw-auxiliary', 'raw-summariser',
        ]);
        expect(Object.keys(facade)).not.toContain('settings');
    });

    it('a story fallback for the summariser role carries the summarizer slot thinking level', async () => {
        const efforts: Array<string | undefined> = [];
        const story = { ...endpoint('story'), thinkingEffort: 'high' as const };
        const state: TurnState = {
            ...makeState(),
            settings: {
                ...makeState().settings,
                activePresetId: 'pr',
                presets: [{ id: 'pr', name: 'P', storyAIProviderId: 's', slotThinking: { story: 'high', summarizer: 'off' } }],
            } as AppSettings,
            provider: story,
            getFreshProvider: () => story,
            getRawSummariserProvider: () => undefined,
        };
        const facade = buildHostFacade(state, makeCallbacks(), {
            modelCall: async (_role, _request, resolved) => {
                efforts.push((resolved as EndpointConfig | undefined)?.thinkingEffort);
                return { content: '' };
            },
        });

        await facade.model.call('summariser', { prompt: 'x' });
        await facade.model.call('story', { prompt: 'x' });

        expect(efforts).toEqual(['off', 'high']);
        expect(story.thinkingEffort).toBe('high');
    });


    it('runs the host-side JSON retry once and exposes role availability without credentials', async () => {
        const prompts: string[] = [];
        const facade = buildHostFacade(makeState(), makeCallbacks(), {
            modelCall: async (_role, request) => {
                prompts.push(request.prompt);
                return { content: prompts.length === 1 ? 'not json' : '{"ok":true}' };
            },
        });

        await expect(facade.model.callJson('utility', { prompt: 'return json' }, { retries: 99 }))
            .resolves.toEqual({ ok: true });

        expect(prompts).toHaveLength(2);
        expect(prompts[1]).toContain('IMPORTANT: Your previous response was not valid JSON');
        expect(facade.model.available('utility')).toBe(true);
        expect(facade.model.available('raw-auxiliary')).toBe(true);
    });

    it('enumerates the stable top-level facade surface', () => {
        const facade = buildHostFacade(makeState(), makeCallbacks());
        expect(Object.keys(facade)).toEqual([
            'data', 'config', 'write', 'model', 'table', 'signal', 'refresh', 'log',
        ]);
        expect(Object.keys(facade)).toHaveLength(8);
    });

    it('refresh returns a new frozen snapshot without mutating the old one', () => {
        let current = makeState('campaign-a');
        const facade = buildHostFacade(current, makeCallbacks(), { getState: () => current });
        current = makeState('campaign-b');

        const refreshed: HostFacade = facade.refresh();

        expect(refreshed).not.toBe(facade);
        expect(refreshed.data).not.toBe(facade.data);
        expect(facade.data.activeCampaignId).toBe('campaign-a');
        expect(refreshed.data.activeCampaignId).toBe('campaign-b');
        expectDeeplyFrozen(facade.data);
        expectDeeplyFrozen(refreshed.data);
    });
});
