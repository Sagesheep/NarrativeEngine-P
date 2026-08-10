import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NPCEntry } from '../../../../types';
import type { SequentialTrackContext } from '../types';
import { startSequentialTracks } from '../sequential';
import { bumpOnStageActivity, runAgencyTick } from '../../../npc/agency/agencyEngine';
import { buildReactionMenu } from '../../../npc/reactionMenu';
import { applyRepressionToMenu, bookRepression } from '../../../npc/reactionRepression';

vi.mock('../../../npc/agency/agencyEngine', () => ({
    bumpOnStageActivity: vi.fn(),
    runAgencyTick: vi.fn(),
}));

vi.mock('../../../npc/reactionMenu', () => ({
    buildReactionMenu: vi.fn(),
}));

vi.mock('../../../npc/reactionRepression', () => ({
    applyRepressionToMenu: vi.fn(),
    bookRepression: vi.fn(),
}));

const mockBumpOnStageActivity = vi.mocked(bumpOnStageActivity);
const mockRunAgencyTick = vi.mocked(runAgencyTick);
const mockBuildReactionMenu = vi.mocked(buildReactionMenu);
const mockApplyRepressionToMenu = vi.mocked(applyRepressionToMenu);
const mockBookRepression = vi.mocked(bookRepression);

const npc: NPCEntry = {
    id: 'hex-1',
    name: 'Hex',
    aliases: '',
    appearance: '',
    faction: '',
    storyRelevance: '',
    disposition: '',
    status: '',
    goals: '',
    voice: '',
    personality: '',
    exampleOutput: '',
    affinity: 50,
    personalityHex: { drive: 0, diligence: 0, boldness: -1, warmth: 0, empathy: 0, composure: 3 },
};

function makeContext(lastAssistantContent: string, aiTier: 'lite' | 'max' = 'max'): SequentialTrackContext {
    const callbacks = {
        addMessage: vi.fn(),
        updateContext: vi.fn(),
        updateNPC: vi.fn(),
        setOnStageNpcIds: vi.fn(),
    };
    const settings = { aiTier } as SequentialTrackContext['settings'];
    const state = {
        displayInput: 'wait',
        settings,
        context: {},
        onStageNpcIds: ['hex-1'],
    } as SequentialTrackContext['state'];
    const facade = {
        data: { npcLedger: [npc], context: {} },
        config: { aiTier },
        write: { updateNPC: vi.fn() },
    } as unknown as SequentialTrackContext['facade'];

    return {
        state,
        facade,
        callbacks: callbacks as unknown as SequentialTrackContext['callbacks'],
        lastAssistantContent,
        onStageIds: [],
        npcLedger: [npc],
        settings,
        activeCampaignId: 'campaign-1',
    };
}

async function settle(ctx: SequentialTrackContext): Promise<void> {
    await Promise.allSettled(startSequentialTracks(ctx));
}

describe('Stage B every-turn tracks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockBuildReactionMenu.mockReturnValue(['hostile impulse']);
        mockApplyRepressionToMenu.mockReturnValue({
            menu: ['hostile impulse'],
            event: { outcome: 'mask', pressureDelta: 1 },
        });
        mockBookRepression.mockReturnValue({ repressionPressure: 1 });
    });

    it('hands B1 on-stage ids to B4 repression booking through stage context', async () => {
        const ctx = makeContext(`${String.fromCodePoint(0x1f465)} [Present] Hex`);

        await settle(ctx);

        expect(ctx.onStageIds).toEqual(['hex-1']);
        expect(ctx.callbacks.setOnStageNpcIds).toHaveBeenCalledWith(['hex-1']);
        expect(mockBuildReactionMenu).toHaveBeenCalledWith(npc, 'peaceful', expect.any(Function), false);
        expect(mockApplyRepressionToMenu).toHaveBeenCalledWith(['hostile impulse'], npc, 'peaceful', expect.any(Function));
        expect(ctx.callbacks.updateNPC).toHaveBeenCalledWith('hex-1', { repressionPressure: 1 });
    });

    it('does not book repression when the Present header is absent', async () => {
        const ctx = makeContext('The room is quiet.');

        await settle(ctx);

        expect(ctx.onStageIds).toEqual([]);
        expect(ctx.callbacks.setOnStageNpcIds).toHaveBeenCalledWith([]);
        expect(mockBuildReactionMenu).not.toHaveBeenCalled();
        expect(ctx.callbacks.updateNPC).not.toHaveBeenCalled();
    });

    it('keeps the unconditional activity bump while lite skips runAgencyTick', async () => {
        const ctx = makeContext('The room is quiet.', 'lite');

        await settle(ctx);

        expect(mockBumpOnStageActivity).toHaveBeenCalledTimes(1);
        expect(mockRunAgencyTick).not.toHaveBeenCalled();
    });
});
