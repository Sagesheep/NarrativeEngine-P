import { useEffect, useState } from 'react';

/**
 * Viewport-proportional UI scale for full-bleed screens (Settings today).
 *
 * The problem this solves: settings chrome is written in fixed `px` Tailwind
 * classes (`text-[11px]`, `w-[320px]`, …). Those are stable under browser zoom
 * — zoom scales CSS pixels — but they are *not* stable across window sizes. On
 * a 2560px-wide window the whole screen renders at the same physical size it
 * had at 1280px, so it reads as a thin strip of tiny text in a large empty box;
 * at a zoomed-in viewport the six-tab bar and the 320px extensions sidebar
 * crowd each other instead.
 *
 * The fix is one number: a scale factor derived from the viewport, applied as
 * `zoom` on the screen root. `zoom` (unlike `transform: scale`) participates in
 * layout — children reflow at the new size and percentage lengths resolve
 * against the zoomed box — so the height/flex chain the screens depend on keeps
 * working. Chromium-only, which is exactly the target (Electron / Chrome).
 *
 * 1080p is the design baseline: a 1920px-wide viewport scores exactly 1.0. The
 * floor keeps a zoomed-in viewport from clipping the fixed-width chrome; the
 * ceiling keeps ultrawide monitors from rendering comically large controls.
 */
const BASELINE_WIDTH = 1920;
const MIN_SCALE = 0.85;
const MAX_SCALE = 1.4;

function measure(): number {
    if (typeof window === 'undefined') return 1;
    const raw = window.innerWidth / BASELINE_WIDTH;
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, raw));
    // Quantised to 2dp so a drag-resize doesn't re-render on every pixel.
    return Math.round(clamped * 100) / 100;
}

export function useUiScale(): number {
    const [scale, setScale] = useState(measure);

    useEffect(() => {
        const onResize = () => setScale(measure());
        // Browser zoom changes fire `resize` too — the CSS viewport width moves
        // even when the OS window does not — so one listener covers both.
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    return scale;
}
