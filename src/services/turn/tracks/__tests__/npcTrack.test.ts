/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage, GameContext, NPCEntry } from '../../../../types';
import type { TurnState, TurnCallbacks } from '../../turnOrchestrator';

/**
 * WO-P2-03 characterization test for `track.npc`.
 *
 * Pins the behaviour the migration had to preserve: the exclusion list handed to the
 * detector, the tier gates, the cooldown filter, the suggestion write, the background
 * queue labels, and — the important one — the `guardedUpdateNPC` campaign-id race guard
 * that wraps all three post-await write paths.
 */

let mockActiveCampaignId: string | null = 'campaign-1';
vi.mock('../../../../store/useAppStore', () => ({
    useAppStore: { getState: () => ({ activeCampaignId: mockActiveCampaignId }) },
}));
vi.mock('../../../infrastructure/backgroundQueue', () => ({
    backgroundQueue: { push: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../../npc/npcDetector', () => ({
    extractNPCNames: vi.fn().mockReturnValue([]),
    classifyNPCNames: vi.fn().mockReturnValue({ newNames: [], existingNpcs: [] }),
    validateNPCCandidates: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../chatEngine', () => ({
    updateExistingNPCs: vi.fn().mockResolvedValue(undefined),
    backfillNPCDrives: vi.fn().mockResolvedValue(undefined),
}));

import { npcTrack } from '../npcTrack';
import type { PostTurnTrackContext } from '../types';
import { backgroundQueue } from '../../../infrastructure/backgroundQueue';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from '../../../npc/npcDetector';
import { updateExistingNPCs, backfillNPCDrives } from '../../../chatEngine';

const mockBQ = vi.mocked(backgroundQueue);
const mockExtract = vi.mocked(extractNPCNames);
const mockClassify = vi.mocked(classifyNPCNames);
const mockValidate = vi.mocked(validateNPCCandidates);
const mockUpdateExisting = vi.mocked(updateExistingNPCs);
const mockBackfill = vi.mocked(backfillNPCDrives);

const ASSISTANT = 'Kaelen bows. Mira watches.';
const ALL_MSGS: ChatMessage[] = [{ id: 'm1', role: 'assistant', content: ASSISTANT, timestamp: 1 }];

const npc = (over: Partial<NPCEntry> = {}): NPCEntry => ({
    id: 'npc1', name: 'Mira', aliases: '', description: '', relationship: '',
    ...over,
} as NPCEntry);

const makeCtx = (over: {
    state?: Partial<TurnState>;
    callbacks?: Partial<TurnCallbacks>;
    npcLedger?: NPCEntry[];
} = {}): PostTurnTrackContext => {
    const npcLedger = over.npcLedger ?? [];
    const state = {
        settings: { aiTier: 'max' } as any,
        context: {} as GameContext,
        archiveIndex: [],
        npcLedger,
        activeCampaignId: 'campaign-1',
        getFreshProvider: vi.fn().mockReturnValue({ endpoint: 'http://llm', apiKey: '', modelName: 'm' }),
        ...over.state,
    } as unknown as TurnState;
    const callbacks = {
        updateNPC: vi.fn(),
        addNpcSuggestions: vi.fn(),
        ...over.callbacks,
    } as unknown as TurnCallbacks;
    return {
        state,
        callbacks,
        displayInput: 'greet them',
        lastAssistantContent: ASSISTANT,
        allMsgs: ALL_MSGS,
        npcLedger,
        activeCampaignId: 'campaign-1',
    };
};

describe('track.npc — metadata', () => {
    it('declares a stable id and is toggleable-by-default and on-by-default', () => {
        expect(npcTrack.id).toBe('track.npc');
        expect(npcTrack.defaultEnabled).toBe(true);
        expect(npcTrack.toggleable).toBeUndefined(); // undefined === toggleable
    });

    it('shouldRun is unconditional (the body keeps its own early returns)', () => {
        expect(npcTrack.shouldRun(makeCtx())).toBe(true);
        expect(npcTrack.shouldRun(makeCtx({ npcLedger: [] }))).toBe(true);
    });
});

describe('track.npc — detection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockActiveCampaignId = 'campaign-1';
    });

    it('excludes every ledger name + alias AND the PC name + aliases from detection', async () => {
        const ledger = [npc({ id: 'n1', name: 'Mira', aliases: 'The Owl, Owly' })];
        const ctx = makeCtx({
            npcLedger: ledger,
            state: {
                npcLedger: ledger,
                context: { playerCharacter: { name: 'Aria', aliases: 'Red, Redhand' } } as any,
            },
        });

        await npcTrack.run(ctx);

        expect(mockExtract).toHaveBeenCalledWith(
            ASSISTANT,
            ['Mira', 'The Owl', 'Owly', 'Aria', 'Red', 'Redhand'],
        );
    });

    it('falls back to a legacy isPC ledger row when context.playerCharacter is absent', async () => {
        const ledger = [npc({ id: 'n1', name: 'Aria', aliases: '', isPC: true })];
        await npcTrack.run(makeCtx({ npcLedger: ledger, state: { npcLedger: ledger } }));

        // 'Aria' appears once from the ledger sweep and once from the PC branch.
        expect(mockExtract).toHaveBeenCalledWith(ASSISTANT, ['Aria', 'Aria']);
    });

    it('does nothing when the extractor finds no names', async () => {
        mockExtract.mockReturnValueOnce([]);
        const ctx = makeCtx();
        await npcTrack.run(ctx);

        expect(mockValidate).not.toHaveBeenCalled();
        expect(ctx.callbacks.addNpcSuggestions).not.toHaveBeenCalled();
    });

    it('surfaces new names as suggestions and never auto-adds an NPC', async () => {
        mockExtract.mockReturnValueOnce(['Kaelen']);
        mockValidate.mockResolvedValueOnce(['Kaelen']);
        mockClassify.mockReturnValueOnce({ newNames: ['Kaelen'], existingNpcs: [] } as any);

        const ctx = makeCtx();
        await npcTrack.run(ctx);

        expect(ctx.callbacks.addNpcSuggestions).toHaveBeenCalledWith(['Kaelen'], ASSISTANT);
        expect((ctx.callbacks as any).addNPC).toBeUndefined();
        expect(mockBQ.push).not.toHaveBeenCalled();
    });

    it('Lite tier skips the validation LLM call and uses the raw extracted names', async () => {
        mockExtract.mockReturnValueOnce(['Kaelen']);
        mockClassify.mockReturnValueOnce({ newNames: ['Kaelen'], existingNpcs: [] } as any);

        const ctx = makeCtx({ state: { settings: { aiTier: 'lite' } as any } });
        await npcTrack.run(ctx);

        expect(mockValidate).not.toHaveBeenCalled();
        expect(mockClassify).toHaveBeenCalledWith(['Kaelen'], [], []);
        expect(ctx.callbacks.addNpcSuggestions).toHaveBeenCalledWith(['Kaelen'], ASSISTANT);
    });

    it('stops when validation rejects every candidate', async () => {
        mockExtract.mockReturnValueOnce(['Kaelen']);
        mockValidate.mockResolvedValueOnce([]);

        const ctx = makeCtx();
        await npcTrack.run(ctx);

        expect(mockClassify).not.toHaveBeenCalled();
        expect(ctx.callbacks.addNpcSuggestions).not.toHaveBeenCalled();
    });
});

describe('track.npc — existing NPC updates', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockActiveCampaignId = 'campaign-1';
    });

    const existing = npc({ id: 'n1', name: 'Mira', drives: 'x' } as any);

    it('queues NPC-Update under a scene-labelled task and stamps lastUpdateScene', async () => {
        mockExtract.mockReturnValueOnce(['Mira']);
        mockValidate.mockResolvedValueOnce(['Mira']);
        mockClassify.mockReturnValueOnce({ newNames: [], existingNpcs: [existing] } as any);
        mockBQ.push.mockImplementationOnce(async (_label, execute) => execute());

        const ctx = makeCtx({
            state: { archiveIndex: [{ sceneId: '007' }] as any },
        });
        await npcTrack.run(ctx);

        expect(mockBQ.push).toHaveBeenCalledWith('NPC-Update:Mira', expect.any(Function));
        expect(mockUpdateExisting).toHaveBeenCalledWith(
            expect.objectContaining({ modelName: 'm' }),
            ALL_MSGS,
            [existing],
            expect.any(Function),
        );
        expect(ctx.callbacks.updateNPC).toHaveBeenCalledWith('n1', { lastUpdateScene: 7 });
    });

    it('RACE GUARD: drops the lastUpdateScene write when the campaign switched mid-flight', async () => {
        mockExtract.mockReturnValueOnce(['Mira']);
        mockValidate.mockResolvedValueOnce(['Mira']);
        mockClassify.mockReturnValueOnce({ newNames: [], existingNpcs: [existing] } as any);
        mockBQ.push.mockImplementationOnce(async (_label, execute) => {
            mockActiveCampaignId = 'campaign-2';
            await execute();
        });

        const ctx = makeCtx({ state: { archiveIndex: [{ sceneId: '007' }] as any } });
        await npcTrack.run(ctx);

        expect(mockUpdateExisting).toHaveBeenCalled();
        expect(ctx.callbacks.updateNPC).not.toHaveBeenCalled();
    });

    it('RACE GUARD: the guard handed to updateExistingNPCs drops writes after a switch', async () => {
        mockExtract.mockReturnValueOnce(['Mira']);
        mockValidate.mockResolvedValueOnce(['Mira']);
        mockClassify.mockReturnValueOnce({ newNames: [], existingNpcs: [existing] } as any);
        let guard: ((id: string, patch: any) => void) | undefined;
        mockUpdateExisting.mockImplementationOnce(async (_p: any, _m: any, _n: any, g: any) => { guard = g; });
        mockBQ.push.mockImplementationOnce(async (_label, execute) => execute());

        const ctx = makeCtx({ state: { archiveIndex: [{ sceneId: '007' }] as any } });
        await npcTrack.run(ctx);

        expect(guard).toBeTypeOf('function');
        (ctx.callbacks.updateNPC as any).mockClear();
        guard!('n1', { name: 'Mira the Bold' });
        expect(ctx.callbacks.updateNPC).toHaveBeenCalledWith('n1', { name: 'Mira the Bold' });

        mockActiveCampaignId = 'campaign-2';
        (ctx.callbacks.updateNPC as any).mockClear();
        guard!('n1', { name: 'Mira the Dropped' });
        expect(ctx.callbacks.updateNPC).not.toHaveBeenCalled();
    });

    it('Pro tier honours the 5-scene cooldown', async () => {
        const recent = npc({ id: 'n1', name: 'Mira', lastUpdateScene: 5, drives: 'x' } as any);
        mockExtract.mockReturnValue(['Mira']);
        mockValidate.mockResolvedValue(['Mira']);
        mockClassify.mockReturnValue({ newNames: [], existingNpcs: [recent] } as any);

        // scene 7 − last 5 = 2 < 5 → skipped
        await npcTrack.run(makeCtx({
            state: { settings: { aiTier: 'pro' } as any, archiveIndex: [{ sceneId: '007' }] as any },
        }));
        expect(mockBQ.push).not.toHaveBeenCalled();

        // scene 10 − last 5 = 5 ≥ 5 → queued
        await npcTrack.run(makeCtx({
            state: { settings: { aiTier: 'pro' } as any, archiveIndex: [{ sceneId: '010' }] as any },
        }));
        expect(mockBQ.push).toHaveBeenCalledWith('NPC-Update:Mira', expect.any(Function));
    });

    it('Lite tier never queues an NPC update', async () => {
        mockExtract.mockReturnValueOnce(['Mira']);
        mockClassify.mockReturnValueOnce({ newNames: [], existingNpcs: [existing] } as any);

        await npcTrack.run(makeCtx({ state: { settings: { aiTier: 'lite' } as any } }));

        expect(mockBQ.push).not.toHaveBeenCalled();
    });

    it('queues a drives backfill only for NPCs with no drives', async () => {
        const noDrives = npc({ id: 'n2', name: 'Bram' });
        mockExtract.mockReturnValueOnce(['Bram']);
        mockValidate.mockResolvedValueOnce(['Bram']);
        mockClassify.mockReturnValueOnce({ newNames: [], existingNpcs: [noDrives] } as any);
        mockBQ.push.mockImplementation(async (_label, execute) => execute());

        await npcTrack.run(makeCtx({ state: { archiveIndex: [{ sceneId: '001' }] as any } }));

        expect(mockBQ.push).toHaveBeenCalledWith('NPC-Drives-Backfill:Bram', expect.any(Function));
        expect(mockBackfill).toHaveBeenCalledWith(
            expect.objectContaining({ modelName: 'm' }),
            ALL_MSGS,
            [noDrives],
            expect.any(Function),
        );
    });
});
