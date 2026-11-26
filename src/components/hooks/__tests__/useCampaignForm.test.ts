import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCampaignForm } from '../useCampaignForm';
import { prepareRosterFile } from '../../../services/import/campaignRoster';

const mocks = vi.hoisted(() => ({
    saveCampaign: vi.fn(), initialize: vi.fn(), hydrate: vi.fn(), saveNPCs: vi.fn(), saveLore: vi.fn(),
    error: vi.fn(),
}));
vi.mock('../../../store/campaignStore', () => ({
    saveCampaign: mocks.saveCampaign, getNPCLedger: async () => [], saveNPCLedger: mocks.saveNPCs,
    getLoreChunks: async () => [], saveLoreChunks: mocks.saveLore,
}));
vi.mock('../../../services/campaignInit', () => ({ initializeCampaignState: mocks.initialize }));
vi.mock('../../../store/campaignHydrator', () => ({ hydrateCampaign: mocks.hydrate }));
vi.mock('../../Toast', () => ({ toast: { error: mocks.error, info: vi.fn(), warning: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());
async function setup() {
    const entry = await prepareRosterFile({ name: 'mira.json', text: async () => JSON.stringify({
        name: 'Mira', description: 'An archivist.', personality: 'Curious',
        character_book: { entries: [{ keys: ['Library'], content: 'A floating library.', enabled: true }] },
    }) } as File, false);
    const hook = renderHook(() => useCampaignForm({ editingCampaign: null, setEditingCampaign: vi.fn(), onDone: vi.fn() }));
    act(() => { hook.result.current.setName('Floating Isles'); hook.result.current.setRoster([entry]); });
    return { ...hook, entry };
}
describe('campaign creation persistence', () => {
    it('saves NPCs and their full reference, excludes optional world lore, and enters only after saving', async () => {
        const { result } = await setup();
        await act(async () => { await result.current.handleSave(); });
        expect(mocks.saveNPCs).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({ name: 'Mira' })]);
        expect(mocks.saveLore.mock.calls[0][1]).toHaveLength(1);
        expect(mocks.saveLore.mock.calls[0][1][0].category).toBe('character');
        expect(mocks.hydrate).toHaveBeenCalledWith(mocks.saveCampaign.mock.calls[0][0].id);
        expect(mocks.hydrate.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.saveNPCs.mock.invocationCallOrder[0]);
    });
    it('includes embedded lore only when selected', async () => {
        const { result, entry } = await setup();
        act(() => result.current.setRoster([{ ...entry, includeLore: true }]));
        await act(async () => { await result.current.handleSave(); });
        expect(mocks.saveLore.mock.calls[0][1]).toHaveLength(2);
    });
    it('does not create a campaign with duplicate NPC names', async () => {
        const { result, entry } = await setup();
        act(() => result.current.setRoster([entry, { ...entry, npc: { ...entry.npc, id: 'second', name: ' MIRA ' } }]));
        await act(async () => { await result.current.handleSave(); });
        expect(mocks.saveCampaign).not.toHaveBeenCalled();
        expect(mocks.error).toHaveBeenCalled();
    });
    it('reuses the same campaign id after a failed save and does not enter prematurely', async () => {
        const { result } = await setup();
        mocks.initialize.mockRejectedValueOnce(new Error('Offline'));
        await act(async () => { await result.current.handleSave(); });
        expect(mocks.hydrate).not.toHaveBeenCalled();
        await act(async () => { await result.current.handleSave(); });
        expect(mocks.saveCampaign.mock.calls[0][0].id).toBe(mocks.saveCampaign.mock.calls[1][0].id);
        expect(mocks.hydrate).toHaveBeenCalledTimes(1);
    });
});
