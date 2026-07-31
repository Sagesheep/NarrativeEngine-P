/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NPCEntry } from '../../../../types';
import type { TurnState, TurnCallbacks } from '../../turnOrchestrator';

/**
 * WO-P2-03 characterization test for `track.pressure`.
 *
 * Pins the behaviour the migration had to preserve: which NPCs count as active, the pressure
 * write, the auto-archive and auto-restore paths — and above all the THREE inline campaign-id
 * race guards (`guardedUpdateNPC`, `guardedArchiveNPC`, `guardedRestoreNPC`). Those guards are
 * correctness, not boilerplate: without them a campaign switched mid-scan writes one campaign's
 * NPC state into another's ledger.
 */

let mockActiveCampaignId: string | null = 'campaign-1';
let mockStaleTurns = 0;
vi.mock('../../../../store/useAppStore', () => ({
    useAppStore: {
        getState: () => ({
            activeCampaignId: mockActiveCampaignId,
            settings: { autoArchiveStaleNPCsTurns: mockStaleTurns },
        }),
    },
}));
vi.mock('../../../npc/npcPressureTracker', () => ({
    scanPressure: vi.fn().mockReturnValue([]),
    buildPressurePatch: vi.fn().mockReturnValue({ pressure: { ignored: 1, engaged: 0 } }),
    shouldArchiveNPC: vi.fn().mockReturnValue({ shouldArchive: false, reason: '', turnsSince: 0 }),
    findArchivedToRestore: vi.fn().mockReturnValue([]),
}));
vi.mock('../../../../components/Toast', () => ({ toast: { info: vi.fn() } }));

import { pressureTrack } from '../pressureTrack';
import type { PostTurnTrackContext } from '../types';
import {
    scanPressure, buildPressurePatch, shouldArchiveNPC, findArchivedToRestore,
} from '../../../npc/npcPressureTracker';

const mockScan = vi.mocked(scanPressure);
const mockPatch = vi.mocked(buildPressurePatch);
const mockShouldArchive = vi.mocked(shouldArchiveNPC);
const mockFindRestore = vi.mocked(findArchivedToRestore);

const npc = (over: Partial<NPCEntry> = {}): NPCEntry => ({
    id: 'npc1', name: 'Mira', aliases: '', description: '', relationship: '',
    ...over,
} as NPCEntry);

const makeCtx = (npcLedger: NPCEntry[], stateOver: Partial<TurnState> = {}): {
    ctx: PostTurnTrackContext;
    callbacks: { updateNPC: any; archiveNPC: any; restoreNPC: any };
} => {
    const callbacks = {
        updateNPC: vi.fn(),
        archiveNPC: vi.fn(),
        restoreNPC: vi.fn(),
    };
    const state = {
        settings: { aiTier: 'max', autoArchiveStaleNPCsTurns: mockStaleTurns } as any,
        context: {} as any,
        archiveIndex: [{ sceneId: '12' }],
        loreChunks: [],
        npcLedger,
        activeCampaignId: 'campaign-1',
        ...stateOver,
    } as unknown as TurnState;
    return {
        ctx: {
            state,
            callbacks: callbacks as unknown as TurnCallbacks,
            displayInput: 'I ignore her.',
            lastAssistantContent: 'Mira turns away.',
            allMsgs: [],
            npcLedger,
            activeCampaignId: 'campaign-1',
        },
        callbacks,
    };
};

beforeEach(() => {
    vi.clearAllMocks();
    mockActiveCampaignId = 'campaign-1';
    mockStaleTurns = 0;
    mockScan.mockReturnValue([]);
    mockPatch.mockReturnValue({ pressure: { ignored: 1, engaged: 0 } } as any);
    mockShouldArchive.mockReturnValue({ shouldArchive: false, reason: '', turnsSince: 0 } as any);
    mockFindRestore.mockReturnValue([]);
});

describe('track.pressure — metadata', () => {
    it('declares a stable id and is toggleable-by-default and on-by-default', () => {
        expect(pressureTrack.id).toBe('track.pressure');
        expect(pressureTrack.defaultEnabled).toBe(true);
        expect(pressureTrack.toggleable).not.toBe(false);
    });

    it('shouldRun mirrors the body\'s own empty-ledger guard', () => {
        expect(pressureTrack.shouldRun(makeCtx([]).ctx)).toBe(false);
        expect(pressureTrack.shouldRun(makeCtx([npc()]).ctx)).toBe(true);
    });
});

describe('track.pressure — active NPC selection', () => {
    it('does nothing when scanPressure finds no updates', async () => {
        const { ctx, callbacks } = makeCtx([npc()]);
        await pressureTrack.run(ctx);

        expect(callbacks.updateNPC).not.toHaveBeenCalled();
    });

    it('excludes archived NPCs and NPCs whose name collides with a lore header', async () => {
        const ledger = [
            npc({ id: 'a', name: 'Mira' }),
            npc({ id: 'b', name: 'Gone', archived: true }),
            npc({ id: 'c', name: 'Konoha' }),
        ];
        const { ctx } = makeCtx(ledger, {
            loreChunks: [{ header: 'konoha' }] as any,
        });
        await pressureTrack.run(ctx);

        const scanned = mockScan.mock.calls[0][1].map((n: NPCEntry) => n.id);
        expect(scanned).toEqual(['a']);
    });

    it('returns early when every NPC is filtered out', async () => {
        const { ctx } = makeCtx([npc({ archived: true })]);
        await pressureTrack.run(ctx);

        expect(mockScan).not.toHaveBeenCalled();
    });
});

describe('track.pressure — writes and race guards', () => {
    it('writes a pressure patch for each scanned update', async () => {
        mockScan.mockReturnValue([{ npcId: 'npc1', reasons: ['ignored'] }] as any);
        const { ctx, callbacks } = makeCtx([npc()]);

        await pressureTrack.run(ctx);

        expect(callbacks.updateNPC).toHaveBeenCalledWith('npc1', { pressure: { ignored: 1, engaged: 0 } });
    });

    it('DROPS the pressure write when the campaign switched mid-scan', async () => {
        mockScan.mockReturnValue([{ npcId: 'npc1', reasons: [] }] as any);
        const { ctx, callbacks } = makeCtx([npc()]);
        mockActiveCampaignId = 'campaign-2';

        await pressureTrack.run(ctx);

        expect(callbacks.updateNPC).not.toHaveBeenCalled();
    });

    it('auto-archives a stale NPC when the setting is on', async () => {
        mockScan.mockReturnValue([{ npcId: 'npc1', reasons: [] }] as any);
        mockStaleTurns = 5;
        mockShouldArchive.mockReturnValue({ shouldArchive: true, reason: 'stale', turnsSince: 9 } as any);
        const { ctx, callbacks } = makeCtx([npc()]);

        await pressureTrack.run(ctx);

        expect(callbacks.archiveNPC).toHaveBeenCalledWith('npc1', 1, 'stale');
    });

    it('never auto-archives when the setting is 0', async () => {
        mockScan.mockReturnValue([{ npcId: 'npc1', reasons: [] }] as any);
        mockStaleTurns = 0;
        mockShouldArchive.mockReturnValue({ shouldArchive: true, reason: 'stale', turnsSince: 9 } as any);
        const { ctx, callbacks } = makeCtx([npc()]);

        await pressureTrack.run(ctx);

        expect(callbacks.archiveNPC).not.toHaveBeenCalled();
    });

    it('DROPS the auto-archive write when the campaign switched', async () => {
        mockScan.mockReturnValue([{ npcId: 'npc1', reasons: [] }] as any);
        mockStaleTurns = 5;
        mockShouldArchive.mockReturnValue({ shouldArchive: true, reason: 'stale', turnsSince: 9 } as any);
        const { ctx, callbacks } = makeCtx([npc()]);
        mockActiveCampaignId = 'campaign-2';

        await pressureTrack.run(ctx);

        expect(callbacks.archiveNPC).not.toHaveBeenCalled();
    });

    it('auto-restores an archived NPC the GM just named', async () => {
        mockScan.mockReturnValue([{ npcId: 'npc1', reasons: [] }] as any);
        mockFindRestore.mockReturnValue(['npc2']);
        const { ctx, callbacks } = makeCtx([npc(), npc({ id: 'npc2', name: 'Kaelen', archived: true })]);

        await pressureTrack.run(ctx);

        expect(callbacks.restoreNPC).toHaveBeenCalledWith('npc2');
    });

    it('DROPS the auto-restore write when the campaign switched', async () => {
        mockScan.mockReturnValue([{ npcId: 'npc1', reasons: [] }] as any);
        mockFindRestore.mockReturnValue(['npc2']);
        const { ctx, callbacks } = makeCtx([npc(), npc({ id: 'npc2', name: 'Kaelen', archived: true })]);
        mockActiveCampaignId = 'campaign-2';

        await pressureTrack.run(ctx);

        expect(callbacks.restoreNPC).not.toHaveBeenCalled();
    });
});
