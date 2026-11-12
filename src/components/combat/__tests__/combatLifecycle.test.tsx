import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen, waitFor, act } from '@testing-library/react';

vi.mock('../../../services/combat/combatController', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../services/combat/combatController')>();
    return { ...actual, startFromProposal: vi.fn(async () => true), resumeStoredSession: vi.fn() };
});

import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { startFromProposal, resumeStoredSession } from '../../../services/combat/combatController';
import { markProposedMessage, resetProposedMessages } from '../../../services/combat/combatCommitHooks';
import { shouldOfferCombat, stakesOfferKey, useCombatLifecycle } from '../useCombatLifecycle';
import { CombatAllocationHint, StartCombatButton } from '../StartCombatButton';
import type { CombatProposal, CombatSheet, GameContext } from '../../../types';

const sheet: CombatSheet = { abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 10, CHA: 10 }, budget: 'NORMAL', level: 3, needsAllocation: false };
const proposal: CombatProposal = { id: 'p', messageId: 'gm', combatants: [{ name: 'Bandit', side: 'enemy', tier: 'grunt' }], reason: 'r', source: 'tool' };

function setContext(patch: Partial<GameContext>) {
    useAppStore.setState({ context: { ...useAppStore.getState().context, ...patch } as GameContext });
}

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    resetProposedMessages();
    useAppStore.setState({
        activeCampaignId: 'c1',
        messages: [{ id: 'gm', role: 'assistant', content: 'x', timestamp: 1, sceneId: '001' }],
        pipelinePhase: 'idle',
        combatProposal: null,
        combatSession: null,
    });
    setContext({ combatModeActive: true, combatSheet: sheet, combatConfig: undefined, lastSceneStakes: 'calm' });
});

afterEach(() => {
    cancelPendingSaves();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('confirmStart off (T3 rule 6)', () => {
    it('starts a tool proposal immediately once the turn is idle', async () => {
        setContext({ combatConfig: { ...useAppStore.getState().context.combatConfig!, confirmStart: false } });
        useAppStore.setState({ combatProposal: proposal, pipelinePhase: 'generating' });
        const { rerender } = renderHook(({ streaming }) => useCombatLifecycle(streaming), { initialProps: { streaming: true } });
        expect(vi.mocked(startFromProposal)).not.toHaveBeenCalled();
        act(() => { useAppStore.setState({ pipelinePhase: 'idle' }); });
        rerender({ streaming: false });
        await waitFor(() => expect(vi.mocked(startFromProposal)).toHaveBeenCalledWith(proposal));
    });

    it('waits for the player when confirmStart is on', () => {
        useAppStore.setState({ combatProposal: proposal });
        renderHook(() => useCombatLifecycle(false));
        expect(vi.mocked(startFromProposal)).not.toHaveBeenCalled();
    });

    it('clears a proposal whose message was deleted', async () => {
        useAppStore.setState({ combatProposal: proposal });
        renderHook(() => useCombatLifecycle(false));
        act(() => { useAppStore.setState({ messages: [] }); });
        await waitFor(() => expect(useAppStore.getState().combatProposal).toBeNull());
    });
});

describe('restart (A11)', () => {
    it('finishes a stored session that already has an outcome, and leaves an open fight alone', () => {
        useAppStore.setState({ combatSession: { state: { outcome: null } } as never });
        const { rerender } = renderHook(() => useCombatLifecycle(false));
        expect(vi.mocked(resumeStoredSession)).not.toHaveBeenCalled();
        act(() => { useAppStore.setState({ combatSession: { state: { outcome: 'victory' } } as never }); });
        rerender();
        expect(vi.mocked(resumeStoredSession)).toHaveBeenCalled();
    });
});

describe('stakes offer', () => {
    const base = { hasProposal: false, hasSession: false, offerKey: 'gm', dismissedKey: null };
    const ctx = { combatModeActive: true, combatSheet: sheet, lastSceneStakes: 'dangerous' as const };

    it('offers combat after a committed dangerous turn', () => {
        expect(shouldOfferCombat({ ...base, context: ctx })).toBe(true);
        expect(shouldOfferCombat({ ...base, context: { ...ctx, lastSceneStakes: 'tense' } })).toBe(false);
        expect(shouldOfferCombat({ ...base, context: { ...ctx, combatModeActive: false } })).toBe(false);
        expect(shouldOfferCombat({ ...base, hasSession: true, context: ctx })).toBe(false);
        expect(shouldOfferCombat({ ...base, dismissedKey: 'gm', context: ctx })).toBe(false);
        expect(shouldOfferCombat({ ...base, context: { ...ctx, combatConfig: { offerOnDangerous: false } as never } })).toBe(false);
    });

    it('does not re-offer for a message that already had a proposal, or after a fight result', () => {
        markProposedMessage('gm');
        expect(shouldOfferCombat({ ...base, context: ctx })).toBe(false);
        expect(stakesOfferKey([{ id: 'gm', role: 'assistant', content: '', timestamp: 1, sceneId: '1' }, { id: 'r', role: 'system', name: 'combat-result', content: '', timestamp: 2 }])).toBeNull();
    });
});

describe('combat off leaves the UI unchanged', () => {
    it('renders no Start combat button or notice when combat is off, and only one of them when it is on', () => {
        const row = () => <><CombatAllocationHint variant="notice" /><StartCombatButton isStreaming={false} /></>;
        setContext({ combatModeActive: false });
        const { container, rerender } = render(row());
        expect(container).toBeEmptyDOMElement();
        act(() => setContext({ combatModeActive: true, combatSheet: { ...sheet, needsAllocation: true } }));
        rerender(row());
        expect(screen.queryByTestId('start-combat-button')).toBeNull();
        expect(screen.getByTestId('combat-alloc-hint')).toBeInTheDocument();
        act(() => setContext({ combatSheet: sheet }));
        rerender(row());
        expect(screen.getByTestId('start-combat-button')).toBeInTheDocument();
        expect(screen.queryByTestId('combat-alloc-hint')).toBeNull();
    });
});

describe('restart mid-fight', () => {
    it('keeps an engine-run turn moving after a reload', () => {
        useAppStore.setState({ combatSession: { state: { id: 's', outcome: null, order: ['e'], turnIndex: 0, combatants: { e: { id: 'e', controller: 'engine', status: 'up' } } } } as never });
        renderHook(() => useCombatLifecycle(false));
        expect(vi.mocked(resumeStoredSession)).toHaveBeenCalled();
    });
});
