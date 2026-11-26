/**
 * The scrolling middle of the header's action row, with edge fades that appear
 * only when there is actually something past the edge.
 *
 * WHY THIS EXISTS. The header's action row carries ten built-ins, the background
 * control, and however many mod buttons `HeaderModGroup` lets through. At a
 * 1280px viewport that is already more than fits, and the row's original
 * `overflow-x-auto no-scrollbar shrink-0` handled it in the worst possible way:
 * `shrink-0` meant the row was sized to its content and never scrolled at all,
 * so it overflowed the header instead — right edge at 1876px in a 1280px window,
 * with Settings and Exit rendered off-screen and no scrollbar, no scroll, and no
 * indication anything was missing.
 *
 * Letting the row shrink makes the overflow rule real, but `no-scrollbar` then
 * hides the only evidence that scrolling is possible. Hence the fades: a
 * gradient at whichever edge has content beyond it. They are the scrollbar's
 * job, done in a way that matches the app's chrome.
 *
 * The trailing group (settings, exit) does NOT live in here — `Header.tsx` pins
 * it outside the scroll container so leaving the campaign is always one click
 * away, however narrow the window gets.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface EdgeState {
    readonly start: boolean;
    readonly end: boolean;
}

const NO_EDGES: EdgeState = { start: false, end: false };

export function HeaderScrollRow({ children }: { children: ReactNode }) {
    const ref = useRef<HTMLDivElement | null>(null);
    const [edges, setEdges] = useState<EdgeState>(NO_EDGES);

    const measure = useCallback(() => {
        const node = ref.current;
        if (!node) return;
        // 1px of slack: sub-pixel layout makes an exactly-fitting row report a
        // scrollWidth a fraction larger than its clientWidth, which would show a
        // fade over content that is entirely visible.
        const maxScroll = node.scrollWidth - node.clientWidth;
        const next: EdgeState = {
            start: node.scrollLeft > 1,
            end: maxScroll > 1 && node.scrollLeft < maxScroll - 1,
        };
        setEdges((current) =>
            current.start === next.start && current.end === next.end ? current : next,
        );
    }, []);

    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        measure();
        node.addEventListener('scroll', measure, { passive: true });

        // The row's content changes when a mod registers or disables a button,
        // and its width changes when the window resizes or the drawer opens. A
        // ResizeObserver on the row catches both without a render loop.
        //
        // Guarded because it is the one API here that is not universally
        // present — jsdom has no implementation, and neither do some embedded
        // webviews. Without the guard its absence throws during mount, and an
        // effect that throws takes the whole header down. Degrading to
        // "measured on scroll and on re-render only" costs a fade that can go
        // briefly stale; throwing costs the user their entire toolbar.
        const observer =
            typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
        if (observer) {
            observer.observe(node);
            for (const child of Array.from(node.children)) observer.observe(child);
        }
        return () => {
            node.removeEventListener('scroll', measure);
            observer?.disconnect();
        };
    }, [measure, children]);

    return (
        <div className="relative flex min-w-0 items-center">
            <div
                ref={ref}
                className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1 min-w-0"
            >
                {children}
            </div>
            {/* `pointer-events-none` so the fades never eat a click on the button
              * underneath them — the whole point is that those buttons stay
              * reachable. */}
            {edges.start && (
                <span
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-surface to-transparent"
                />
            )}
            {edges.end && (
                <span
                    aria-hidden
                    className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-surface to-transparent"
                />
            )}
        </div>
    );
}
