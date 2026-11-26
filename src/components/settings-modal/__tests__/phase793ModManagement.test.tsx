/**
 * Phase 7.9.3 — CHECKPOINT 4 · item 4's second clause, the one that is not
 * about behaviour at all:
 *
 *   > *"…and **the conflict is visible in Mod Management** — a mod silently
 *   > replacing a core system is the exact confusion this must not create."*
 *
 * `phase793RoleClaim.test.ts` proves the arbitration and that the loser never
 * runs. Neither of those is worth anything to a user who cannot see it, and
 * `ROLES.md` §4.2 calls this rung's visibility **non-negotiable**: the mod row
 * says what it replaces and whether its claim is live, and the load-order row
 * names the winner.
 *
 * So this renders the real `ExtensionsTab` — with the real `serviceRoles`
 * registry, the real `roleFaultStore` and the real `LoadOrderSection` (not
 * stubbed, unlike `ExtensionsTab.test.tsx`, because the load-order row IS half
 * the assertion here) — against two mods contending for `memory.recall`.
 *
 * The claims are registered through `configureModRoles`, the production
 * factory, rather than by driving the loader: this file is about what the
 * screen says, and the end-to-end claim path is already the subject of the
 * sibling test.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    refreshMods: vi.fn(),
    enableNativeMod: vi.fn(),
    disableNativeMod: vi.fn(),
    cleanModData: vi.fn(),
    updateSettings: vi.fn(),
}));

vi.mock('../../../services/mods/modBootstrap', () => ({
    refreshMods: mocks.refreshMods,
    enableNativeMod: mocks.enableNativeMod,
    disableNativeMod: mocks.disableNativeMod,
    cleanModData: mocks.cleanModData,
}));

// `idb-keyval` never runs in the test environment.
vi.mock('../../../services/mods/nativeTrustStore', () => ({
    getNativeTrustStore: () => ({
        get: async () => ({ acceptedNative: true, version: '1.0.0' }),
        set: async () => undefined,
        clear: async () => undefined,
    }),
    needsNativeTrustWarning: async () => false,
    recordNativeTrustAcceptance: async () => undefined,
}));

// Heavy children with their own import graphs; irrelevant to the role rows.
vi.mock('../ModPanels', () => ({ ModPanels: () => <div /> }));
vi.mock('../ModScreens', () => ({ ModScreens: () => <div /> }));

import { useAppStore } from '../../../store/useAppStore';
import { ExtensionsTab } from '../ExtensionsTab';
import type { ValidatedMod } from '../../../services/mods/modTypes';
import {
    configureModRoles,
    disableModRoles,
    enableModRoles,
    roleFaultStore,
    serviceRoles,
} from '../../../services/roles';

const WINNER = 'role-claimant';
const LOSER = 'role-rival';

/** Display names differ from ids so a row is findable without matching its file path. */
const DISPLAY: Record<string, string> = { [WINNER]: 'Claimant Mod', [LOSER]: 'Rival Mod' };

const claimingMod = (id: string, loadOrder: number): ValidatedMod => ({
    id,
    name: DISPLAY[id],
    version: '1.0.0',
    description: 'A mod that claims Memory recall.',
    author: 'Narrative Engine',
    file: `${id}/manifest.json`,
    folder: id,
    dependencies: {},
    loadOrder,
    contributions: [],
    panels: [],
    tables: [],
    screens: [],
    roles: ['memory.recall'],
    native: { js: 'index.js' },
    provenance: 'installed',
} as unknown as ValidatedMod);

/** Register a claim the way `lifecycleHost` does: lease, context, provide. */
function claim(modId: string, loadIndex: number): void {
    enableModRoles(modId);
    const roles = configureModRoles({
        mod: { id: modId, name: DISPLAY[modId] ?? modId },
        declaredRoles: ['memory.recall'],
        loadIndex,
        faultFile: `mod:${modId}`,
    });
    roles.provide('memory.recall', () => ({ sceneIds: [] }) as never);
}

function seedStore() {
    useAppStore.setState({
        settings: { moduleEnabled: undefined, locale: 'en', modLoadOrder: undefined },
        updateSettings: mocks.updateSettings,
        toggleBlockView: () => undefined,
        toggleSettings: () => undefined,
        activeCampaignId: 'campaign-1',
    } as unknown as Partial<typeof useAppStore.getState>);
}

beforeEach(async () => {
    vi.clearAllMocks();
    roleFaultStore.clear();
    serviceRoles.clear();
    mocks.refreshMods.mockResolvedValue({ mods: [], faults: [] });

    // Two claimants, the winner at the lower resolved load index.
    claim(WINNER, 0);
    claim(LOSER, 1);
    // Resolving the winner once is what records the conflict, exactly as the
    // first ask of a turn does — the registry surfaces it at arbitration time.
    expect(serviceRoles.activeProviderFor('memory.recall')?.modId).toBe(WINNER);
});

afterEach(() => {
    disableModRoles(WINNER);
    disableModRoles(LOSER);
    serviceRoles.clear();
    roleFaultStore.clear();
    vi.restoreAllMocks();
});

async function renderTab(mods: ValidatedMod[]) {
    mocks.refreshMods.mockResolvedValueOnce({ mods, faults: [] });
    seedStore();
    const result = render(<ExtensionsTab />);
    // `getAllByText`: the name appears twice by design — once on the mod row
    // and once on its load-order row, which is exactly the pair this file is
    // asserting against.
    await waitFor(() => expect(screen.getAllByText(mods[0].name).length).toBeGreaterThan(0));
    return result;
}

describe('Phase 7.9.3 · item 4 — the conflict is visible in Mod Management', () => {
    it('each mod row says what it replaces, and which one is actually answering', async () => {
        await renderTab([claimingMod(WINNER, 10), claimingMod(LOSER, 50)]);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Claimant Mod/ })); });
        await waitFor(() => expect(screen.getByText('Replaces: Memory recall · Active')).toBeInTheDocument());

        // The winner: replaces the core system, and its claim is live.
        expect(screen.getByText('Replaces: Memory recall · Active')).toBeInTheDocument();

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Rival Mod/ })); });
        await waitFor(() => expect(screen.getByText(`Replaces: Memory recall · Overridden by ${WINNER}`)).toBeInTheDocument());

        // The loser: it still declares the replacement (so the user knows what
        // it wanted), and it is told plainly who took the role instead. This is
        // the "silently replacing a core system" failure, inverted.
        expect(screen.getByText(`Replaces: Memory recall · Overridden by ${WINNER}`)).toBeInTheDocument();
    });

    it('the load-order row names the role, the winner, and why it won', async () => {
        await renderTab([claimingMod(WINNER, 10), claimingMod(LOSER, 50)]);
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Load order/i })); });

        expect(
            screen.getByText(`Role conflict with ${WINNER} — ${WINNER} wins (loads first)`),
        ).toBeInTheDocument();
    });

    it('a mod whose claim is declared but not contended reads as active, not as a conflict', async () => {
        disableModRoles(LOSER);
        roleFaultStore.clear();

        await renderTab([claimingMod(WINNER, 10)]);

        expect(screen.getByText('Replaces: Memory recall · Active')).toBeInTheDocument();
        expect(screen.queryByText(/Role conflict with/)).toBeNull();
    });
});
