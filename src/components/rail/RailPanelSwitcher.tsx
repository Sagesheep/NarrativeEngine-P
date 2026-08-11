/**
 * The `chat.rail` panel switcher: a tab strip while the titles still fit, a
 * dropdown once they cannot.
 *
 * THE PROBLEM. The strip this replaces was `flex overflow-x-auto no-scrollbar`
 * with every tab `min-w-0 flex-1`. `flex-1` is the damaging part: it forces
 * every tab to the SAME width regardless of its title, so four panels in a
 * 320px rail gave each about 76px and every label truncated together —
 * `MARKS · PROBE · PROBE-T… · TEMPLATE`. A tab you cannot read is a tab you
 * cannot choose, and `no-scrollbar` meant the row's overflow was not advertised
 * either.
 *
 * THE FIX, in two parts. Tabs now size to their content (`shrink-0`, no
 * `flex-1`), so a short title stays short and long titles are the only ones
 * that ever truncate. And past `TAB_LIMIT` panels the strip becomes a dropdown
 * that always shows the active panel's FULL title — because at that point no
 * horizontal arrangement fits inside a rail the user has deliberately made
 * narrow, and a picker that names one thing correctly beats a row that names
 * four things badly.
 *
 * WHY A COUNT AND NOT A MEASUREMENT. The rail is user-resizable between 240 and
 * 640px, so "does it fit" genuinely depends on runtime width — but measuring it
 * means a ResizeObserver feeding a layout decision that changes as the user
 * drags, which is both janky and untestable. A threshold is stable while
 * dragging, deterministic in jsdom, and wrong only in the mild direction: at
 * 640px four tabs would have fitted and you get a dropdown anyway.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { resolveMountIcon } from '../../services/mods/mounts/mountIcons';
import type { RegisteredRailPanel } from '../../services/mods/mounts/mountRegistry';

/**
 * How many panels still render as a tab strip.
 *
 * Three. At the rail's 240px floor, three tabs leave roughly 70px each — enough
 * for an icon and a short title, which is what panel titles mostly are. The
 * fourth is where the strip stops being readable at any width the rail actually
 * takes.
 */
export const TAB_LIMIT = 3;

export interface RailPanelSwitcherProps {
    panels: readonly RegisteredRailPanel[];
    activePanelId: string | null;
    onSelect: (qualifiedId: string) => void;
}

/**
 * The icon a panel declared, if any. Panels are not required to declare one, so
 * this renders nothing rather than a placeholder when the declaration is absent.
 *
 * A component rather than a `const Icon = resolve(...)` in the render body:
 * resolving to a capitalised local and rendering `<Icon />` creates a fresh
 * component identity on every paint, which remounts the icon and trips
 * `react-hooks/static-components`. Resolving INSIDE a stable component keeps one
 * identity for the whole switcher.
 */
function PanelIcon({ panel, className }: { panel: RegisteredRailPanel; className?: string }) {
    if (!panel.panel.icon) return null;
    const { icon: Icon } = resolveMountIcon(panel.panel.icon);
    return <Icon size={13} className={className} />;
}

export function RailPanelSwitcher({ panels, activePanelId, onSelect }: RailPanelSwitcherProps) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    // One panel needs no switcher — the rail header already carries its title.
    if (panels.length <= 1) return null;

    if (panels.length <= TAB_LIMIT) {
        return (
            <div
                role="tablist"
                aria-label="Mod panels"
                className="flex shrink-0 overflow-x-auto border-b border-border no-scrollbar"
            >
                {panels.map((panel) => {
                    const selected = panel.qualifiedId === activePanelId;
                    return (
                        <button
                            key={panel.qualifiedId}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            onClick={() => onSelect(panel.qualifiedId)}
                            title={panel.panel.title}
                            // `shrink-0` and no `flex-1`: a tab is as wide as its
                            // own title needs, so a short one does not pay for a
                            // long one. `max-w` keeps a single verbose title from
                            // pushing the others out of the rail entirely.
                            className={`chrome-label flex shrink-0 max-w-[60%] items-center gap-1.5 border-b-2 px-3 py-2 text-[9px] font-bold uppercase tracking-wider transition-colors ${
                                selected
                                    ? 'border-terminal text-terminal'
                                    : 'border-transparent text-text-dim hover:bg-void-lighter hover:text-text-primary'
                            }`}
                        >
                            <PanelIcon panel={panel} className="shrink-0" />
                            <span className="truncate">{panel.panel.title}</span>
                        </button>
                    );
                })}
            </div>
        );
    }

    const active = panels.find((panel) => panel.qualifiedId === activePanelId) ?? panels[0];

    return (
        <div ref={containerRef} className="relative shrink-0 border-b border-border">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                aria-haspopup="listbox"
                aria-label={`Mod panel: ${active.panel.title}`}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-void-lighter"
            >
                <PanelIcon panel={active} className="shrink-0 text-terminal" />
                <span className="chrome-label min-w-0 flex-1 truncate text-[9px] font-bold uppercase tracking-wider text-terminal">
                    {active.panel.title}
                </span>
                {/* The count is the discoverability fix: it says there are others
                  * without needing room to name them. */}
                <span className="shrink-0 font-mono text-[9px] text-text-dim">
                    {panels.indexOf(active) + 1}/{panels.length}
                </span>
                <ChevronDown
                    size={13}
                    className={`shrink-0 text-text-dim transition-transform ${open ? 'rotate-180' : ''}`}
                />
            </button>

            {open && (
                <div
                    role="listbox"
                    aria-label="Mod panels"
                    className="absolute inset-x-0 top-full z-50 max-h-[50vh] overflow-y-auto border-b border-x border-border bg-surface shadow-lg"
                >
                    {panels.map((panel) => {
                        const selected = panel.qualifiedId === active.qualifiedId;
                        return (
                            <button
                                key={panel.qualifiedId}
                                type="button"
                                role="option"
                                aria-selected={selected}
                                onClick={() => {
                                    onSelect(panel.qualifiedId);
                                    setOpen(false);
                                }}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                                    selected
                                        ? 'bg-terminal/5 text-terminal'
                                        : 'text-text-primary hover:bg-void-lighter'
                                }`}
                            >
                                <PanelIcon panel={panel} className="shrink-0" />
                                <span className="chrome-label min-w-0 flex-1 truncate text-[9px] font-bold uppercase tracking-wider">
                                    {panel.panel.title}
                                </span>
                                {selected ? <Check size={12} className="shrink-0" /> : null}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
