/**
 * `HeaderModGroup` — the header's mod-entry group and its overflow control.
 *
 * The property under test is the one the old row lacked: THE HEADER'S WIDTH IS
 * BOUNDED. `header.actions` is an open region, and before this component every
 * claimed entry rendered inline into an `overflow-x-auto no-scrollbar` row —
 * so entries past the right edge existed in the DOM, were unreachable without a
 * scroll gesture, and had no scrollbar advertising that the gesture existed.
 *
 * These tests assert the bound holds no matter how many entries arrive, that
 * nothing is lost when it does (the overflow list is complete), and that a
 * zero-mod header still renders nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
    readRegion,
    registerModChrome,
    resetMountRegistryForTests,
} from '../../../services/mods/mounts/mountRegistry';
import { HeaderModGroup, INLINE_LIMIT } from '../HeaderModGroup';

/**
 * A `t` that behaves like the host's: it returns the key when the key is not in
 * the bundle. The component's own keys are resolved to readable strings so the
 * assertions can name them; anything else falls through as the key, which is
 * exactly the input `resolveText` has to defend against.
 */
const t = (key: string, vars?: Record<string, string | number>): string => {
    if (key === 'header.mods.overflow.tooltip') return `${vars?.count} more mod actions`;
    if (key === 'header.mods.overflow.aria') return 'More mod actions';
    if (key === 'header.mods.overflow.heading') return 'Mod actions';
    return key;
};

const entry = (id: string, label: string, onSelect: () => void = () => undefined) => ({
    id,
    icon: 'Tag',
    label,
    tooltip: label,
    onSelect,
    state: () => ({ tone: 'active' as const }),
});

/** Register `count` mod entries, one per mod, in load order. */
function registerEntries(count: number, onSelect?: (index: number) => void): void {
    for (let i = 0; i < count; i += 1) {
        registerModChrome(
            'header.actions',
            { id: `mod-${i}`, name: `Mod ${i}` },
            entry(`entry-${i}`, `Action ${i}`, () => onSelect?.(i)),
            i,
        );
    }
}

/** The mod entries from the region, which is what `Header.tsx` passes in. */
const modEntries = () => readRegion('header.actions').filter((e) => e.renderer !== 'builtin');

beforeEach(() => {
    resetMountRegistryForTests();
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('HeaderModGroup', () => {
    it('renders nothing when no mod has claimed a header button', () => {
        const { container } = render(<HeaderModGroup entries={[]} t={t} />);
        // Not "renders an empty group" — renders NOTHING. A zero-mod header has
        // to stay byte-identical to the pre-mount header (MOUNTS.md §8.2), so
        // the divider and the overflow control must both be absent.
        expect(container.firstChild).toBeNull();
    });

    it('renders every entry inline while the count is within the limit', () => {
        registerEntries(INLINE_LIMIT);
        render(<HeaderModGroup entries={modEntries()} t={t} />);

        for (let i = 0; i < INLINE_LIMIT; i += 1) {
            expect(screen.getByRole('button', { name: `Action ${i}` })).toBeInTheDocument();
        }
        // No overflow control: nothing was hidden, so nothing announces itself.
        expect(screen.queryByRole('button', { name: /more mod actions/i })).toBeNull();
    });

    it('collapses entries past the limit behind one overflow control', () => {
        registerEntries(INLINE_LIMIT + 3);
        render(<HeaderModGroup entries={modEntries()} t={t} />);

        // The first INLINE_LIMIT are inline.
        for (let i = 0; i < INLINE_LIMIT; i += 1) {
            expect(screen.getByRole('button', { name: `Action ${i}` })).toBeInTheDocument();
        }
        // The rest are NOT in the row.
        for (let i = INLINE_LIMIT; i < INLINE_LIMIT + 3; i += 1) {
            expect(screen.queryByRole('button', { name: `Action ${i}` })).toBeNull();
        }
        // One control stands in for all of them, and its badge is the count.
        const overflow = screen.getByRole('button', { name: '3 more mod actions' });
        expect(overflow).toBeInTheDocument();
        expect(overflow.textContent).toContain('3');
    });

    it('bounds the row: the inline count never exceeds the limit however many mods claim a button', () => {
        // The regression this component exists for. Twenty entries used to mean
        // twenty buttons in the row.
        registerEntries(20);
        render(<HeaderModGroup entries={modEntries()} t={t} />);

        const inline = screen
            .getAllByRole('button')
            .filter((b) => /^Action \d+$/.test(b.getAttribute('aria-label') ?? ''));
        expect(inline).toHaveLength(INLINE_LIMIT);
        expect(screen.getByRole('button', { name: `${20 - INLINE_LIMIT} more mod actions` }))
            .toBeInTheDocument();
    });

    it('the overflow menu lists every collapsed entry, and none of the inline ones', () => {
        registerEntries(INLINE_LIMIT + 4);
        render(<HeaderModGroup entries={modEntries()} t={t} />);

        fireEvent.click(screen.getByRole('button', { name: '4 more mod actions' }));

        const menu = screen.getByRole('menu', { name: 'More mod actions' });
        const items = [...menu.querySelectorAll('[role="menuitem"]')].map((n) =>
            (n.textContent ?? '').trim(),
        );
        expect(items).toHaveLength(4);
        for (let i = INLINE_LIMIT; i < INLINE_LIMIT + 4; i += 1) {
            expect(items.some((text) => text.includes(`Action ${i}`))).toBe(true);
        }
        // The inline entries are not duplicated into the menu.
        expect(items.some((text) => text.includes('Action 0'))).toBe(false);
    });

    it('names the owning mod on each menu row', () => {
        // An overflow list of eight entries from four mods is unreadable without
        // this: two mods may both claim an entry labelled "Open".
        registerEntries(INLINE_LIMIT + 1);
        render(<HeaderModGroup entries={modEntries()} t={t} />);
        fireEvent.click(screen.getByRole('button', { name: '1 more mod actions' }));

        const menu = screen.getByRole('menu', { name: 'More mod actions' });
        expect(menu.textContent).toContain(`Mod ${INLINE_LIMIT}`);
    });

    it('dispatches onSelect and closes the menu when a collapsed entry is chosen', () => {
        const chosen: number[] = [];
        registerEntries(INLINE_LIMIT + 1, (i) => chosen.push(i));
        render(<HeaderModGroup entries={modEntries()} t={t} />);

        fireEvent.click(screen.getByRole('button', { name: '1 more mod actions' }));
        const item = screen.getByRole('menuitem');
        fireEvent.click(item);

        expect(chosen).toEqual([INLINE_LIMIT]);
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('closes the menu on Escape', () => {
        registerEntries(INLINE_LIMIT + 1);
        render(<HeaderModGroup entries={modEntries()} t={t} />);

        fireEvent.click(screen.getByRole('button', { name: '1 more mod actions' }));
        expect(screen.getByRole('menu')).toBeInTheDocument();

        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('closes the menu on an outside pointer press', () => {
        registerEntries(INLINE_LIMIT + 1);
        render(<HeaderModGroup entries={modEntries()} t={t} />);

        fireEvent.click(screen.getByRole('button', { name: '1 more mod actions' }));
        expect(screen.getByRole('menu')).toBeInTheDocument();

        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('positions the menu against the viewport, not against the scrolling row', () => {
        // The row this renders into is `overflow-x-auto`, and an absolutely
        // positioned child of a scroll container lays out against the
        // container's SCROLL box. With `absolute right-0` the menu was pinned to
        // the row's right edge — which is off-screen precisely when the row is
        // wide enough to need an overflow control. Measured in the running app
        // before this fix: a 267px menu at x=1439 in a 1280px viewport.
        registerEntries(INLINE_LIMIT + 2);
        render(<HeaderModGroup entries={modEntries()} t={t} />);

        const trigger = screen.getByRole('button', { name: '2 more mod actions' });
        // jsdom reports a zero rect; the anchor maths still has to produce a
        // viewport-relative `right` that keeps the menu on screen.
        fireEvent.click(trigger);

        const menu = screen.getByRole('menu');
        expect(menu.className).toContain('fixed');
        expect(menu.className).not.toContain('absolute');

        const right = Number.parseFloat(menu.style.right);
        expect(Number.isNaN(right)).toBe(false);
        // On screen on the right, and never so far right that the left edge
        // leaves the window.
        expect(right).toBeGreaterThanOrEqual(0);
        expect(right).toBeLessThanOrEqual(window.innerWidth);
        expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(0);
    });

    it('renders a mod entry label as the author wrote it, not as an i18n key', () => {
        // The `MOD.EXAMPLE-WINDOW-MOD.WINDOW` regression. `resolveText` tries the
        // mod's namespaced key first; `t` returns the key on a miss, and without
        // the fallback that key reached the button and the header uppercased it.
        registerModChrome(
            'header.actions',
            { id: 'example-window-mod', name: 'Example Window Mod' },
            entry('openWindow', 'WINDOW'),
            0,
        );
        render(<HeaderModGroup entries={modEntries()} t={t} />);

        expect(screen.getByRole('button', { name: 'WINDOW' })).toBeInTheDocument();
        expect(screen.queryByText('mod.example-window-mod.WINDOW')).toBeNull();
    });

    it('prefers a registered translation over the literal when one exists', () => {
        // The other half of the contract: the lookup is still real. A mod that
        // ships translations gets them by writing a key.
        const translating = (key: string) =>
            key === 'mod.translated-mod.openWindow' ? 'Fenster' : key;
        registerModChrome(
            'header.actions',
            { id: 'translated-mod', name: 'Translated Mod' },
            entry('open', 'openWindow'),
            0,
        );
        render(<HeaderModGroup entries={modEntries()} t={translating} />);

        expect(screen.getByRole('button', { name: 'Fenster' })).toBeInTheDocument();
    });

    it('keeps every status entry visible when the header asks for status-only rendering', () => {
        registerEntries(INLINE_LIMIT + 4);
        render(<HeaderModGroup entries={modEntries()} t={t} statusOnly />);

        for (let i = 0; i < INLINE_LIMIT + 4; i += 1) {
            expect(screen.getByRole('button', { name: `Action ${i}` })).toBeInTheDocument();
        }
        expect(screen.queryByRole('button', { name: /more mod actions/i })).toBeNull();
    });
});
