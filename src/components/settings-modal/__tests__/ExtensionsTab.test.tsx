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
});

// ── Harness ───────────────────────────────────────────────────────────────

function seedStore() {
    useAppStore.setState({
        settings: { moduleEnabled: mocks.moduleEnabled, locale: 'en' },
        updateSettings: mocks.updateSettings,
        toggleBlockView: () => undefined,
        toggleSettings: () => undefined,
    } as unknown as Partial<typeof useAppStore.getState>);
}

async function renderTab(mods: ValidatedMod[], faults: { file: string; reason: string }[] = []) {
    mocks.refreshMods.mockResolvedValueOnce({ mods, faults });
    seedStore();
    const result = render(<ExtensionsTab />);
    // Wait for the refresh to resolve and the mods to render.
    await waitFor(() => expect(screen.getByText(mods[0]?.name ?? 'Built-in')).toBeInTheDocument());
    return result;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.trustMap.clear();
    mocks.moduleEnabled = undefined;
    mocks.refreshMods.mockReset();
    mocks.enableNativeMod.mockResolvedValue(undefined);
    mocks.disableNativeMod.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ExtensionsTab — Phase 6.1 Mod Management', () => {
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

            // The inline reason appears with the "This mod could not run:" prefix,
            // distinguishing it from the bottom "Rejected files" section.
            expect(screen.getByText(/This mod could not run: invalid JSON: oops/)).toBeInTheDocument();
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
            expect(screen.getByText('Native Mod')).toBeInTheDocument();
            expect(screen.getByText(/This mod could not run: bad reason/)).toBeInTheDocument();
        });
    });

    describe('mod row metadata', () => {
        it('shows the author, folder, version, and tier badge', async () => {
            await renderTab([nativeMod()]);
            expect(screen.getByText('by Alice')).toBeInTheDocument();
            expect(screen.getByText('Folder: native-mod')).toBeInTheDocument();
            expect(screen.getByText('native')).toBeInTheDocument(); // tier badge
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
            expect(screen.getByText('sandboxed')).toBeInTheDocument();
        });

        it('shows the declarative tier badge for a contributions-only mod', async () => {
            await renderTab([declarativeMod()]);
            expect(screen.getByText('declarative')).toBeInTheDocument();
        });
    });
});