import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostCommitTrackContext } from '../types';

const mocks = vi.hoisted(() => ({
    push: vi.fn(async (_label: string, job: () => Promise<void>) => job()),
    patchWitnesses: vi.fn(async () => undefined),
    getIndex: vi.fn(async () => []),
}));

vi.mock('../../../infrastructure/backgroundQueue', () => ({
    backgroundQueue: { push: mocks.push },
}));
vi.mock('../../../llm/apiClient', () => ({
    api: { archive: { patchWitnesses: mocks.patchWitnesses, getIndex: mocks.getIndex } },
}));
vi.mock('../../../../store/useAppStore', () => ({
    useAppStore: { getState: () => ({ activeCampaignId: 'c1' }) },
}));

import { witnessCaptureTrack } from '../postCommit/witnessCaptureTrack';

const ledger = [
    { id: 'n1', name: 'Rin Holmes', aliases: '' },
    { id: 'n2', name: 'Helena Broadmarsh', aliases: '' },
];

function ctx(gmText: string, opts: { tier?: string; moduleEnabled?: Record<string, boolean>; modelAnswer?: string; serverWitnesses?: string[] } = {}) {
    const storyModelCall = vi.fn().mockResolvedValue({ content: opts.modelAnswer ?? '[]' });
    const setArchiveIndex = vi.fn();
    const context = {
        state: { npcLedger: ledger, settings: { aiTier: opts.tier ?? 'max', moduleEnabled: opts.moduleEnabled } },
        callbacks: { setArchiveIndex },
        activeCampaignId: 'c1',
        sceneId: '577',
        lastAssistantContent: gmText,
        entry: { sceneId: '577', witnesses: opts.serverWitnesses ?? [] },
        storyModelCall,
    } as unknown as PostCommitTrackContext;
    return { context, storyModelCall, setArchiveIndex };
}

beforeEach(() => {
    mocks.push.mockClear();
    mocks.patchWitnesses.mockClear();
    mocks.getIndex.mockClear();
});

describe('witnessCaptureTrack', () => {
    it('writes the 👥 line as the witness list, with no model call, on any tier', async () => {
        const { context, storyModelCall, setArchiveIndex } = ctx('📍 Study | 👥 [**Rin**], [**Helena**]\n\nThe lamp gutters.', { tier: 'lite' });
        await witnessCaptureTrack.run(context);

        expect(mocks.patchWitnesses).toHaveBeenCalledWith('c1', [{ sceneId: '577', witnesses: ['Rin Holmes', 'Helena Broadmarsh'], witnessSource: 'header' }]);
        expect(storyModelCall).not.toHaveBeenCalled();
        expect(setArchiveIndex).toHaveBeenCalled();
    });

    it('does not rewrite an unchanged list', async () => {
        const { context } = ctx('👥 [**Rin**]', { serverWitnesses: ['Rin Holmes'] });
        await witnessCaptureTrack.run(context);
        expect(mocks.patchWitnesses).not.toHaveBeenCalled();
    });

    it('with no 👥 line on Max, asks the model who was present', async () => {
        const { context, storyModelCall } = ctx('Rin reads the letter twice.', { modelAnswer: '["Rin Holmes"]' });
        await witnessCaptureTrack.run(context);
        await mocks.push.mock.results[0].value; // the model read runs in the background queue

        expect(storyModelCall).toHaveBeenCalledTimes(1);
        expect(mocks.patchWitnesses).toHaveBeenCalledWith('c1', [{ sceneId: '577', witnesses: ['Rin Holmes'], witnessSource: 'aux_fallback' }]);
    });

    it('with no 👥 line on Pro, leaves the server list alone', async () => {
        const { context, storyModelCall } = ctx('Rin reads the letter twice.', { tier: 'pro' });
        await witnessCaptureTrack.run(context);
        expect(storyModelCall).not.toHaveBeenCalled();
        expect(mocks.patchWitnesses).not.toHaveBeenCalled();
    });

    it('a Block View "off" stops the model read on Max', async () => {
        const { context, storyModelCall } = ctx('Rin reads the letter twice.', { moduleEnabled: { witnessAux: false } });
        await witnessCaptureTrack.run(context);
        expect(storyModelCall).not.toHaveBeenCalled();
    });
});
