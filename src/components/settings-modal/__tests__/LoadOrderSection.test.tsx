/**
 * Phase 6.2 — `LoadOrderSection` integration tests.
 *
 * Pins the three behaviours the spec requires:
 *  1. The resolved load order is visible (each row shows its position).
 *  2. Up/down reordering writes `settings.modLoadOrder` and re-fetches,
 *     so the change takes effect live (no restart).
 *  3. A dependency-violating move is prevented — the button is disabled
 *     and the tooltip names the dependency.
 *
 * Conflict surfacing (fact conflicts) is tested through the
 * `loadOrderConflicts` unit tests; this test focuses on the UI behaviour.
 * The conflict badge is rendered from the fault store, which is stubbed
 * here to return empty (the wiring is tested in `loadOrderConflicts.test.ts`).
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.hoisted` so the mock stubs exist before the component imports resolve.
const mocks = vi.hoisted(() => ({
    refreshMods: vi.fn(),
    updateSettings: vi.fn(),
    modLoadOrder: undefined as string[] | undefined,
}));

vi.mock('../../../services/mods/modBootstrap', () => ({
    refreshMods: mocks.refreshMods,
}));

// Stub the conflict module so no fault store state leaks into the UI test.
// The conflict aggregation logic is tested in its own unit test.
vi.mock('../../../services/mods/loadOrder/loadOrderConflicts', () => ({
    collectLoadOrderConflicts: () => [],
    conflictsByModId: () => new Map(),
}));

import { useAppStore } from '../../../store/useAppStore';
import { LoadOrderSection } from '../LoadOrderSection';
import type { ValidatedMod } from '../../../services/mods/modTypes';

const makeMod = (id: string, deps: Record<string, string> = {}, loadOrder = 0): ValidatedMod => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    version: '1.0.0',
    description: '',
    file: `${id}/manifest.json`,
    folder: id,
    folderPath: `/mods/${id}`,
    dependencies: deps,
    loadOrder,
    i18n: {},
    i18nStrings: {},
    contributions: [],
    panels: [],
    tables: [],
    screens: [],
    screenSources: [],
});

function seedStore(modLoadOrder?: string[]) {
    useAppStore.setState({
        settings: { modLoadOrder, locale: 'en' },
        updateSettings: mocks.updateSettings,
    } as unknown as Partial<typeof useAppStore.getState>);
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.refreshMods.mockResolvedValue({ mods: [], faults: [] });
    mocks.modLoadOrder = undefined;
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('LoadOrderSection — Phase 6.2', () => {
    describe('visible load order', () => {
        it('renders each mod with its resolved position', async () => {
            seedStore();
            const mods = [makeMod('a'), makeMod('b'), makeMod('c')];
            render(<LoadOrderSection mods={mods} />);
            expect(screen.getByText('#1')).toBeInTheDocument();
            expect(screen.getByText('#2')).toBeInTheDocument();
            expect(screen.getByText('#3')).toBeInTheDocument();
            expect(screen.getByText('A')).toBeInTheDocument();
            expect(screen.getByText('B')).toBeInTheDocument();
            expect(screen.getByText('C')).toBeInTheDocument();
        });

        it('renders nothing when there are no mods', () => {
            seedStore();
            const { container } = render(<LoadOrderSection mods={[]} />);
            expect(container).toBeEmptyDOMElement();
        });
    });

    describe('user override (reorder)', () => {
        it('move up writes modLoadOrder and calls refreshMods', async () => {
            seedStore();
            const mods = [makeMod('a'), makeMod('b')];
            render(<LoadOrderSection mods={mods} />);

            // 'b' is at position #2. Click its move-up button.
            const upButtons = screen.getAllByLabelText('Move up');
            expect(upButtons).toHaveLength(2);
            fireEvent.click(upButtons[1]); // 'b's move-up

            await waitFor(() => {
                expect(mocks.updateSettings).toHaveBeenCalledWith(
                    expect.objectContaining({ modLoadOrder: ['b', 'a'] }),
                );
            });
            expect(mocks.refreshMods).toHaveBeenCalledTimes(1);
        });

        it('move down writes modLoadOrder and calls refreshMods', async () => {
            seedStore();
            const mods = [makeMod('a'), makeMod('b')];
            render(<LoadOrderSection mods={mods} />);

            const downButtons = screen.getAllByLabelText('Move down');
            fireEvent.click(downButtons[0]); // 'a's move-down

            await waitFor(() => {
                expect(mocks.updateSettings).toHaveBeenCalledWith(
                    expect.objectContaining({ modLoadOrder: ['b', 'a'] }),
                );
            });
            expect(mocks.refreshMods).toHaveBeenCalledTimes(1);
        });

        it('reset to manifest order clears modLoadOrder and calls refreshMods', async () => {
            seedStore(['b', 'a']); // user has an override
            const mods = [makeMod('a'), makeMod('b')];
            render(<LoadOrderSection mods={mods} />);

            const resetBtn = screen.getByText('Reset to manifest order');
            fireEvent.click(resetBtn);

            await waitFor(() => {
                expect(mocks.updateSettings).toHaveBeenCalledWith(
                    expect.objectContaining({ modLoadOrder: [] }),
                );
            });
            expect(mocks.refreshMods).toHaveBeenCalledTimes(1);
        });
    });

    describe('dependency-violation prevention', () => {
        it('disables move-up when the mod above is a dependency', () => {
            seedStore();
            // 'need' depends on 'dep'. Resolved order: ['dep', 'need'].
            const mods = [makeMod('dep'), makeMod('need', { dep: '*' })];
            render(<LoadOrderSection mods={mods} />);

            const upButtons = screen.getAllByLabelText('Move up');
            // 'dep' is #1 (no move-up); 'need' is #2 (move-up would put it
            // above 'dep', which is its dependency — blocked).
            expect(upButtons[0]).toBeDisabled(); // 'dep' at #1
            expect(upButtons[1]).toBeDisabled(); // 'need' at #2, blocked by dep
            // The tooltip names the dependency by its DISPLAY name — what the
            // user sees in the list — not its id. ('dep' passed here by
            // accident: the sentence contains the word "depends".)
            expect(upButtons[1].getAttribute('title')).toBe('Cannot move up — depends on Dep');
        });

        it('disables move-down when the mod below is a dependent', () => {
            seedStore();
            // 'need' depends on 'dep'. Resolved order: ['dep', 'need'].
            const mods = [makeMod('dep'), makeMod('need', { dep: '*' })];
            render(<LoadOrderSection mods={mods} />);

            const downButtons = screen.getAllByLabelText('Move down');
            // 'dep' is #1 (move-down would put it below 'need', which
            // depends on it — blocked). 'need' is #2 (no move-down).
            expect(downButtons[0]).toBeDisabled(); // 'dep', blocked by need
            expect(downButtons[1]).toBeDisabled(); // 'need' at #2, last
            expect(downButtons[0].getAttribute('title')).toBe('Cannot move down — Need depends on it');
        });

        it('allows reordering independent mods', () => {
            seedStore();
            const mods = [makeMod('a'), makeMod('b'), makeMod('c')];
            render(<LoadOrderSection mods={mods} />);

            const upButtons = screen.getAllByLabelText('Move up');
            const downButtons = screen.getAllByLabelText('Move down');
            // 'a' at #1: move-up disabled (first), move-down enabled.
            expect(upButtons[0]).toBeDisabled();
            expect(downButtons[0]).not.toBeDisabled();
            // 'b' at #2: both enabled.
            expect(upButtons[1]).not.toBeDisabled();
            expect(downButtons[1]).not.toBeDisabled();
            // 'c' at #3: move-up enabled, move-down disabled (last).
            expect(upButtons[2]).not.toBeDisabled();
            expect(downButtons[2]).toBeDisabled();
        });
    });
});