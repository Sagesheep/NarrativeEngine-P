/**
 * `HeaderScrollRow` — the scrolling middle of the header's action row.
 *
 * The bug it exists for: the row was `overflow-x-auto no-scrollbar shrink-0`,
 * and `shrink-0` meant it was sized to its content and therefore NEVER
 * scrolled — it overflowed the header instead. Measured in the running app at a
 * 1280px viewport: the row's right edge at 1876px, with Settings and Exit
 * rendered off-screen, unreachable, and unannounced.
 *
 * jsdom has no layout engine, so `scrollWidth`/`clientWidth` are stubbed. That
 * is honest for what is being tested here — the DECISION ("is there content past
 * this edge, and which edge") is arithmetic on those numbers, and it is the
 * arithmetic that was missing, not the layout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { HeaderScrollRow } from '../HeaderScrollRow';

/** Give the scroll container measurable dimensions jsdom will not compute. */
function stubMetrics(node: HTMLElement, metrics: { scrollWidth: number; clientWidth: number; scrollLeft: number }) {
    Object.defineProperty(node, 'scrollWidth', { value: metrics.scrollWidth, configurable: true });
    Object.defineProperty(node, 'clientWidth', { value: metrics.clientWidth, configurable: true });
    Object.defineProperty(node, 'scrollLeft', { value: metrics.scrollLeft, writable: true, configurable: true });
}

const scroller = (container: HTMLElement) =>
    container.querySelector('.overflow-x-auto') as HTMLElement;

/** `start` / `end`, in DOM order, for whichever fades are showing. */
const fades = (container: HTMLElement) =>
    [...container.querySelectorAll('span[aria-hidden]')].map((n) =>
        n.className.includes('left-0') ? 'start' : 'end',
    );

/** Re-run the component's measurement by firing the scroll it listens for. */
function rescroll(node: HTMLElement, scrollLeft: number) {
    act(() => {
        (node as unknown as { scrollLeft: number }).scrollLeft = scrollLeft;
        node.dispatchEvent(new Event('scroll'));
    });
}

afterEach(cleanup);

describe('HeaderScrollRow', () => {
    it('mounts where ResizeObserver does not exist', () => {
        // jsdom has none, and neither do some embedded webviews. An effect that
        // throws during mount takes the whole header down with it, so the
        // observer is optional and its absence only costs a fade that can go
        // briefly stale. This test IS that environment — no stub is installed.
        expect(typeof ResizeObserver).toBe('undefined');
        expect(() => render(<HeaderScrollRow><button>a</button></HeaderScrollRow>)).not.toThrow();
    });

    it('observes the row and its children when ResizeObserver is available', () => {
        const observed: unknown[] = [];
        let disconnected = false;
        class StubResizeObserver {
            observe(target: unknown) { observed.push(target); }
            unobserve() { /* not used */ }
            disconnect() { disconnected = true; }
        }
        vi.stubGlobal('ResizeObserver', StubResizeObserver);
        try {
            const { container, unmount } = render(
                <HeaderScrollRow>
                    <button>a</button>
                    <button>b</button>
                </HeaderScrollRow>,
            );
            // The row itself plus each child: a button appearing or disappearing
            // changes the row's content width without changing the row's own.
            expect(observed).toContain(scroller(container));
            expect(observed).toHaveLength(3);
            unmount();
            expect(disconnected).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('lets the row shrink instead of sizing it to its content', () => {
        // `min-w-0` and the ABSENCE of `shrink-0` are the whole fix. A
        // `shrink-0` scroll container cannot scroll, so its `overflow-x-auto`
        // is decorative and the content leaves the window instead.
        const { container } = render(<HeaderScrollRow><button>a</button></HeaderScrollRow>);
        const node = scroller(container);
        expect(node.className).toContain('min-w-0');
        expect(node.className).not.toMatch(/\bshrink-0\b/);
        expect(node.className).toContain('overflow-x-auto');
    });

    it('shows no fade when everything fits', () => {
        const { container } = render(<HeaderScrollRow><button>a</button></HeaderScrollRow>);
        const node = scroller(container);
        stubMetrics(node, { scrollWidth: 400, clientWidth: 400, scrollLeft: 0 });
        rescroll(node, 0);
        expect(fades(container)).toEqual([]);
    });

    it('shows only the end fade at the start of an overflowing row', () => {
        const { container } = render(<HeaderScrollRow><button>a</button></HeaderScrollRow>);
        const node = scroller(container);
        stubMetrics(node, { scrollWidth: 900, clientWidth: 400, scrollLeft: 0 });
        rescroll(node, 0);
        expect(fades(container)).toEqual(['end']);
    });

    it('shows only the start fade at the end of an overflowing row', () => {
        const { container } = render(<HeaderScrollRow><button>a</button></HeaderScrollRow>);
        const node = scroller(container);
        stubMetrics(node, { scrollWidth: 900, clientWidth: 400, scrollLeft: 500 });
        rescroll(node, 500);
        expect(fades(container)).toEqual(['start']);
    });

    it('shows both fades mid-scroll', () => {
        const { container } = render(<HeaderScrollRow><button>a</button></HeaderScrollRow>);
        const node = scroller(container);
        stubMetrics(node, { scrollWidth: 900, clientWidth: 400, scrollLeft: 250 });
        rescroll(node, 250);
        expect(fades(container)).toEqual(['start', 'end']);
    });

    it('ignores a sub-pixel overflow', () => {
        // An exactly-fitting row reports a scrollWidth a fraction over its
        // clientWidth. Without the 1px slack that draws a permanent fade over
        // a button that is entirely visible.
        const { container } = render(<HeaderScrollRow><button>a</button></HeaderScrollRow>);
        const node = scroller(container);
        stubMetrics(node, { scrollWidth: 400.6, clientWidth: 400, scrollLeft: 0 });
        rescroll(node, 0);
        expect(fades(container)).toEqual([]);
    });

    it('never lets a fade intercept a click meant for the button beneath it', () => {
        const { container } = render(<HeaderScrollRow><button>a</button></HeaderScrollRow>);
        const node = scroller(container);
        stubMetrics(node, { scrollWidth: 900, clientWidth: 400, scrollLeft: 250 });
        rescroll(node, 250);
        const overlays = [...container.querySelectorAll('span[aria-hidden]')];
        expect(overlays).toHaveLength(2);
        for (const overlay of overlays) {
            expect(overlay.className).toContain('pointer-events-none');
        }
    });

    it('renders its children', () => {
        const { container } = render(
            <HeaderScrollRow>
                <button>first</button>
                <button>second</button>
            </HeaderScrollRow>,
        );
        expect(scroller(container).textContent).toBe('firstsecond');
    });
});
