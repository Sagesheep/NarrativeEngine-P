import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression guard for a live data-loss bug: `loadCampaignState` read back only
// `{ context, messages, condenser }`, so `pinnedExcerpts` came back undefined,
// hydration defaulted it to [], and the next save wrote that empty array over
// the user's pinned memories.
//
// The server has a preserve-guard for an *omitted* pinnedExcerpts field, but
// every client save path sends the field explicitly, so the guard never fired.
// The round-trip below is the property that actually protects the data.

const PINS = [
    { id: 'pin-1', sceneId: '001', text: 'The bridge burned.', chapterId: 'CH01' },
    { id: 'pin-2', sceneId: '004', text: 'Elara kept the key.', chapterId: 'CH01' },
];

const RECORD = {
    context: { loreRaw: 'lore' },
    messages: [{ id: 'm1', role: 'user', content: 'hello' }],
    condenser: { summary: '', upToIndex: 0 },
    pinnedExcerpts: PINS,
};

it('round-trips glossary entries independently for two campaigns and preserves older saves', async () => {
    const { loadCampaignState, saveCampaignState } = await import('../campaignStore');
    const { migrateLegacyContext } = await import('../../types');
    const records = new Map<string, unknown>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') records.set(url, JSON.parse(String(init.body)));
        return { ok: records.has(url), json: async () => records.get(url) };
    });
    const glossary = [{ id: 'house', name: 'House Veyran', aliases: 'the Veyrans', description: 'Salt traders.', category: 'Family' }];
    await saveCampaignState('a', { context: migrateLegacyContext({ glossary }), messages: [], condenser: { condensedUpToIndex: -1 } });
    await saveCampaignState('b', { context: migrateLegacyContext({}), messages: [], condenser: { condensedUpToIndex: -1 } });
    expect(migrateLegacyContext((await loadCampaignState('a'))!.context).glossary).toEqual(glossary);
    expect(migrateLegacyContext((await loadCampaignState('b'))!.context).glossary).toBeUndefined();
    expect(migrateLegacyContext({}).glossary).toBeUndefined();
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => RECORD }));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('loadCampaignState', () => {
    it('reads pinnedExcerpts back off the record', async () => {
        const { loadCampaignState } = await import('../campaignStore');
        const state = await loadCampaignState('c1');
        expect(state?.pinnedExcerpts).toEqual(PINS);
    });

    it('still returns the other persisted fields', async () => {
        const { loadCampaignState } = await import('../campaignStore');
        const state = await loadCampaignState('c1');
        expect(state?.context).toEqual(RECORD.context);
        expect(state?.messages).toEqual(RECORD.messages);
        expect(state?.condenser).toEqual(RECORD.condenser);
    });

    it('defaults pinnedExcerpts to an empty array when the record has none', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ context: {}, messages: [], condenser: null }),
        });
        const { loadCampaignState } = await import('../campaignStore');
        const state = await loadCampaignState('c1');
        expect(state?.pinnedExcerpts).toEqual([]);
    });

    it('returns null when the campaign has no saved state', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
        const { loadCampaignState } = await import('../campaignStore');
        expect(await loadCampaignState('missing')).toBeNull();
    });

    it('survives a save/load round trip without dropping pins', async () => {
        const { loadCampaignState, saveCampaignState } = await import('../campaignStore');

        // What the client would persist for a campaign that has pins.
        let persisted: Record<string, unknown> | null = null;
        fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
            if (init?.method === 'PUT') {
                persisted = JSON.parse(String(init.body));
                return { ok: true, json: async () => ({ ok: true }) };
            }
            return { ok: true, json: async () => persisted ?? RECORD };
        });

        const loaded = await loadCampaignState('c1');
        await saveCampaignState('c1', loaded!);
        const reloaded = await loadCampaignState('c1');

        expect(persisted).not.toBeNull();
        expect((persisted as unknown as { pinnedExcerpts?: unknown }).pinnedExcerpts).toEqual(PINS);
        expect(reloaded?.pinnedExcerpts).toEqual(PINS);
    });
});

it('round-trips campaign injections independently for two campaigns', async () => {
    const { loadCampaignState, saveCampaignState } = await import('../campaignStore');
    const { migrateLegacyContext } = await import('../../types');
    const records = new Map<string, unknown>();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === 'PUT') records.set(url, JSON.parse(String(init.body)));
        return { ok: records.has(url), json: async () => records.get(url) };
    });
    const card = {
        id: 'a', name: 'A only', content: 'Rain', enabled: true, role: 'system' as const,
        depth: 2, mode: 'message' as const, triggers: ['reply' as const],
    };
    await saveCampaignState('a', { context: migrateLegacyContext({ promptInjections: [card] }), messages: [], condenser: { condensedUpToIndex: -1 } });
    await saveCampaignState('b', { context: migrateLegacyContext({ promptInjections: [] }), messages: [], condenser: { condensedUpToIndex: -1 } });
    expect(migrateLegacyContext((await loadCampaignState('a'))!.context).promptInjections).toEqual([card]);
    expect(migrateLegacyContext((await loadCampaignState('b'))!.context).promptInjections).toEqual([]);
    expect(migrateLegacyContext({}).promptInjections).toBeUndefined();
});
