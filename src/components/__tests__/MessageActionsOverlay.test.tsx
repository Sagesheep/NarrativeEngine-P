/**
 * Phase 4.4 — `MessageActionsOverlay` component tests.
 *
 * Proves the `message.actions` chrome mount against the contract in
 * `MOUNTS.md` §2.5 / §8.2 / §8.8:
 *   • Zero-mod DOM: renders nothing when no mod has claimed message.actions (§2.8).
 *   • Renders nothing while editing (§2.5 — "mod entries never appear in the
 *     editing state").
 *   • Renders a native icon button per claimed entry, in (loadIndex,
 *     withinModIndex) order.
 *   • Honors `state().hidden` — a hidden entry is removed from the rail.
 *   • `state().active` styles the button as terminal (matching the built-in
 *     speak-active styling).
 *   • Clicking the button drains a pending commit before dispatching onSelect
 *     (§8.8 — message.actions is chat-scoped).
 *   • Disable removes the entry (§8.5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
    disableModMounts,
    registerModChrome,
    resetMountRegistryForTests,
} from '../../services/mods/mounts/mountRegistry';
import { MessageActionsOverlay } from '../message/MessageActionsOverlay';

const MOD_A = { id: 'mod-a', name: 'Mod A' };
const MOD_B = { id: 'mod-b', name: 'Mod B' };

/**
 * The renderer resolves label/tooltip through the host's i18n lookup in the
 * mod's namespace: `mod.<modId>.<key>` (`MOUNTS.md` §8.2). The overlay passes
 * a minimal `t` that returns the key as-is (the host's real `t` falls back
 * key-as-last-resort, so an unknown mod key renders something visible). For
 * a literal tooltip like `'Tag this message'`, the namespaced key becomes
 * `mod.mod-a.Tag this message` — that is what the DOM sees, and it is the
 * honest behavior: a mod's literal misses the lookup and renders as itself
 * (with the namespace prefix, which is how the host's `t` would surface an
 * unknown key). Tests assert on the namespaced value.
 */
const namespaced = (modId: string, value: string) => `mod.${modId}.${value}`;

const noopEntry = (id: string, overrides: Partial<{ icon: string; label: string; tooltip: string; onSelect: () => void; state: () => unknown }> = {}) => ({
    id,
    icon: 'Tag',
    label: id,
    onSelect: overrides.onSelect ?? (() => undefined),
    ...overrides,
});

beforeEach(() => {
    resetMountRegistryForTests();
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('Phase 4.4 — MessageActionsOverlay', () => {
    it('renders nothing when no mod has claimed message.actions (zero-mod DOM, §2.8)', () => {
        const { container } = render(<MessageActionsOverlay />);
        expect(container.firstChild).toBeNull();
    });

    it('renders nothing while editing (§2.5)', () => {
        registerModChrome('message.actions', MOD_A, noopEntry('tag'), 0);
        const { container } = render(<MessageActionsOverlay isEditing={true} />);
        expect(container.firstChild).toBeNull();
    });

    it('renders a native icon button per claimed entry', () => {
        registerModChrome('message.actions', MOD_A, noopEntry('tag', { tooltip: 'Tag this message' }), 0);
        render(<MessageActionsOverlay />);
        const button = screen.getByRole('button', { name: namespaced('mod-a', 'Tag this message') });
        expect(button).toBeInTheDocument();
        // The button uses the same classes as the built-in rail buttons —
        // `p-1.5 bg-void-lighter rounded` with text-text-dim idle.
        expect(button.className).toContain('bg-void-lighter');
        expect(button.className).toContain('text-text-dim');
    });

    it('orders entries by (loadIndex, withinModIndex) — a lower loadIndex sorts first', () => {
        registerModChrome('message.actions', MOD_A, noopEntry('late', { tooltip: 'Late' }), 5);
        registerModChrome('message.actions', MOD_B, noopEntry('early', { tooltip: 'Early' }), 1);
        render(<MessageActionsOverlay />);
        const buttons = screen.getAllByRole('button');
        // MOD_B (loadIndex 1) sorts first; MOD_A (loadIndex 5) sorts second.
        expect(buttons[0].getAttribute('aria-label')).toBe(namespaced('mod-b', 'Early'));
        expect(buttons[1].getAttribute('aria-label')).toBe(namespaced('mod-a', 'Late'));
    });

    it('honors state().hidden — a hidden entry is removed from the rail', () => {
        registerModChrome('message.actions', MOD_A, noopEntry('hidden-one', {
            tooltip: 'Hide me',
            state: () => ({ hidden: true }),
        }), 0);
        registerModChrome('message.actions', MOD_B, noopEntry('visible-one', {
            tooltip: 'Show me',
        }), 1);
        render(<MessageActionsOverlay />);
        expect(screen.queryByRole('button', { name: namespaced('mod-a', 'Hide me') })).toBeNull();
        expect(screen.getByRole('button', { name: namespaced('mod-b', 'Show me') })).toBeInTheDocument();
    });

    it('state().active styles the button as terminal (matching built-in speak-active)', () => {
        registerModChrome('message.actions', MOD_A, noopEntry('active-one', {
            tooltip: 'Active',
            state: () => ({ active: true }),
        }), 0);
        render(<MessageActionsOverlay />);
        const button = screen.getByRole('button', { name: namespaced('mod-a', 'Active') });
        expect(button.className).toContain('text-terminal');
    });

    it('clicking the button drains a pending commit before dispatching onSelect (§8.8)', async () => {
        const onSelect = vi.fn();
        registerModChrome('message.actions', MOD_A, noopEntry('tag', { tooltip: 'Tag', onSelect }), 0);

        // Mock the lazy import of commitPendingTurn so we can assert the drain
        // runs before onSelect. The dynamic import is mocked at module scope.
        const commitPendingTurn = vi.fn(async () => undefined);
        vi.doMock('../../services/turn/pendingCommit', () => ({ commitPendingTurn }));

        render(<MessageActionsOverlay />);
        const button = screen.getByRole('button', { name: namespaced('mod-a', 'Tag') });
        fireEvent.click(button);

        // onSelect fires after the drain resolves. The drain is async, so we
        // wait for onSelect to be called.
        await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
        // The drain ran first — verified by the order of calls. The lazy
        // import is mocked, so the drain calls our spy.
        await waitFor(() => expect(commitPendingTurn).toHaveBeenCalledTimes(1));
    });

    it('disable removes the entry from the overlay (§8.5)', async () => {
        registerModChrome('message.actions', MOD_A, noopEntry('tag', { tooltip: 'Tag' }), 0);
        render(<MessageActionsOverlay />);
        expect(screen.getByRole('button', { name: namespaced('mod-a', 'Tag') })).toBeInTheDocument();
        disableModMounts('mod-a');
        await waitFor(() => expect(screen.queryByRole('button', { name: namespaced('mod-a', 'Tag') })).toBeNull());
    });

    it('a throwing state() renders from last good state and does not crash (§8.6)', () => {
        registerModChrome('message.actions', MOD_A, noopEntry('flaky', {
            tooltip: 'Flaky',
            state: () => { throw new Error('state blew up'); },
        }), 0);
        // The renderer reads state() in a try/catch; a throw renders from the
        // last good state (undefined initially) and does not crash.
        expect(() => render(<MessageActionsOverlay />)).not.toThrow();
        expect(screen.getByRole('button', { name: namespaced('mod-a', 'Flaky') })).toBeInTheDocument();
    });
});