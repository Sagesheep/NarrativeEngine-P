import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../useAppStore';
import { hydrateCampaign } from '../campaignHydrator';
import { cancelPendingSaves, flushAllPendingSaves, hasPendingSaves } from '../slices/campaignSlice';
import type { CombatProposal, CombatSession } from '../../types';

vi.mock('../campaignStore', () => ({
    loadCampaignState: vi.fn().mockResolvedValue({
        context: {
            combatConfig: { combatAutoDetect: true, combatKeywords: ['fight'], mookJitterRange: 2 },
        },
        messages: [],
        condenser: { condensedUpToIndex: -1 },
        pinnedExcerpts: [],
    }),
    getLoreChunks: vi.fn().mockResolvedValue([]),
    getNPCLedger: vi.fn().mockResolvedValue([]),
    loadArchiveIndex: vi.fn().mockResolvedValue([]),
    loadTimeline: vi.fn().mockResolvedValue([]),
    loadChapters: vi.fn().mockResolvedValue([]),
    loadEntities: vi.fn().mockResolvedValue([]),
    loadDivergenceRegister: vi.fn().mockResolvedValue({ entries: [], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 }),
    saveDivergenceRegister: vi.fn(),
    saveChapters: vi.fn(),
    saveNPCLedger: vi.fn(),
    saveCampaignState: vi.fn(),
}));

function session(id: string): CombatSession {
    return {
        state: {
            id, round: 1, order: ['pc'], turnIndex: 0,
            combatants: { pc: { id: 'pc', name: 'Kira', side: 'player', controller: 'player', tier: 'grunt', abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 }, maxHp: 10, hp: 10, ac: 10, attackBonus: 2, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' }, initiative: 10, status: 'up', conditions: [] } },
            rngSeed: 1, rngCursor: 0, eventSeq: 0, outcome: null,
        },
        log: [],
        narratedThroughSeq: 0,
        startedAtMessageId: 'm1',
        reason: 'Ambush',
    };
}

const proposal: CombatProposal = { id: 'p1', messageId: 'm1', combatants: [{ name: 'Bandit', side: 'enemy', tier: 'grunt' }], reason: 'Ambush', source: 'tool' };

const combatRecords: Record<string, unknown> = {
    'combat-a': { session: session('fight-1') },
    'combat-b': { session: { id: 'broken' } },
};

describe('combat table lifecycle', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.useFakeTimers();
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            const m = /^\/api\/campaigns\/([^/]+)\/combat$/.exec(url);
            if (m && !init) {
                const record = combatRecords[m[1]];
                return record === undefined
                    ? { ok: false, json: async () => null }
                    : { ok: true, json: async () => record };
            }
            if (/\/locations$/.test(url) && !init) return { ok: true, json: async () => [] };
            return { ok: true, json: async () => ({ ok: true }) };
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        cancelPendingSaves();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    const combatPuts = () => fetchMock.mock.calls.filter(([url, init]) => /\/combat$/.test(url) && init?.method === 'PUT');

    it('hydrates the stored session and normalizes legacy combat config', async () => {
        await hydrateCampaign('combat-a');
        const s = useAppStore.getState();
        expect(s.combatSession).toMatchObject(session('fight-1'));
        expect(s.combatSession?.state.grid).toMatchObject({ width: 14, height: 10 });
        expect(s.combatSession?.state.rngCursor).toBe(session('fight-1').state.rngCursor);
        expect(s.combatProposal).toBeNull();
        expect(s.context.combatModeActive).toBeUndefined();
        expect(s.context.combatSheet).toBeUndefined();
        expect(s.context.combatConfig).toMatchObject({ partyControl: 'engine', mookJitterRange: 2 });
        expect(s.context.combatConfig).not.toHaveProperty('combatKeywords');
    });

    it('hydrates an empty table when the file is missing or malformed', async () => {
        await hydrateCampaign('combat-missing');
        expect(useAppStore.getState().combatSession).toBeNull();
        await hydrateCampaign('combat-b');
        expect(useAppStore.getState().combatSession).toBeNull();
    });

    it('saves the session on change with a debounce', async () => {
        await hydrateCampaign('combat-missing');
        useAppStore.getState().setCombatSession(session('fight-2'));
        useAppStore.getState().setCombatSession({ ...session('fight-2'), narratedThroughSeq: 3 });
        expect(combatPuts()).toHaveLength(0);
        expect(hasPendingSaves()).toBe(true);

        await vi.advanceTimersByTimeAsync(1000);

        const puts = combatPuts();
        expect(puts).toHaveLength(1);
        expect(puts[0][0]).toBe('/api/campaigns/combat-missing/combat');
        expect(JSON.parse(puts[0][1]?.body as string)).toEqual({ session: { ...session('fight-2'), narratedThroughSeq: 3 } });
    });

    it('flushes a pending save immediately', async () => {
        await hydrateCampaign('combat-missing');
        useAppStore.getState().resetCombat();
        await flushAllPendingSaves();
        const puts = combatPuts();
        expect(puts).toHaveLength(1);
        expect(JSON.parse(puts[0][1]?.body as string)).toEqual({ session: null });
    });

    it('keeps the proposal in memory only', async () => {
        await hydrateCampaign('combat-missing');
        useAppStore.getState().setCombatProposal(proposal);
        await vi.advanceTimersByTimeAsync(1000);
        expect(useAppStore.getState().combatProposal).toEqual(proposal);
        expect(combatPuts()).toHaveLength(0);
    });

    it('clears combat state when switching campaigns', async () => {
        await hydrateCampaign('combat-a');
        useAppStore.getState().setCombatProposal(proposal);
        cancelPendingSaves();

        await useAppStore.getState().setActiveCampaign('combat-missing');
        expect(useAppStore.getState().combatSession).toBeNull();
        expect(useAppStore.getState().combatProposal).toBeNull();

        await hydrateCampaign('combat-missing');
        expect(useAppStore.getState().combatSession).toBeNull();
        expect(combatPuts()).toHaveLength(0);
    });
});
