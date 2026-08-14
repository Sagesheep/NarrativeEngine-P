/**
 * Phase 6.1 — `ExtensionsTab` Mod Management screen integration tests.
 *
 * Pins the §D native-tier trust dialog flow and the inline-fault surfacing,
 * the two behaviours the spec adds to the existing Extensions screen.
 *
 * The trust store is mocked to an in-memory map so the async `idb-keyval`
 * import never runs. `refreshMods` is mocked so the component loads a
 * controlled mod list without hitting the network.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────────────────
//
// `vi.hoisted` so the mock factories can reference the stubs before the
// imports below resolve (the component imports these modules at module
// load, so the mocks must be in place first).
const mocks = vi.hoisted(() => {
    const trustMap = new Map<string, { acceptedNative: boolean; version: string }>();
    return {
        refreshMods: vi.fn(),
        enableNativeMod: vi.fn(),
        disableNativeMod: vi.fn(),
        // Phase 6.4 — the clean action. Mocked so no test in this file can
        // reach a real DELETE; the route's own behaviour is pinned in
        // `server/__tests__/modDataClean.test.ts`.
        cleanModData: vi.fn(),
        trustMap,
        // The store: controlled `moduleEnabled` + `updateSettings` spy.
        moduleEnabled: undefined as Record<string, boolean> | undefined,
        updateSettings: vi.fn(),
    };
});

vi.mock('../../../services/mods/modBootstrap', () => ({
    refreshMods: mocks.refreshMods,
    enableNativeMod: mocks.enableNativeMod,
    disableNativeMod: mocks.disableNativeMod,
    cleanModData: mocks.cleanModData,
}));

vi.mock('../../../services/mods/nativeTrustStore', () => ({
    getNativeTrustStore: () => ({
        get: async (id: string) => mocks.trustMap.get(id),
        set: async (id: string, record: { acceptedNative: boolean; version: string }) => {
            mocks.trustMap.set(id, record);
        },
        clear: async () => { mocks.trustMap.clear(); },
    }),
    needsNativeTrustWarning: async (_store: unknown, modId: string, hasNative: boolean) => {
        if (!hasNative) return false;
        const record = mocks.trustMap.get(modId);
        return !record?.acceptedNative;
    },
    recordNativeTrustAcceptance: async (_store: unknown, modId: string, version: string) => {
        mocks.trustMap.set(modId, { acceptedNative: true, version });
    },
}));

// The runtime fault stores are imported at module load; stub them so
// `collectRuntimeFaults` does not reach into real module state.
vi.mock('../../../services/mods/sandbox/sandboxFaults', () => ({
    sandboxFaultStore: { getFaults: () => [], subscribe: () => () => undefined },
}));
vi.mock('../../../services/mods/screenFaults', () => ({
    screenFaultStore: { getFaults: () => [], subscribe: () => () => undefined },
}));
vi.mock('../../../services/mods/lifecycle/lifecycleFaults', () => ({
    lifecycleFaultStore: { getFaults: () => [], subscribe: () => () => undefined },
}));
vi.mock('../../../services/mods/reactiveFaults', () => ({
    reactiveFaultStore: { getFaults: () => [], subscribe: () => () => undefined },
}));
vi.mock('../../../services/mods/events', () => ({
    eventFaultStore: { getFaults: () => [], subscribe: () => () => undefined },
}));
vi.mock('../../../services/mods/macros/macroFaults', () => ({
    macroFaultStore: { getFaults: () => [], subscribe: () => () => undefined },
}));
vi.mock('../../../services/mods/interceptors', () => ({
    interceptorFaultStore: { getFaults: () => [], subscribe: () => () => undefined },
}));

// `ModPanels` and `ModScreens` are heavy components with their own imports;
// stub them so this test isolates the ExtensionsTab behaviour.
vi.mock('../ModPanels', () => ({
    ModPanels: () => <div data-testid="mod-panels-stub" />,
}));
vi.mock('../ModScreens', () => ({
    ModScreens: () => <div data-testid="mod-screens-stub" />,
}));
// Phase 6.2 — `LoadOrderSection` has its own integration test; stub it here
// so the ExtensionsTab test stays focused on the trust dialog and inline
// faults. The LoadOrderSection is rendered inside ExtensionsTab when mods
// are present, but its behaviour is pinned in `LoadOrderSection.test.tsx`.
vi.mock('../LoadOrderSection', () => ({
    LoadOrderSection: () => <div data-testid="load-order-stub" />,
}));

// The built-in registry is real (it is a pure factory), but we mock the
// store so the component reads a controlled `moduleEnabled` and writes to
// a spy. The store is the real Zustand `useAppStore`; we seed it with
// `setState` before each render.
import { useAppStore } from '../../../store/useAppStore';
import { ExtensionsTab } from '../ExtensionsTab';
import type { ValidatedMod } from '../../../services/mods/modTypes';

// ── Fixtures ──────────────────────────────────────────────────────────────

const nativeMod = (): ValidatedMod => ({
    id: 'native-mod',
    name: 'Native Mod',
    version: '1.0.0',
    description: 'A mod with native code.',
    author: 'Alice',
    file: 'native-mod/manifest.json',
    folder: 'native-mod',
    dependencies: {},
    contributions: [{ id: 'c', order: 100, text: 'x' }],
    panels: [],
    tables: [],
    screens: [],
    native: { js: 'index.js' },
    provenance: 'installed',
});

const declarativeMod = (): ValidatedMod => ({
    id: 'decl-mod',
    name: 'Declarative Mod',
    version: '2.0.0',
    description: 'A contributions-only mod.',
    author: 'Bob',
    file: 'decl-mod/manifest.json',
    folder: 'decl-mod',
    dependencies: {},
    contributions: [{ id: 'c', order: 100, text: 'x' }],
    panels: [],
    tables: [],
    screens: [],
    provenance: 'installed',
});

// ── Harness ───────────────────────────────────────────────────────────────

function seedStore() {
    useAppStore.setState({
        settings: { moduleEnabled: mocks.moduleEnabled, locale: 'en' },
        updateSettings: mocks.updateSettings,
        toggleBlockView: () => undefined,
        toggleSettings: () => undefined,
        // Phase 6.4 — mod data is per campaign, so the delete affordance needs
        // one open. Seeded here so the button is live in every test that does
        // not deliberately clear it.
        activeCampaignId: 'campaign-1',
    } as unknown as Partial<typeof useAppStore.getState>);
}

async function renderTab(mods: ValidatedMod[], faults: { file: string; reason: string }[] = []) {
    mocks.refreshMods.mockResolvedValueOnce({ mods, faults });
    seedStore();
    const result = render(<ExtensionsTab />);
    // Wait for the refresh to resolve and the mods to render.
    await waitFor(() => expect(screen.getAllByText(mods[0]?.name ?? 'Built-in').length).toBeGreaterThan(0));
    return result;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.trustMap.clear();
    mocks.moduleEnabled = undefined;
    mocks.refreshMods.mockReset();
    mocks.enableNativeMod.mockResolvedValue(undefined);
    mocks.disableNativeMod.mockResolvedValue(undefined);
    mocks.cleanModData.mockResolvedValue([]);
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ExtensionsTab — Phase 6.1 Mod Management', () => {
    it('renders editable caps only for modules that declare one', async () => {
        mocks.refreshMods.mockResolvedValueOnce({ mods: [], faults: [] });
        seedStore();
        render(<ExtensionsTab />);
        await waitFor(() => expect(screen.getByText('NPC Stances')).toBeInTheDocument());

        expect(screen.queryByLabelText('Output token cap')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'NPC Stances' }));
        expect(screen.getByLabelText('Output token cap')).toHaveValue(1200);

        fireEvent.change(screen.getByLabelText('Output token cap'), { target: { value: '3000' } });
        expect(mocks.updateSettings).toHaveBeenCalledWith({ moduleTokens: { npcStance: 3000 } });

        fireEvent.click(screen.getByRole('button', { name: 'On-Stage Relations' }));
        expect(screen.queryByLabelText('Output token cap')).toBeNull();
    });

    describe('native-tier trust dialog', () => {
        // Start the native mod DISABLED so clicking the checkbox enables it
        // (absent = enabled, so the checkbox starts checked unless we seed
        // an explicit false). This is the path that triggers the dialog.
        function seedDisabled(modId: string) {
            mocks.moduleEnabled = { [`mod.${modId}`]: false };
        }

        it('shows the trust dialog when enabling a native mod for the first time', async () => {
            seedDisabled('native-mod');
            await renderTab([nativeMod()]);

            // No dialog yet.
            expect(screen.queryByText('Enable native mod?')).toBeNull();

            // Toggle the native mod on.
            const checkbox = screen.getByLabelText('Enable Native Mod');
            fireEvent.click(checkbox);

            // The dialog appears. The checkbox did NOT write enablement yet.
            await waitFor(() => {
                expect(screen.getByText('Enable native mod?')).toBeInTheDocument();
            });
            expect(mocks.updateSettings).not.toHaveBeenCalled();
        });

        it('on confirm, writes enablement, records acceptance, and fires the lifecycle', async () => {
            seedDisabled('native-mod');
            await renderTab([nativeMod()]);
            const checkbox = screen.getByLabelText('Enable Native Mod');
            fireEvent.click(checkbox);
            await waitFor(() => expect(screen.getByText('Enable native mod?')).toBeInTheDocument());

            // Confirm.
            const confirm = screen.getByRole('button', { name: 'Enable native mod' });
            await act(async () => { fireEvent.click(confirm); });

            // The trust record is written.
            await waitFor(() => {
                expect(mocks.trustMap.get('native-mod')).toEqual({ acceptedNative: true, version: '1.0.0' });
            });
            // Enablement is written. The write spreads the prior map and
            // overwrites the key, so the result is `{ 'mod.native-mod': true }`.
            expect(mocks.updateSettings).toHaveBeenCalledWith(
                expect.objectContaining({ moduleEnabled: { 'mod.native-mod': true } }),
            );
            // The lifecycle hook fired.
            expect(mocks.enableNativeMod).toHaveBeenCalledTimes(1);
            // The dialog is gone.
            await waitFor(() => expect(screen.queryByText('Enable native mod?')).toBeNull());
        });

        it('on cancel, does not write enablement and the dialog closes', async () => {
            seedDisabled('native-mod');
            await renderTab([nativeMod()]);
            const checkbox = screen.getByLabelText('Enable Native Mod');
            fireEvent.click(checkbox);
            await waitFor(() => expect(screen.getByText('Enable native mod?')).toBeInTheDocument());

            const cancel = screen.getByRole('button', { name: 'Cancel' });
            fireEvent.click(cancel);

            expect(mocks.updateSettings).not.toHaveBeenCalled();
            expect(mocks.enableNativeMod).not.toHaveBeenCalled();
            expect(mocks.trustMap.get('native-mod')).toBeUndefined();
            await waitFor(() => expect(screen.queryByText('Enable native mod?')).toBeNull());
        });

        it('does not show the dialog when the mod was already accepted native', async () => {
            // Pre-seed acceptance; start disabled so click = enable.
            mocks.trustMap.set('native-mod', { acceptedNative: true, version: '1.0.0' });
            seedDisabled('native-mod');
            await renderTab([nativeMod()]);

            fireEvent.click(screen.getByLabelText('Enable Native Mod'));

            // No dialog; enablement writes immediately.
            await waitFor(() => {
                expect(mocks.updateSettings).toHaveBeenCalled();
            });
            expect(screen.queryByText('Enable native mod?')).toBeNull();
        });

        it('does not show the dialog for a declarative mod (no native block)', async () => {
            seedDisabled('decl-mod');
            await renderTab([declarativeMod()]);
            fireEvent.click(screen.getByLabelText('Enable Declarative Mod'));
            // Enablement writes immediately; no dialog.
            await waitFor(() => {
                expect(mocks.updateSettings).toHaveBeenCalled();
            });
            expect(screen.queryByText('Enable native mod?')).toBeNull();
        });

        it('re-warns when the mod was accepted non-native and later adds native', async () => {
            // The mod was accepted back when it had no native block.
            mocks.trustMap.set('native-mod', { acceptedNative: false, version: '0.9.0' });
            seedDisabled('native-mod');
            await renderTab([nativeMod()]);

            fireEvent.click(screen.getByLabelText('Enable Native Mod'));
            await waitFor(() => expect(screen.getByText('Enable native mod?')).toBeInTheDocument());
            expect(mocks.updateSettings).not.toHaveBeenCalled();
        });
    });

    describe('inline faults', () => {
        it('surfaces a load-time fault inline in the mod row', async () => {
            const mod = nativeMod();
            await renderTab([mod], [{ file: mod.file, reason: 'invalid JSON: oops' }]);

            // The selected mod's detail pane shows the complete raw fault string.
            expect(screen.getByText('invalid JSON: oops')).toBeInTheDocument();
        });

        it('also shows the fault in the Rejected files section (catch-all)', async () => {
            const mod = nativeMod();
            await renderTab([mod], [{ file: mod.file, reason: 'invalid JSON: oops' }]);

            // The bottom section still renders the raw reason (no prefix).
            expect(screen.getByText('invalid JSON: oops')).toBeInTheDocument();
        });

        it('highlights the faulted row (reason is present next to the mod name)', async () => {
            const mod = nativeMod();
            await renderTab([mod], [{ file: mod.file, reason: 'bad reason' }]);
            expect(screen.getAllByText('Native Mod').length).toBeGreaterThan(0);
            expect(screen.getByText('bad reason')).toBeInTheDocument();
        });
    });

    describe('mod row metadata', () => {
        it('shows the author, folder, version, and tier badge', async () => {
            await renderTab([nativeMod()]);
            expect(screen.getByText('by Alice')).toBeInTheDocument();
            expect(screen.getByText('Folder: native-mod')).toBeInTheDocument();
            expect(screen.getAllByText('native').length).toBeGreaterThan(0); // tier badge
            expect(screen.getByText(/v1.0.0/)).toBeInTheDocument();
        });

        it('shows the sandboxed tier badge for a compute mod', async () => {
            const computeMod: ValidatedMod = {
                ...declarativeMod(),
                id: 'comp-mod',
                name: 'Compute Mod',
                file: 'comp-mod/manifest.json',
                folder: 'comp-mod',
                compute: { file: 'compute.js', hook: 'postTurn', capabilities: [] },
            };
            await renderTab([computeMod]);
            expect(screen.getAllByText('sandboxed').length).toBeGreaterThan(0);
        });

        it('shows the declarative tier badge for a contributions-only mod', async () => {
            await renderTab([declarativeMod()]);
            expect(screen.getAllByText('declarative').length).toBeGreaterThan(0);
        });
    });

    // ── Phase 6.3 — provenance badge ──────────────────────────────────────
    //
    // A bundled mod (ships with the app) shows a "Bundled" badge next to its
    // tier so the user can tell what came with the app from what they added.
    // An installed mod shows "Installed" (or nothing — the default is no
    // badge, since installed is the common case and the badge exists to make
    // bundled mods visually distinct, not to label every mod).
    describe('Phase 6.3 — provenance badge', () => {
        const bundledMod = (): ValidatedMod => ({
            ...declarativeMod(),
            id: 'bundled-tone',
            name: 'Default Tone (Bundled)',
            file: 'bundled-tone/manifest.json',
            folder: 'bundled-tone',
            provenance: 'bundled',
        });

        it('shows the "Bundled" badge for a bundled mod', async () => {
            await renderTab([bundledMod()]);
            expect(screen.getByText('Bundled')).toBeInTheDocument();
        });

        it('does not show the "Bundled" badge for an installed mod', async () => {
            await renderTab([declarativeMod()]);
            expect(screen.queryByText('Bundled')).toBeNull();
        });

        it('shows the "Bundled" badge alongside the tier badge', async () => {
            const mod: ValidatedMod = {
                ...nativeMod(),
                id: 'bundled-native',
                name: 'Bundled Native',
                file: 'bundled-native/manifest.json',
                folder: 'bundled-native',
                provenance: 'bundled',
            };
            await renderTab([mod]);
            // Both the tier badge ("native") and the provenance badge ("Bundled")
            // are present on the same row.
            expect(screen.getAllByText('native').length).toBeGreaterThan(0);
            expect(screen.getByText('Bundled')).toBeInTheDocument();
        });

        it('treats an absent provenance as installed (no Bundled badge)', async () => {
            // A server that has not been updated to stamp `provenance` still
            // produces mods that load. The client defaults to 'installed',
            // which is the safe case (shows no Bundled badge, does not hide
            // any delete affordance).
            const mod: ValidatedMod = {
                ...declarativeMod(),
                provenance: undefined as unknown as 'installed',
            };
            await renderTab([mod]);
            expect(screen.queryByText('Bundled')).toBeNull();
        });
    });

    // ── Phase 6.4 — the data-on-disable policy's two confirmations ────────
    //
    // `DATA_POLICY.md` §5: the disclosure IS the mitigation. No graceful
    // degradation is coming to back it up, so these dialogs blocking — and
    // writing nothing until confirmed — is the whole safety property.
    describe('Phase 6.4 — data confirmations', () => {
        const DISABLE_BODY = /Disabling Declarative Mod mid-campaign will change how this campaign plays/;
        const DELETE_BODY = /Deleting Declarative Mod permanently removes its data from this campaign/;

        it('blocks a mod disable behind a confirmation and writes nothing yet', async () => {
            await renderTab([declarativeMod()]);
            // Absent means enabled, so this click is a DISABLE.
            fireEvent.click(screen.getByLabelText('Enable Declarative Mod'));

            await waitFor(() => expect(screen.getByText(DISABLE_BODY)).toBeInTheDocument());
            expect(mocks.updateSettings).not.toHaveBeenCalled();
            expect(mocks.disableNativeMod).not.toHaveBeenCalled();
        });

        it('on confirm, writes the disable', async () => {
            await renderTab([declarativeMod()]);
            fireEvent.click(screen.getByLabelText('Enable Declarative Mod'));
            await waitFor(() => expect(screen.getByText(DISABLE_BODY)).toBeInTheDocument());

            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disable anyway' })); });

            expect(mocks.updateSettings).toHaveBeenCalledWith(
                expect.objectContaining({ moduleEnabled: { 'mod.decl-mod': false } }),
            );
            await waitFor(() => expect(screen.queryByText(DISABLE_BODY)).toBeNull());
        });

        it('on cancel, changes nothing — no revert needed because nothing was written', async () => {
            await renderTab([declarativeMod()]);
            fireEvent.click(screen.getByLabelText('Enable Declarative Mod'));
            await waitFor(() => expect(screen.getByText(DISABLE_BODY)).toBeInTheDocument());

            fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

            expect(mocks.updateSettings).not.toHaveBeenCalled();
            await waitFor(() => expect(screen.queryByText(DISABLE_BODY)).toBeNull());
            // The checkbox still reflects the state on disk.
            expect((screen.getByLabelText('Enable Declarative Mod') as HTMLInputElement).checked).toBe(true);
        });

        it('does not confirm a disable of a built-in module', async () => {
            // A built-in owns no mod data and no hundreds of scenes written
            // around it; the disclosure would be a lie.
            await renderTab([declarativeMod()]);
            const builtins = screen.getAllByRole('checkbox')
                .filter((el) => el.id !== 'extension-mod.decl-mod');
            expect(builtins.length).toBeGreaterThan(0);
            fireEvent.click(builtins[0]);

            await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalled());
            expect(screen.queryByText(DISABLE_BODY)).toBeNull();
        });

        it('re-enabling is never confirmed — the safe direction has no dialog', async () => {
            mocks.moduleEnabled = { 'mod.decl-mod': false };
            await renderTab([declarativeMod()]);
            fireEvent.click(screen.getByLabelText('Enable Declarative Mod'));

            await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith(
                expect.objectContaining({ moduleEnabled: { 'mod.decl-mod': true } }),
            ));
            expect(screen.queryByText(DISABLE_BODY)).toBeNull();
        });

        it('a toggle NEVER cleans data — clean fires only from the delete action', async () => {
            // `MANIFEST.md` §7.2 / `DATA_POLICY.md` §3, the rule with the most
            // to lose: enabling, disabling and confirming a disable must not
            // reach `cleanModData` on any path.
            await renderTab([declarativeMod()]);
            fireEvent.click(screen.getByLabelText('Enable Declarative Mod'));
            await waitFor(() => expect(screen.getByText(DISABLE_BODY)).toBeInTheDocument());
            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Disable anyway' })); });

            expect(mocks.cleanModData).not.toHaveBeenCalled();
        });

        it('blocks the delete action behind its own confirmation', async () => {
            await renderTab([declarativeMod()]);
            fireEvent.click(screen.getByRole('button', { name: /Delete data/ }));

            await waitFor(() => expect(screen.getByText(DELETE_BODY)).toBeInTheDocument());
            expect(mocks.cleanModData).not.toHaveBeenCalled();
        });

        it('on confirm, runs the clean and reports what was removed', async () => {
            mocks.cleanModData.mockResolvedValue(['mod.decl-mod.notes', 'mod.decl-mod.powers']);
            await renderTab([declarativeMod()]);
            fireEvent.click(screen.getByRole('button', { name: /Delete data/ }));
            await waitFor(() => expect(screen.getByText(DELETE_BODY)).toBeInTheDocument());

            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' })); });

            expect(mocks.cleanModData).toHaveBeenCalledTimes(1);
            expect(mocks.cleanModData.mock.calls[0][0].id).toBe('decl-mod');
            await waitFor(() => expect(screen.getByText('Deleted 2 tables for this campaign.')).toBeInTheDocument());
            // Enablement is untouched: deleting data is not disabling the mod.
            expect(mocks.updateSettings).not.toHaveBeenCalled();
        });

        it('on cancel, deletes nothing', async () => {
            await renderTab([declarativeMod()]);
            fireEvent.click(screen.getByRole('button', { name: /Delete data/ }));
            await waitFor(() => expect(screen.getByText(DELETE_BODY)).toBeInTheDocument());

            fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

            expect(mocks.cleanModData).not.toHaveBeenCalled();
            await waitFor(() => expect(screen.queryByText(DELETE_BODY)).toBeNull());
        });

        it('tells the user when the clear failed rather than implying it worked', async () => {
            mocks.cleanModData.mockRejectedValue(new Error('Mod data clear failed: 500'));
            await renderTab([declarativeMod()]);
            fireEvent.click(screen.getByRole('button', { name: /Delete data/ }));
            await waitFor(() => expect(screen.getByText(DELETE_BODY)).toBeInTheDocument());

            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' })); });

            await waitFor(() => expect(
                screen.getByText(/Could not delete the data: Mod data clear failed: 500\. Nothing was removed\./),
            ).toBeInTheDocument());
        });

        it('says "no data" rather than claiming a deletion that did not happen', async () => {
            mocks.cleanModData.mockResolvedValue([]);
            await renderTab([declarativeMod()]);
            fireEvent.click(screen.getByRole('button', { name: /Delete data/ }));
            await waitFor(() => expect(screen.getByText(DELETE_BODY)).toBeInTheDocument());

            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' })); });

            await waitFor(() => expect(
                screen.getByText('This mod had no data in this campaign.'),
            ).toBeInTheDocument());
        });

        it('disables the delete action with no campaign open', async () => {
            mocks.refreshMods.mockResolvedValueOnce({ mods: [declarativeMod()], faults: [] });
            seedStore();
            useAppStore.setState({ activeCampaignId: null } as never);
            render(<ExtensionsTab />);
            await waitFor(() => expect(screen.getAllByText('Declarative Mod').length).toBeGreaterThan(0));

            const button = screen.getByRole('button', { name: /Delete data/ }) as HTMLButtonElement;
            expect(button.disabled).toBe(true);
            expect(button.title).toBe('Open a campaign to delete its mod data.');
        });

        it('offers no delete action for a built-in module', async () => {
            await renderTab([declarativeMod()]);
            // One mod row, one delete button — the built-ins own no mod data.
            expect(screen.getAllByRole('button', { name: /Delete data/ })).toHaveLength(1);
        });

        it('offers the delete action for a bundled mod too', async () => {
            // A bundled mod's data is still the user's data. Clearing it is not
            // the same act as removing the mod, which the app never does.
            const bundled: ValidatedMod = { ...declarativeMod(), provenance: 'bundled' };
            await renderTab([bundled]);
            expect(screen.getAllByRole('button', { name: /Delete data/ })).toHaveLength(1);
        });
    });
});