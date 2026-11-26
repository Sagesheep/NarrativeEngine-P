/**
 * `RailPanelSwitcher` — how the `chat.rail` dock lets you choose a panel.
 *
 * The regression under test is a readability one. The strip this replaces gave
 * every tab `flex-1`, so four panels in a 320px rail truncated ALL FOUR titles
 * to about seven characters — the observed state was
 * `MARKS · PROBE · PROBE-T… · TEMPLATE`. Two assertions matter: a short title
 * must not be truncated just because it shares a row with a long one, and past
 * the tab limit the active panel's full title must still be legible.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RailPanelSwitcher, TAB_LIMIT } from '../RailPanelSwitcher';
import type { RegisteredRailPanel } from '../../../services/mods/mounts/mountRegistry';

const panel = (id: string, title: string) =>
    ({
        qualifiedId: `mod.${id}.panel`,
        panel: { id: 'panel', title },
    }) as unknown as RegisteredRailPanel;

const panels = (...titles: string[]) =>
    titles.map((title, i) => panel(`mod-${i}`, title));

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('RailPanelSwitcher', () => {
    it('renders nothing for a single panel', () => {
        // The rail header already shows the only panel's title; a one-tab
        // tablist is chrome that names what is already named.
        const list = panels('Marks');
        const { container } = render(
            <RailPanelSwitcher panels={list} activePanelId={list[0].qualifiedId} onSelect={() => {}} />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('renders nothing when no panel is registered', () => {
        const { container } = render(
            <RailPanelSwitcher panels={[]} activePanelId={null} onSelect={() => {}} />,
        );
        expect(container.firstChild).toBeNull();
    });

    it('renders a tab strip up to the limit', () => {
        const list = panels('Marks', 'Probe', 'Template').slice(0, TAB_LIMIT);
        render(
            <RailPanelSwitcher panels={list} activePanelId={list[0].qualifiedId} onSelect={() => {}} />,
        );
        expect(screen.getAllByRole('tab')).toHaveLength(TAB_LIMIT);
        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('does not force equal tab widths — the flex-1 that truncated every title is gone', () => {
        // The direct regression assertion. `flex-1` on a tab is what made a
        // three-character title occupy exactly as much room as a twelve-character
        // one, and then truncated both.
        const list = panels('Marks', 'Probe', 'A Very Long Panel Title');
        render(
            <RailPanelSwitcher panels={list} activePanelId={list[0].qualifiedId} onSelect={() => {}} />,
        );
        for (const tab of screen.getAllByRole('tab')) {
            expect(tab.className).not.toMatch(/\bflex-1\b/);
            expect(tab.className).toMatch(/\bshrink-0\b/);
        }
    });

    it('marks the active tab selected and reports a click', () => {
        const onSelect = vi.fn();
        const list = panels('Marks', 'Probe');
        render(
            <RailPanelSwitcher panels={list} activePanelId={list[0].qualifiedId} onSelect={onSelect} />,
        );

        const [first, second] = screen.getAllByRole('tab');
        expect(first.getAttribute('aria-selected')).toBe('true');
        expect(second.getAttribute('aria-selected')).toBe('false');

        fireEvent.click(second);
        expect(onSelect).toHaveBeenCalledWith(list[1].qualifiedId);
    });

    it('switches to a dropdown past the limit, showing the active title in full', () => {
        const list = panels('Marks', 'Probe', 'Probe Two', 'Template');
        render(
            <RailPanelSwitcher panels={list} activePanelId={list[2].qualifiedId} onSelect={() => {}} />,
        );

        expect(screen.queryAllByRole('tab')).toHaveLength(0);
        // Not `PROBE-T…` — the whole title, and a position so the other three
        // announce themselves without needing room to be named.
        const trigger = screen.getByRole('button', { name: 'Mod panel: Probe Two' });
        expect(trigger.textContent).toContain('Probe Two');
        expect(trigger.textContent).toContain('3/4');
    });

    it('the dropdown lists every panel and reports a choice', () => {
        const onSelect = vi.fn();
        const list = panels('Marks', 'Probe', 'Probe Two', 'Template');
        render(
            <RailPanelSwitcher panels={list} activePanelId={list[0].qualifiedId} onSelect={onSelect} />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Mod panel: Marks' }));
        const options = screen.getAllByRole('option');
        expect(options).toHaveLength(4);
        expect(options.map((o) => o.textContent?.trim())).toEqual([
            'Marks',
            'Probe',
            'Probe Two',
            'Template',
        ]);

        fireEvent.click(options[3]);
        expect(onSelect).toHaveBeenCalledWith(list[3].qualifiedId);
        // Choosing closes it.
        expect(screen.queryByRole('listbox')).toBeNull();
    });

    it('falls back to the first panel when the stored active id is stale', () => {
        // `activePanelId` persists to localStorage; a mod uninstalled between
        // sessions leaves an id that matches nothing. The switcher must still
        // name something rather than render an empty trigger.
        const list = panels('Marks', 'Probe', 'Probe Two', 'Template');
        render(
            <RailPanelSwitcher panels={list} activePanelId="mod.deleted.panel" onSelect={() => {}} />,
        );
        expect(screen.getByRole('button', { name: 'Mod panel: Marks' })).toBeInTheDocument();
    });

    it('closes the dropdown on Escape and on an outside press', () => {
        const list = panels('Marks', 'Probe', 'Probe Two', 'Template');
        render(
            <RailPanelSwitcher panels={list} activePanelId={list[0].qualifiedId} onSelect={() => {}} />,
        );

        fireEvent.click(screen.getByRole('button', { name: 'Mod panel: Marks' }));
        expect(screen.getByRole('listbox')).toBeInTheDocument();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('listbox')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Mod panel: Marks' }));
        expect(screen.getByRole('listbox')).toBeInTheDocument();
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole('listbox')).toBeNull();
    });
});
