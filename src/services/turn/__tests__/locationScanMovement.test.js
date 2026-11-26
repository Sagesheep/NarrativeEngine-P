import { beforeEach, expect, it, vi } from 'vitest';
const { scan, pending } = vi.hoisted(() => ({ scan: vi.fn(), pending: [] }));
vi.mock('../../locationParser', () => ({ scanLocation: scan, mergeLocationScanLedger: (_before, _scan, live) => live }));
vi.mock('../../infrastructure/backgroundQueue', () => ({ backgroundQueue: { push: (_name, work) => { const job = work(); pending.push(job); return job; } } }));
vi.mock('../tracks/guarded', () => ({ assertStillActive: () => true }));
vi.mock('../../locationHeader', () => ({ resolveLocationHeader: content => content.startsWith('📍 Baldur')
    ? { kind: 'resolved', placeId: 'gate', feature: null } : { kind: 'none' } }));
import { locationScanTrack } from '../tracks/postCommit/locationScanTrack';
beforeEach(() => { pending.length = 0; scan.mockReset(); });
async function run(content) {
    const ledger = [{ id: 'camp' }, { id: 'gate', coordinates: { x: 800, y: 900 } }];
    const live = { activeCampaignId: 'c', context: { currentPlaceId: 'camp', currentFeature: null }, locationLedger: ledger };
    const ctx = { activeCampaignId: 'c', callbacks: { getFreshLocationState: () => live }, scanMessages: [{ role: 'assistant', content }],
        guardedUpdateContext: vi.fn(), guardedSetLocationLedger: vi.fn(), guardedAddLocationSuggestions: vi.fn() };
    scan.mockResolvedValue({ currentPlaceId: 'gate', currentFeature: null, ledger, suggestions: [{ name: 'Distant city' }] });
    await locationScanTrack.run(ctx); await Promise.all(pending);
    return ctx;
}
it('an erroneous scanner current-place estimate cannot turn a quest mention into arrival', async () => {
    const ctx = await run('Your quest will be in Baldur\'s Gate.');
    expect(ctx.guardedUpdateContext).not.toHaveBeenCalled();
    expect(ctx.guardedAddLocationSuggestions).toHaveBeenCalledWith([{ name: 'Distant city' }]);
});
it('the committed movement contract overrides an inconsistent scene header and scan', async () => {
    const ctx = await run('📍 Baldur\'s Gate\n<!-- MOVEMENT {"action":"stay"} -->');
    expect(ctx.guardedUpdateContext).not.toHaveBeenCalled();
});
it('a legacy actual scene header still supports arrival', async () => {
    const ctx = await run('📍 Baldur\'s Gate\nYou arrive at the gates.');
    expect(ctx.guardedUpdateContext).toHaveBeenCalledWith({ currentPlaceId: 'gate', currentFeature: null });
});
