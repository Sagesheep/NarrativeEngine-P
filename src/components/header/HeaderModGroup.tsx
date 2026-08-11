/**
 * The header's mod-entry group: a bounded number of mod buttons inline, the
 * rest behind one overflow control.
 *
 * THE PROBLEM THIS SOLVES. `header.actions` is an open region — any mod may
 * claim a button, and several claim more than one. The row that rendered them
 * was `overflow-x-auto no-scrollbar` with every child `shrink-0`, which means
 * entries past the right edge were reachable only by a horizontal scroll
 * gesture with no scrollbar to advertise it. With the repo's fixtures switched
 * on that row ran to eleven built-ins plus five mod buttons, and the ones that
 * fell off the end were, for practical purposes, gone. A button you cannot see
 * and cannot discover is not a mount point; it is a leak.
 *
 * THE RULE. Built-ins always render inline: they are a fixed, known set, they
 * are the app's own chrome, and MOUNTS.md §8.2's zero-mod pixel-identity rule
 * says their markup does not move. Mod entries get `INLINE_LIMIT` slots in the
 * row; everything beyond that collapses into a single overflow button whose
 * badge carries the hidden count. So the header's width is bounded by the
 * built-ins plus a constant, no matter how many mods are installed — which is
 * the property the old row lacked.
 *
 * WHY A FIXED LIMIT AND NOT MEASUREMENT. A ResizeObserver that measures the row
 * and packs it to the pixel is the fancier answer and the wrong one here: it
 * reflows on every `state()` change (labels and badges are dynamic), it needs a
 * hidden measurement pass that mod-supplied icons can invalidate, and it makes
 * "which buttons are visible" untestable without a layout engine. A constant is
 * deterministic, renders identically in jsdom and Chrome, and the failure mode
 * is a header that is slightly emptier than it could be rather than one that
 * silently swallows controls.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { RegisteredChromeEntry } from '../../services/mods/mounts/mountRegistry';
import {
    renderHeaderModEntry,
    renderHeaderModMenuItem,
} from '../../services/mods/mounts/chromeRenderers';

/**
 * How many mod buttons render inline before the rest collapse.
 *
 * Two, deliberately. The header already carries ten built-ins; a third and
 * fourth mod button is what pushes the row past a 1280px viewport, which is the
 * width this app is actually used at. A mod with one header button — the common
 * case, and the shape the docs recommend — is never collapsed.
 */
export const INLINE_LIMIT = 2;

type ModT = (key: string, vars?: Record<string, string | number>) => string;

/** Shared with the row renderer; a mod entry's `state()` is read once per paint. */
const NO_LAST_GOOD = { current: undefined };

export interface HeaderModGroupProps {
    /** The mod entries from `header.actions`, in the registry's resolved order. */
    entries: readonly RegisteredChromeEntry[];
    t: ModT;
}

/**
 * Renders the inline mod buttons followed by the overflow control. Returns
 * `null` when there are no mod entries at all, so a zero-mod header is exactly
 * the built-in row with nothing added — no divider, no empty menu, no stray
 * element in the DOM for the pixel-identity test to trip over.
 */
export function HeaderModGroup({ entries, t }: HeaderModGroupProps): ReactNode {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement | null>(null);

    // Close on outside click and on Escape. A dropdown in a fixed-height header
    // that survives a click elsewhere is the single most annoying failure mode
    // of a hand-rolled menu, so both are wired before anything else.
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

    // A mod uninstalled or disabled while its menu is open leaves the menu with
    // nothing in it. Close rather than render an empty popover.
    useEffect(() => {
        if (entries.length <= INLINE_LIMIT) setOpen(false);
    }, [entries.length]);

    if (entries.length === 0) return null;

    const inline = entries.slice(0, INLINE_LIMIT);
    const overflow = entries.slice(INLINE_LIMIT);

    return (
        <>
            {/* The seam between the app's chrome and the mods'. One hairline,
              * not a gap: it says "different origin" without spending width. */}
            <span aria-hidden className="self-stretch w-px bg-border/60 mx-0.5 shrink-0" />

            {inline.map((entry) => renderHeaderModEntry(entry, t, NO_LAST_GOOD))}

            {overflow.length > 0 && (
                <div ref={containerRef} className="relative shrink-0">
                    <button
                        type="button"
                        onClick={() => setOpen((value) => !value)}
                        aria-expanded={open}
                        aria-haspopup="menu"
                        title={t('header.mods.overflow.tooltip', { count: overflow.length })}
                        aria-label={t('header.mods.overflow.tooltip', { count: overflow.length })}
                        className={`chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono ${
                            open
                                ? 'border-terminal text-terminal bg-terminal/5'
                                : 'border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal'
                        }`}
                    >
                        <MoreHorizontal size={13} />
                        <span className="min-w-[14px] h-3.5 bg-terminal text-void text-[8px] font-bold rounded-full flex items-center justify-center px-0.5">
                            {overflow.length}
                        </span>
                    </button>

                    {open && (
                        <div
                            role="menu"
                            aria-label={t('header.mods.overflow.aria')}
                            className="absolute right-0 top-full mt-1 z-50 min-w-[220px] max-w-[320px] max-h-[60vh] overflow-y-auto bg-surface border border-border rounded-sm shadow-lg py-1"
                        >
                            <p className="chrome-label px-3 pb-1.5 mb-1 border-b border-border/60 text-[9px] uppercase tracking-wider text-text-dim">
                                {t('header.mods.overflow.heading')}
                            </p>
                            {overflow.map((entry) =>
                                renderHeaderModMenuItem(entry, t, NO_LAST_GOOD, () => setOpen(false)),
                            )}
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
