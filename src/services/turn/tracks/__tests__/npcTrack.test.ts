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
let mockLiveLedger: NPCEntry[] | undefined;
vi.mock('../../../../store/useAppStore', () => ({
    useAppStore: { getState: () => ({ activeCampaignId: mockActiveCampaignId, npcLedger: mockLiveLedger }) },
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
    updateExistingNPCs: vi.fn().mockResolvedValue(true),
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

    // Only the PC is excluded. Excluding every ledger name and alias (081bc45) kept known
    // NPCs named exactly — most turns — out of the update step; classify sorts them instead.
    it('excludes only the PC name + aliases, so known NPCs reach the update step', async () => {
        const ledger = [npc({ id: 'n1', name: 'Mira', aliases: 'The Owl, Owly' })];
        const ctx = makeCtx({
            npcLedger: ledger,
            state: {
                npcLedger: ledger,
                context: { playerCharacter: { name: 'Aria', aliases: 'Red, Redhand' } } as any,
            },
        });

        await npcTrack.run(ctx);

        expect(mockExtract).toHaveBeenCalledWith(ASSISTANT, ['Aria', 'Red', 'Redhand']);
    });

    it('falls back to a legacy isPC ledger row when context.playerCharacter is absent', async () => {
        const ledger = [npc({ id: 'n1', name: 'Aria', aliases: '', isPC: true })];
        await npcTrack.run(makeCtx({ npcLedger: ledger, state: { npcLedger: ledger } }));

        expect(mockExtract).toHaveBeenCalledWith(ASSISTANT, ['Aria']);
    });

    it('does nothing when the extractor finds no names', async () => {
        mockExtract.mockReturnValueOnce([]);
        const ctx = makeCtx();
        await npcTrack.run(ctx);

        expect(mockValidate).not.toHaveBeenCalled();
        expect(ctx.callbacks!.addNpcSuggestions).not.toHaveBeenCalled();
    });

    it('surfaces new names as suggestions and never auto-adds an NPC', async () => {
        mockExtract.mockReturnValueOnce(['Kaelen']);
        mockValidate.mockResolvedValueOnce(['Kaelen']);
        mockClassify.mockReturnValueOnce({ newNames: ['Kaelen'], existingNpcs: [] } as any);

        const ctx = makeCtx();
        await npcTrack.run(ctx);

        expect(ctx.callbacks!.addNpcSuggestions).toHaveBeenCalledWith(['Kaelen'], ASSISTANT);
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
        expect(ctx.callbacks!.addNpcSuggestions).toHaveBeenCalledWith(['Kaelen'], ASSISTANT);
    });

    it('validates only unknown names; a rejected candidate is not suggested, and known NPCs still update', async () => {
        const mira = npc({ id: 'n1', name: 'Mira', drives: 'x' } as any);
        mockExtract.mockReturnValueOnce(['Kaelen', 'Mira']);
        mockClassify.mockReturnValueOnce({ newNames: ['Kaelen'], existingNpcs: [mira] } as any);
        mockValidate.mockResolvedValueOnce([]);

        const ctx = makeCtx();
        await npcTrack.run(ctx);

        expect(mockValidate).toHaveBeenCalledWith(expect.anything(), ['Kaelen'], ASSISTANT);
        expect(ctx.callbacks!.addNpcSuggestions).not.toHaveBeenCalled();
        expect(mockBQ.push).toHaveBeenCalledWith('NPC-Update:Mira', expect.any(Function));
    });

    it('a known NPC named exactly goes to the update step without a validator call', async () => {
        const mira = npc({ id: 'n1', name: 'Mira', drives: 'x' } as any);
        mockExtract.mockReturnValueOnce(['Mira']);
        mockClassify.mockReturnValueOnce({ newNames: [], existingNpcs: [mira] } as any);

        const ctx = makeCtx();
        await npcTrack.run(ctx);

        expect(mockValidate).not.toHaveBeenCalled();
        expect(mockBQ.push).toHaveBeenCalledWith('NPC-Update:Mira', expect.any(Function));
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
        expect(ctx.callbacks!.updateNPC).toHaveBeenCalledWith('n1', { lastUpdateScene: 7 });
    });

    it('a failed update leaves the cooldown unspent', async () => {
        mockExtract.mockReturnValueOnce(['Mira']);
        mockClassify.mockReturnValueOnce({ newNames: [], existingNpcs: [existing] } as any);
        mockUpdateExisting.mockResolvedValueOnce(false);
        mockBQ.push.mockImplementationOnce(async (_label, execute) => execute());

        const ctx = makeCtx({ state: { archiveIndex: [{ sceneId: '007' }] as any } });
        await npcTrack.run(ctx);

        expect(mockUpdateExisting).toHaveBeenCalled();
        expect(ctx.callbacks!.updateNPC).not.toHaveBeenCalledWith('n1', { lastUpdateScene: 7 });
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
        expect(ctx.callbacks!.updateNPC).not.toHaveBeenCalled();
    });

    it('RACE GUARD: the guard handed to updateExistingNPCs drops writes after a switch', async () => {
        mockExtract.mockReturnValueOnce(['Mira']);
        mockValidate.mockResolvedValueOnce(['Mira']);
        mockClassify.mockReturnValueOnce({ newNames: [], existingNpcs: [existing] } as any);
        let guard: ((id: string, patch: any) => void) | undefined;
        mockUpdateExisting.mockImplementationOnce(async (_p: any, _m: any, _n: any, g: any) => { guard = g; return true; });
        mockBQ.push.mockImplementationOnce(async (_label, execute) => execute());

        const ctx = makeCtx({ state: { archiveIndex: [{ sceneId: '007' }] as any } });
        await npcTrack.run(ctx);

        expect(guard).toBeTypeOf('function');
        (ctx.callbacks!.updateNPC as any).mockClear();
        guard!('n1', { name: 'Mira the Bold' });
        expect(ctx.callbacks!.updateNPC).toHaveBeenCalledWith('n1', { name: 'Mira the Bold' });

        mockActiveCampaignId = 'campaign-2';
        (ctx.callbacks!.updateNPC as any).mockClear();
        guard!('n1', { name: 'Mira the Dropped' });
        expect(ctx.callbacks!.updateNPC).not.toHaveBeenCalled();
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

    // Drives backfill is disabled (2026-10-04): the agency system replaced drives.
    it('never queues a drives backfill', async () => {
        const noDrives = npc({ id: 'n2', name: 'Bram' });
        mockExtract.mockReturnValueOnce(['Bram']);
        mockClassify.mockReturnValueOnce({ newNames: [], existingNpcs: [noDrives] } as any);
        mockBQ.push.mockImplementation(async (_label, execute) => execute());

        await npcTrack.run(makeCtx({ state: { archiveIndex: [{ sceneId: '001' }] as any } }));

        expect(mockBQ.push).not.toHaveBeenCalledWith(expect.stringMatching(/^NPC-Drives-Backfill/), expect.any(Function));
        expect(mockBackfill).not.toHaveBeenCalled();
    });
});

describe('track.npc — relationship memory flag', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockActiveCampaignId = 'campaign-1';
    });

    // The pipeline's track context carries no `state`; the flag lives on the facade's
    // context. Reading `ctx.state` made it always false.
    it('passes relationshipMemoryEnabled to the updater when the campaign has it on', async () => {
        const mira = npc({ id: 'n1', name: 'Mira', drives: 'x', populated: true } as any);
        mockExtract.mockReturnValueOnce(['Mira']);
        mockClassify.mockReturnValueOnce({ newNames: [], existingNpcs: [mira] } as any);
        mockBQ.push.mockImplementation(async (_label, execute) => execute());

        await npcTrack.run(makeCtx({
            state: { context: { relationshipMemory: true } as any, archiveIndex: [{ sceneId: '007' }] as any },
        }));

        expect(mockUpdateExisting).toHaveBeenCalledWith(
            expect.anything(), ALL_MSGS, [mira], expect.any(Function), undefined, { relationshipMemoryEnabled: true },
        );
    });
});

describe('track.npc — agency fill for older NPCs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockActiveCampaignId = 'campaign-1';
        mockLiveLedger = undefined;
    });

    const run = async (existing: NPCEntry, aiTier = 'max') => {
        mockExtract.mockReturnValueOnce([existing.name]);
        mockClassify.mockReturnValueOnce({ newNames: [], existingNpcs: [existing] } as any);
        const ctx = makeCtx({ state: { settings: { aiTier } as any, archiveIndex: [{ sceneId: '001' }] as any } });
        await npcTrack.run(ctx);
        return ctx;
    };

    it('fills an unpopulated NPC the first time it is named, without a model call', async () => {
        const ctx = await run(npc({ id: 'n3', name: 'Sanna', personality: 'cautious, loyal' } as any));
        const patch = vi.mocked(ctx.callbacks!.updateNPC).mock.calls.find(([id]) => id === 'n3')?.[1];
        expect(patch).toMatchObject({ populated: true, wantsProvenance: 'pool' });
        expect(patch?.wants?.short.length).toBeGreaterThan(0);
    });

    it('leaves an already populated NPC alone', async () => {
        const ctx = await run(npc({ id: 'n4', name: 'Rin', populated: true } as any));
        const patch = vi.mocked(ctx.callbacks!.updateNPC).mock.calls.find(([, p]) => (p as any).populated);
        expect(patch).toBeUndefined();
    });

    // The fill rolls a personality; the ledger the turn was built from can predate a fill
    // an earlier commit made, so the live store decides.
    it('skips an NPC the live store shows as already filled', async () => {
        mockLiveLedger = [npc({ id: 'n6', name: 'Oska', populated: true } as any)];
        const ctx = await run(npc({ id: 'n6', name: 'Oska' }));
        const patch = vi.mocked(ctx.callbacks!.updateNPC).mock.calls.find(([, p]) => (p as any).populated);
        expect(patch).toBeUndefined();
    });

    it('does not run when the heartbeat it feeds is off (Lite)', async () => {
        const ctx = await run(npc({ id: 'n5', name: 'Bram' }), 'lite');
        expect(ctx.callbacks!.updateNPC).not.toHaveBeenCalled();
    });
});
