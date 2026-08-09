/**
 * Phase 6.4 / `DATA_POLICY.md` §3 — `cleanModData`, the clean action's order.
 *
 * The contract from `MANIFEST.md` §7.2 is a sequence, and the second step is
 * the one that must not be skippable:
 *
 *   1. the mod's `clean` hook runs;
 *   2. **then the host clears the mod's provisioned tables, unconditionally.**
 *
 * A mod that throws in `clean` must not keep its data alive — that would hand
 * a broken mod a veto over the user's decision to erase it. These tests are
 * the only place that property is pinned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValidatedMod } from '../modTypes';

const mocks = vi.hoisted(() => ({
    fetchMods: vi.fn(),
    setExtensionModules: vi.fn(),
    clearModData: vi.fn(),
    clearModTables: vi.fn(),
    activeCampaignId: 'campaign-1' as string | null,
}));

vi.mock('../modClient', () => ({ fetchMods: mocks.fetchMods }));
vi.mock('../../payload/contributions/extensions', () => ({ setExtensionModules: mocks.setExtensionModules }));
vi.mock('../modTables', () => ({ clearModData: mocks.clearModData }));
vi.mock('../../../store/useAppStore', () => ({
    useAppStore: {
        getState: () => ({
            settings: { moduleEnabled: {} },
            activeCampaignId: mocks.activeCampaignId,
            clearModTables: mocks.clearModTables,
        }),
    },
}));

import { cleanModData, __resetLifecycleHost } from '../modBootstrap';

const mod = (): ValidatedMod => ({
    id: 'compendium',
    name: 'Compendium',
    version: '1.0.0',
    description: '',
    file: 'compendium/manifest.json',
    folder: 'compendium',
    dependencies: {},
    contributions: [],
    tables: [{ name: 'powers', recordShape: 'array' }],
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeCampaignId = 'campaign-1';
    mocks.clearModData.mockResolvedValue(['mod.compendium.powers']);
    __resetLifecycleHost();
});

describe('cleanModData', () => {
    it('clears the host tables and drops the mod\'s in-memory rows', async () => {
        const removed = await cleanModData(mod());

        expect(mocks.clearModData).toHaveBeenCalledWith('campaign-1', 'compendium');
        expect(mocks.clearModTables).toHaveBeenCalledWith('compendium');
        expect(removed).toEqual(['mod.compendium.powers']);
    });

    it('clears a declarative mod that cannot declare a `clean` hook at all', async () => {
        // §3 — a declarative or sandboxed-only mod gets a complete clear. The
        // fixture has no `native` block, so no hook exists to run.
        await cleanModData(mod());
        expect(mocks.clearModData).toHaveBeenCalledTimes(1);
    });

    it('still clears when the mod\'s `clean` hook is unavailable or faults', async () => {
        // The native loader cannot import anything in this environment, so the
        // hook resolution faults — the host contains it. The host clear must
        // happen regardless: a broken mod has no veto over the erase.
        const native: ValidatedMod = {
            ...mod(),
            native: { js: 'index.js', hooks: { clean: 'onClean' } },
        };
        await cleanModData(native);
        expect(mocks.clearModData).toHaveBeenCalledWith('campaign-1', 'compendium');
        expect(mocks.clearModTables).toHaveBeenCalledWith('compendium');
    });

    it('does nothing at all with no campaign open', async () => {
        // §3 — mod data is per campaign. With none open there is nothing to
        // clear, and inventing a target is how another save gets erased.
        mocks.activeCampaignId = null;
        const removed = await cleanModData(mod());
        expect(removed).toEqual([]);
        expect(mocks.clearModData).not.toHaveBeenCalled();
        expect(mocks.clearModTables).not.toHaveBeenCalled();
    });

    it('propagates a failed clear instead of reporting success', async () => {
        mocks.clearModData.mockRejectedValue(new Error('Mod data clear failed: 500'));
        await expect(cleanModData(mod())).rejects.toThrow('Mod data clear failed: 500');
        // The store is NOT told the rows are gone — they are still on disk.
        expect(mocks.clearModTables).not.toHaveBeenCalled();
    });
});
