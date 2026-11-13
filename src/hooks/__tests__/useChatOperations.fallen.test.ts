/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { InventoryProposal } from '../../types';

vi.mock('../../services/turn/turnOrchestrator', () => ({ runTurn: vi.fn() }));
vi.mock('../../services/turn/pendingCommit', () => ({
    commitPendingTurn: vi.fn(),
    findRetryableMessage: () => null,
    persistPendingTurn: vi.fn(),
}));
vi.mock('../../store/slices/campaignSlice', () => ({ debouncedSaveCampaignState: vi.fn() }));

vi.mock('../../store/useAppStore', () => {
    const state: Record<string, any> = {
        context: {},
        activeCampaignId: 'camp_test',
        deepArmed: false,
        setDeepArmed: vi.fn(),
        setArchiveIndex: vi.fn(),
        updateLastAssistant: vi.fn(),
        updateLastAssistantMessage: vi.fn(),
        updateContext: vi.fn(),
        setCondensed: vi.fn(),
        setTimeline: vi.fn(),
        setChapters: vi.fn(),
        pipelinePhase: 'idle',
        setPipelinePhase: vi.fn(),
        setStreamingStats: vi.fn(),
        messages: [],
    };
    const listeners = new Set<(s: any, p: any) => void>();
    const useAppStore = Object.assign(
        (selector: any) => (typeof selector === 'function' ? selector(state) : state),
        {
            getState: () => state,
            subscribe: (fn: (s: any, p: any) => void) => {
                listeners.add(fn);
                return () => { listeners.delete(fn); };
            },
            __setContext: (context: any) => {
                const prev = { ...state };
                state.context = context;
                listeners.forEach(fn => fn(state, prev));
            },
        },
    );
    return { useAppStore };
});

import { useChatOperations } from '../useChatOperations';
import { useAppStore } from '../../store/useAppStore';

const proposal = { id: 'p1' } as unknown as InventoryProposal;

function args(): Parameters<typeof useChatOperations>[0] {
    return {
        input: '',
        setInput: vi.fn(),
        resetTextareaHeight: vi.fn(),
        oocBusy: false,
        armedAskGmBrief: null,
        setArmedAskGmBrief: vi.fn(),
        sceneContinue: { getAbortController: () => null } as any,
        checkAndSealChapter: vi.fn(),
    };
}

describe('pending inventory proposal and a fallen character', () => {
    beforeEach(() => {
        (useAppStore as any).__setContext({});
    });

    it('keeps a staged proposal while combatFallen is not set', () => {
        const { result } = renderHook(() => useChatOperations(args()));
        act(() => result.current.setPendingProposal(proposal));
        act(() => (useAppStore as any).__setContext({ other: 1 }));
        expect(result.current.pendingProposal).toBe(proposal);
    });

    it('clears a staged proposal once combatFallen is set', () => {
        const { result } = renderHook(() => useChatOperations(args()));
        act(() => result.current.setPendingProposal(proposal));
        expect(result.current.pendingProposal).toBe(proposal);
        act(() => (useAppStore as any).__setContext({ combatFallen: { name: 'Kira', mode: 'ironman', at: 1, stage: 'fallen' } }));
        expect(result.current.pendingProposal).toBeNull();
    });
});
