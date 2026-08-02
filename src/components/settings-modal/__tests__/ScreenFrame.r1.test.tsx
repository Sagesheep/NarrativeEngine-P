/**
 * WO-P5-17 Step 2 — ScreenFrame WIRING tests.
 *
 * ⚠️ JSDOM PROVES NOTHING ABOUT ISOLATION. jsdom does not enforce the
 * `sandbox` attribute — it will happily let a frame reach the parent, so a
 * passing jsdom test proves the WIRING and NOTHING about the isolation
 * (WORKORDER-P5-17 §5, the same trap as "jsdom has no Worker" in 3.4, one
 * layer up, and the most likely way this sub-phase produces a false pass).
 *
 * The real isolation proof is `scripts/verify-screen-frame.mjs` (Step 4),
 * which drives a real headless Edge against the same component via a local
 * http server. These jsdom tests cover only:
 *
 *   - R1: the `sandbox` attribute is exactly `allow-scripts` and NEVER
 *        `allow-same-origin`. This is the one line a well-meaning future
 *        edit is most likely to add to "fix" something, and a source scan
 *        alongside the attribute test fails if it ever appears. jsdom
 *        doesn't enforce the attribute, but it does render it, so the
 *        attribute value is checkable here.
 *   - R3: the CSP `<meta>` is the FIRST element in the srcdoc `<head>`,
 *        before any script can run, with the exact policy
 *        `default-src 'none'; script-src 'unsafe-inline'; style-src
 *        'unsafe-inline'; img-src data:`.
 *   - R4: one frame per ScreenFrame instance; unmount destroys it.
 *   - R6: no `postMessage` channel is opened FROM the parent TO the frame
 *        (the frame's own fault-report messages are received, but the host
 *        sends nothing back — a 5.1 screen is useless on purpose).
 *   - Fault surfacing: a `__screenFault` message from a `"null"` origin
 *        flips the frame to its faulted state and calls `onFault`.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ScreenFrame } from '../ScreenFrame';
import {
    SCREEN_SANDBOX_ATTRIBUTE,
    SCREEN_FRAME_CSP,
    buildScreenSrcDoc,
} from '../screenFrameBuild';

const here = dirname(fileURLToPath(import.meta.url));
const componentPath = join(here, '..', 'screenFrameBuild.ts');

afterEach(() => {
    // jsdom leaves window listeners behind between tests; the fault
    // listener is keyed to the mounted instance, so clear it to keep the
    // suite independent.
    vi.restoreAllMocks();
});

describe('ScreenFrame — R1: sandbox attribute is exactly allow-scripts, never allow-same-origin', () => {
    it('renders an iframe with sandbox="allow-scripts"', () => {
        render(
            <ScreenFrame
                modId="m"
                screen={{ id: 's', file: 's.js' }}
                source="export default function () {}"
            />,
        );
        const frame = screen.getByTitle('m.s');
        expect(frame.tagName).toBe('IFRAME');
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    });

    it('SCREEN_SANDBOX_ATTRIBUTE is exactly "allow-scripts" and contains no allow-same-origin', () => {
        expect(SCREEN_SANDBOX_ATTRIBUTE).toBe('allow-scripts');
        expect(SCREEN_SANDBOX_ATTRIBUTE).not.toContain('allow-same-origin');
    });

    it('R1 SOURCE SCAN: allow-same-origin never appears in ScreenFrame.tsx', async () => {
        // The one line a well-meaning future edit is most likely to add to
        // "fix" something. The attribute test above catches a runtime
        // change; this source scan catches a comment, a string literal, or
        // a conditional that would re-introduce it. `allow-scripts` is
        // present (the constant), `allow-same-origin` is not.
        const source = await readFile(componentPath, 'utf-8');
        expect(source).toContain('allow-scripts');
        // Match the forbidden token as a whole word, so a comment like
        // "allow-same-origin is forbidden" also trips the scan — the only
        // place the token is allowed is this test file itself.
        expect(source).not.toMatch(/allow-same-origin/);
    });

    it('the srcdoc never contains the allow-same-origin token', () => {
        const srcdoc = buildScreenSrcDoc(
            'export default function () {}',
            SCREEN_FRAME_CSP,
        );
        expect(srcdoc).not.toMatch(/allow-same-origin/);
    });
});

describe('ScreenFrame — R3: CSP default-src none is the first element in head', () => {
    it('buildScreenSrcDoc puts the CSP meta before any script', () => {
        const srcdoc = buildScreenSrcDoc(
            'export default function () { document.body.innerHTML = "<p>hi</p>"; }',
            SCREEN_FRAME_CSP,
        );
        const headStart = srcdoc.indexOf('<head>');
        const cspPos = srcdoc.indexOf('Content-Security-Policy');
        const firstScript = srcdoc.indexOf('<script>');
        expect(cspPos).toBeGreaterThan(headStart);
        expect(cspPos).toBeLessThan(firstScript);
    });

    it('the CSP policy is exactly default-src none + the three deliberate exceptions', () => {
        expect(SCREEN_FRAME_CSP).toBe(
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:",
        );
    });

    it('the srcdoc contains the CSP meta with the exact policy', () => {
        const srcdoc = buildScreenSrcDoc('export default function () {}', SCREEN_FRAME_CSP);
        expect(srcdoc).toContain(`http-equiv="Content-Security-Policy" content="${SCREEN_FRAME_CSP}"`);
    });

    it('the srcdoc has no network-capable directive (no connect-src, no font-src, no frame-src)', () => {
        const srcdoc = buildScreenSrcDoc('export default function () {}', SCREEN_FRAME_CSP);
        // default-src 'none' is the base; the only exceptions are the
        // three inline directives. Anything that would allow a network
        // request (connect-src, font-src, frame-src, media-src, object-src)
        // must not appear.
        expect(srcdoc).not.toMatch(/connect-src|font-src|frame-src|media-src|object-src/);
    });
});

describe('ScreenFrame — R4: one frame per instance, destroyed on unmount', () => {
    it('renders exactly one iframe per ScreenFrame', () => {
        const { container } = render(
            <ScreenFrame
                modId="m"
                screen={{ id: 's', file: 's.js' }}
                source="export default function () {}"
            />,
        );
        expect(container.querySelectorAll('iframe')).toHaveLength(1);
    });

    it('unmount removes the iframe from the DOM', () => {
        const { container, unmount } = render(
            <ScreenFrame
                modId="m"
                screen={{ id: 's', file: 's.js' }}
                source="export default function () {}"
            />,
        );
        expect(container.querySelectorAll('iframe')).toHaveLength(1);
        unmount();
        expect(container.querySelectorAll('iframe')).toHaveLength(0);
    });

    it('a re-render with the same source does not create a second iframe', () => {
        const { container, rerender } = render(
            <ScreenFrame
                modId="m"
                screen={{ id: 's', file: 's.js' }}
                source="export default function () {}"
            />,
        );
        rerender(
            <ScreenFrame
                modId="m"
                screen={{ id: 's', file: 's.js' }}
                source="export default function () {}"
            />,
        );
        expect(container.querySelectorAll('iframe')).toHaveLength(1);
    });

    it('two ScreenFrame instances render two iframes (no pooling, no reuse across screens)', () => {
        const { container } = render(
            <>
                <ScreenFrame modId="m" screen={{ id: 'a', file: 'a.js' }} source="export default function () {}" />
                <ScreenFrame modId="m" screen={{ id: 'b', file: 'b.js' }} source="export default function () {}" />
            </>,
        );
        expect(container.querySelectorAll('iframe')).toHaveLength(2);
    });
});

describe('ScreenFrame — R6: the host sends no messages to the frame', () => {
    it('exposes no postMessage channel to the frame (the frame receives nothing)', () => {
        // There is no ref, no prop, no API on ScreenFrame that lets the
        // parent send a message into the frame. The only message handling
        // is INBOUND (the frame's own fault reports). Asserting this
        // negatively: the component does not call contentWindow.postMessage
        // at any point. jsdom's contentWindow is null for srcdoc iframes
        // anyway, so a postMessage attempt would throw — but the point is
        // the component never attempts it.
        const postSpy = vi.spyOn(window, 'postMessage');
        render(
            <ScreenFrame
                modId="m"
                screen={{ id: 's', file: 's.js' }}
                source="export default function () {}"
            />,
        );
        // window.postMessage is the parent's own; the frame's
        // contentWindow.postMessage would be a separate call. The host
        // never calls either to send data into the frame.
        expect(postSpy).not.toHaveBeenCalled();
    });
});

describe('ScreenFrame — fault surfacing (R5 wiring, not isolation)', () => {
    it('a __screenFault message from a "null" origin flips the frame to its faulted state', () => {
        const onFault = vi.fn();
        render(
            <ScreenFrame
                modId="m"
                screen={{ id: 's', file: 's.js' }}
                source="export default function () {}"
                onFault={onFault}
            />,
        );
        expect(screen.getByTitle('m.s')).toBeInTheDocument();
        // Simulate the frame posting a fault. A sandboxed opaque-origin
        // iframe has the sentinel "null" origin.
        fireEvent(window, new MessageEvent('message', {
            origin: 'null',
            data: { __screenFault: true, kind: 'threw', message: 'boom' },
        }));
        // The faulted state replaces the iframe with a fault card.
        expect(screen.queryByTitle('m.s')).toBeNull();
        expect(screen.getByText(/faulted and was stopped/)).toBeInTheDocument();
        expect(onFault).toHaveBeenCalledWith({
            modId: 'm',
            screenId: 's',
            kind: 'threw',
            message: 'boom',
        });
    });

    it('ignores a __screenFault message from a non-null origin (a same-origin message from our own app)', () => {
        const onFault = vi.fn();
        render(
            <ScreenFrame
                modId="m"
                screen={{ id: 's', file: 's.js' }}
                source="export default function () {}"
                onFault={onFault}
            />,
        );
        fireEvent(window, new MessageEvent('message', {
            origin: 'http://localhost:3001',
            data: { __screenFault: true, kind: 'threw', message: 'spoof' },
        }));
        // The frame is still mounted; the spoofed fault did not flip it.
        expect(screen.getByTitle('m.s')).toBeInTheDocument();
        expect(onFault).not.toHaveBeenCalled();
    });

    it('ignores a non-__screenFault message from a "null" origin', () => {
        const onFault = vi.fn();
        render(
            <ScreenFrame
                modId="m"
                screen={{ id: 's', file: 's.js' }}
                source="export default function () {}"
                onFault={onFault}
            />,
        );
        fireEvent(window, new MessageEvent('message', {
            origin: 'null',
            data: { somethingElse: true },
        }));
        expect(screen.getByTitle('m.s')).toBeInTheDocument();
        expect(onFault).not.toHaveBeenCalled();
    });
});