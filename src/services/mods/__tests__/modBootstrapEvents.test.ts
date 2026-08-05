/**
 * Phase 3.2 — the `app.*` emit sites in `modBootstrap` (`EVENTS.md` §6.1, §11
 * sites 1–3).
 *
 * The distinction under test is the one §6.1 draws: the FIRST completed
 * `refreshMods()` is `app.ready` (sticky), every later one is
 * `app.modsChanged`, and so is each enable/disable from the Extensions screen.
 * `modIds` is the enabled, successfully-loaded set — a collection the payload
 * rule allows precisely because there is no mod list anywhere on `ModContext`.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ValidatedMod } from '../modTypes';

const mocks = vi.hoisted(() => ({
    fetchMods: vi.fn(),
    setExtensionModules: vi.fn(),
    enablement: {} as Record<string, boolean>,
}));
vi.mock('../modClient', () => ({ fetchMods: mocks.fetchMods }));
vi.mock('../../payload/contributions/extensions', () => ({ setExtensionModules: mocks.setExtensionModules }));
vi.mock('../../../store/useAppStore', () => ({
    useAppStore: {
        getState: () => ({ settings: { moduleEnabled: mocks.enablement } }),
    },
}));

import { refreshMods, enableNativeMod, disableNativeMod, __resetLifecycleHost } from '../modBootstrap';
import { modEventBus, eventFaultStore } from '../events';
import type { ModEventOwner } from '../events';
import { postTurnTracks } from '../../turn/tracks';

const OWNER: ModEventOwner = { modId: 'probe', modName: 'Probe', file: 'probe.mod.json' };

type Logged = { name: string; payload: Record<string, unknown> };

function listen(log: Logged[]): () => void {
    const offs = (['app.ready', 'app.modsChanged'] as const).map((name) =>
        modEventBus.on(name, (payload) => {
            log.push({ name, payload: payload as unknown as Record<string, unknown> });
        }, OWNER),
    );
    return () => { for (const off of offs) off(); };
}

const plainMod = (id: string): ValidatedMod => ({
    id,
    name: id,
    version: '1.0.0',
    description: '',
    file: `${id}/manifest.json`,
    folder: id,
    folderPath: `/mods/${id}`,
    loadOrder: 0,
    dependencies: {},
    i18n: {},
    i18nStrings: {},
    contributions: [],
    tables: [],
    panels: [],
    screens: [],
    screenSources: [],
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.enablement = {};
    __resetLifecycleHost();
    modEventBus.reset();
    eventFaultStore.clear();
    for (const track of postTurnTracks.list()) {
        if (track.id.startsWith('mod.') && track.id.endsWith('.compute')) postTurnTracks.unregister(track.id);
    }
});

afterEach(() => {
    modEventBus.reset();
});

describe('§6.1 app.ready / app.modsChanged', () => {
    it('the first completed refresh is app.ready; every later one is app.modsChanged', async () => {
        mocks.fetchMods.mockResolvedValue({ mods: [plainMod('arc')], faults: [] });
        const log: Logged[] = [];
        const off = listen(log);

        await refreshMods();
        await refreshMods();
        await refreshMods();
        off();

        expect(log.map(e => e.name)).toEqual(['app.ready', 'app.modsChanged', 'app.modsChanged']);
        expect(log[0].payload).toEqual({ modIds: ['arc'], faultCount: 0 });
    });

    it('modIds is the ENABLED, successfully-loaded set', async () => {
        mocks.enablement = { 'mod.grimdark': false };
        mocks.fetchMods.mockResolvedValue({
            mods: [plainMod('arc'), plainMod('grimdark'), plainMod('skilltree')],
            faults: [{ file: 'broken.mod.json', reason: 'bad' }],
        });
        const log: Logged[] = [];
        const off = listen(log);

        await refreshMods();
        off();

        expect(log[0].payload).toEqual({ modIds: ['arc', 'skilltree'], faultCount: 1 });
    });

    it('app.ready is sticky — a mod enabled mid-session still learns the app is up (§4.4)', async () => {
        mocks.fetchMods.mockResolvedValue({ mods: [plainMod('arc')], faults: [] });
        await refreshMods();

        // The late subscriber: `enableNativeMod` fires `activate` long after boot.
        const log: Logged[] = [];
        const off = listen(log);
        off();

        expect(log).toEqual([{
            name: 'app.ready',
            payload: { modIds: ['arc'], faultCount: 0, replayed: true },
        }]);
    });

    it('enable and disable each announce the new set', async () => {
        mocks.fetchMods.mockResolvedValue({ mods: [plainMod('arc')], faults: [] });
        await refreshMods();

        const log: Logged[] = [];
        const off = listen(log);
        await enableNativeMod(plainMod('arc'));
        await disableNativeMod(plainMod('arc'));
        off();

        // The replayed `app.ready` lands first (the listener subscribed late),
        // then the two changes.
        expect(log.map(e => e.name)).toEqual(['app.ready', 'app.modsChanged', 'app.modsChanged']);
    });

    it('a failed refresh announces nothing — there is no new mod set', async () => {
        mocks.fetchMods.mockRejectedValue(new Error('server down'));
        const log: Logged[] = [];
        const off = listen(log);
        await refreshMods();
        off();
        expect(log).toEqual([]);
    });
});
