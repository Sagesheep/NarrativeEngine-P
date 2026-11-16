import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../turn/pendingCommit', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../turn/pendingCommit')>();
    return { ...actual, commitPendingTurn: vi.fn(async () => {}) };
});

vi.mock('../combatNarration', () => ({
    queueCombatNarration: vi.fn(() => []),
    waitForCombatNarration: vi.fn(async () => {}),
    abortCombatNarration: vi.fn(),
    rewriteCombatBeat: vi.fn(),
}));

vi.mock('../../llm/apiClient', () => ({
    api: {
        archive: { append: vi.fn(async () => ({ sceneId: '042' })), getIndex: vi.fn(async () => []) },
        timeline: { get: vi.fn(async () => []) },
        chapters: { list: vi.fn(async () => []) },
    },
}));

import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { finishCombat, setCombatStepDelay, startFromProposal } from '../combatController';
import { requestManualCombat } from '../combatManualStart';
import { resetProposedMessages } from '../combatCommitHooks';
import type { ChatMessage, CombatProposal, CombatSheet, GameContext } from '../../../types';

const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };
const gm: ChatMessage = { id: 'gm-1', role: 'assistant', content: 'Bandits!', timestamp: 100 };

function proposal(extra: Partial<CombatProposal> = {}): CombatProposal {
    return {
        id: 'p1', messageId: 'gm-1', reason: 'Ambush on the road', source: 'tool',
        combatants: [{ name: 'Bandit', side: 'enemy', tier: 'grunt' }, { name: 'Captain Vey', side: 'enemy', tier: 'elite' }],
        ...extra,
    };
}

function seed(config: Record<string, unknown> = {}) {
    const base = useAppStore.getState().context;
    const context = {
        ...base,
        combatModeActive: true,
        combatSheet: sheet,
        combatConfig: { ...base.combatConfig, narrationCadence: 'side', ...config },
        characterProfileData: { ...base.characterProfileData, name: 'Kira', hp: { current: 28, max: 28 } },
        inventoryItems: [],
    } as GameContext;
    useAppStore.setState({
        activeCampaignId: 'camp-1',
        messages: [{ id: 'u1', role: 'user', content: 'I walk on.', timestamp: 50 }, gm],
        context,
        characterProfileData: context.characterProfileData,
        npcLedger: [],
        pipelinePhase: 'idle',
        combatSession: null,
        combatProposal: null,
        combatBusy: false,
    });
}

beforeEach(() => {
    setCombatStepDelay(0);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    resetProposedMessages();
    seed();
});

afterEach(() => {
    cancelPendingSaves();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

const session = () => useAppStore.getState().combatSession!;

describe('starting a fight with an objective', () => {
    it('hands the objective to the engine and adds the ward the model named but did not list', async () => {
        await startFromProposal(proposal({ objective: { win: 'protect', ward: 'Old Marta', rounds: 4 } }), 11);
        const state = session().state;
        const ward = Object.values(state.combatants).find(c => c.name === 'Old Marta');
        expect(ward).toMatchObject({ side: 'ally', tier: 'grunt', mark: 'ward', tactic: 'coward' });
        expect(state.objective?.win).toMatchObject({ kind: 'protect', wardId: ward?.id, rounds: 4 });
        expect(state.objective?.lose).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'ward_falls' })]));
    });

    it('resolves the leader by name, whatever the case', async () => {
        await startFromProposal(proposal({ objective: { win: 'defeat_leader', leader: 'captain vey' } }), 11);
        const state = session().state;
        const vey = Object.values(state.combatants).find(c => c.name === 'Captain Vey');
        expect(state.objective?.win).toEqual({ kind: 'defeat_leader', leaderId: vey?.id });
        expect(vey?.mark).toBe('leader');
    });

    it('keeps the ward in the fight when the party is played solo', async () => {
        seed({ partyControl: 'solo' });
        await startFromProposal(proposal({
            combatants: [{ name: 'Bandit', side: 'enemy', tier: 'grunt' }, { name: 'Bob', side: 'ally', tier: 'grunt' }],
            objective: { win: 'protect', ward: 'Old Marta', rounds: 4 },
        }), 11);
        const names = Object.values(session().state.combatants).map(c => c.name);
        expect(names).toContain('Old Marta');
        expect(names).not.toContain('Bob');
        expect(session().excluded).toEqual(['Bob']);
    });

    it('a fight with no objective has none in the state', async () => {
        await startFromProposal(proposal(), 11);
        expect(session().state.objective).toBeUndefined();
        expect(session().log.some(e => e.type.startsWith('objective'))).toBe(false);
    });

    it('a repaired objective is the one played', async () => {
        await startFromProposal(proposal({ objective: { win: 'survive', rounds: 99 } }), 11);
        expect(session().state.objective?.win).toMatchObject({ kind: 'survive', rounds: 8 });
    });

    it('a saved fight keeps its objective, marks and reinforcements through a reload', async () => {
        await startFromProposal(proposal({ objective: { win: 'survive', rounds: 4, reinforcements: 'many' } }), 11);
        const { normalizeCombatSession } = await import('../../tables/combatTable');
        const saved = JSON.parse(JSON.stringify(session()));
        const loaded = normalizeCombatSession(saved);
        expect(loaded?.state.objective).toEqual(session().state.objective);
        expect(loaded?.state.reinforcements).toEqual(session().state.reinforcements);
        expect(loaded?.state.reinforcements?.waves.length).toBeGreaterThan(0);
    });

    it('manual start stages the objective the model suggests, with the ward added', async () => {
        const call = vi.fn(async () => '{"combatants":[{"name":"Wolf"},{"name":"Wolf"}],"objective":{"win":"protect","ward":"Shepherd","rounds":3,"reinforcements":"some"},"reason":"Wolves"}');
        const out = await requestManualCombat(call);
        expect(out?.objective).toEqual({ win: 'protect', ward: 'Shepherd', rounds: 3, reinforcements: 'some' });
        expect(out?.combatants.map(c => c.name)).toEqual(['Wolf 1', 'Wolf 2', 'Shepherd']);
        expect(useAppStore.getState().combatProposal?.objective?.ward).toBe('Shepherd');
    });
});

describe('finishing a fight that had an objective', () => {
    it('keeps the escaped player character\'s HP, posts the objective in the result and tells the story model who got out', async () => {
        await startFromProposal(proposal({ objective: { win: 'escape' } }), 11);
        const live = session();
        const pc = Object.values(live.state.combatants).find(c => c.side === 'player')!;
        const escaped = { ...pc, status: 'escaped' as const, hp: 17, position: undefined };
        const objective = live.state.objective!;
        useAppStore.getState().setCombatSession({
            ...live,
            state: {
                ...live.state,
                combatants: { ...live.state.combatants, [pc.id]: escaped },
                outcome: 'victory',
                objective: { ...objective, result: { status: 'won', by: 'escape', round: 3, outcome: 'victory', side: undefined } },
            },
        });
        await finishCombat();
        const s = useAppStore.getState();
        expect(s.combatSession).toBeNull();
        expect(s.characterProfileData.hp.current).toBe(17);
        const result = s.messages.find(m => m.name === 'combat-result')!;
        expect(result.content).toContain('Objective achieved by getting out through the exit.');
        expect(result.content).toContain('Left through the exit: Kira.');
        const aftermath = s.context.combatAftermath?.text ?? '';
        expect(aftermath).toContain('Got out through the exit: Kira. They are safe and alive.');
        expect(aftermath).not.toContain('unconscious');
    });
});
