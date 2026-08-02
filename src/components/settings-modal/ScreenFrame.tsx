/**
 * WO-P5-17 Step 2 — the isolated frame host for a mod screen.
 *
 * A screen is a mod's OWN UI code, rendering where it cannot touch the app
 * (10_PANEL_LIMITS.md §10.2; WORKORDER-P5-17 §1). The frame is an
 * `<iframe srcdoc=…>` with `sandbox="allow-scripts"` (R1). The
 * same-origin capability is FORBIDDEN and test-enforced — the two
 * together void the sandbox entirely, because a frame with both can reach
 * its own `<iframe>` element in the parent and delete the `sandbox`
 * attribute. Omitting it puts the frame in a unique opaque origin: no
 * parent DOM, no cookies, no `localStorage`, no IndexedDB, no same-origin
 * fetch.
 *
 *   R3 — a `<meta http-equiv="Content-Security-Policy">` in the srcdoc
 *        document: `default-src 'none'; script-src 'unsafe-inline';
 *        style-src 'unsafe-inline'; img-src data:`. `script-src
 *        'unsafe-inline'` is deliberate — the mod's code is inlined into
 *        srcdoc so it must be permitted to run; what matters is
 *        `default-src 'none'` leaves it NO NETWORK of any kind (no fetch,
 *        no XHR, no WebSocket, no font, no image except `data:`). The frame
 *        can compute and draw. It cannot phone anywhere.
 *   R4 — one frame per screen, created on mount, destroyed on unmount. No
 *        pooling, no reuse. A destroyed frame's scripts are gone with it.
 *   R6 — no host API in 5.1. The frame receives nothing and sends nothing.
 *        There is no `postMessage` channel from the parent to the frame.
 *        The frame's own `postMessage` calls (fault reports) are received
 *        here only to surface a fault on the Extensions list (Step 3); they
 *        carry no data and grant no capability. The frame cannot reach the
 *        parent DOM (R1: opaque origin), cannot store anything (no
 *        same-origin capability), and cannot phone anywhere (R3:
 *        `default-src 'none'`).
 *
 * The mod source ships as TEXT (R2 — the server never evaluates it; it is
 * carried on `ValidatedMod.screenSources[]`). The host wraps it into a
 * complete HTML document with the CSP meta and a script that converts the
 * `export default` form into an assignment the srcdoc document can run,
 * then invokes the default export. The transform lives in
 * `screenFrameBuild.ts` (split out so this file exports only the
 * component).
 */
import { useEffect, useRef, useState } from 'react';
import type { ScreenFaultKind } from '../../services/mods/screenFaults';
import {
    SCREEN_SANDBOX_ATTRIBUTE,
    SCREEN_FRAME_CSP,
    buildScreenSrcDoc,
} from './screenFrameBuild';

export interface ScreenFrameProps {
    /** The mod id that declared the screen — for diagnostics and fault reporting. */
    modId: string;
    /** The screen declaration (id, file, label). */
    screen: { id: string; file: string; label?: string };
    /** The screen source text, as loaded by the server (R2 — never evaluated server-side). */
    source: string;
    /**
     * Optional. Called when the frame fails to load or throws at runtime
     * (R5 — Step 3 wires this to the Extensions fault list). The host
     * keeps running regardless; this is for surfacing, not recovery.
     */
    onFault?: (fault: { modId: string; screenId: string; kind: ScreenFaultKind; message: string }) => void;
}

/**
 * The isolated frame host. Mounts one `<iframe srcdoc=… sandbox="allow-scripts">`
 * per screen, destroys it on unmount (R4 — no pooling, no reuse).
 *
 * A 5.1 screen is USELESS ON PURPOSE (R6): it receives nothing and sends
 * nothing. There is no `postMessage` channel from the parent to the frame.
 * The frame's own `postMessage` calls (fault reports) are received here
 * only to surface a fault on the Extensions list (Step 3); they carry no
 * data and grant no capability.
 */
export function ScreenFrame({ modId, screen, source, onFault }: ScreenFrameProps) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const [faulted, setFaulted] = useState(false);
    // The latest onFault callback, synced in an effect (not during render,
    // per react-hooks/refs). The fault listener reads this so a re-render
    // with a new callback doesn't re-subscribe to `message`.
    const onFaultRef = useRef(onFault);
    useEffect(() => {
        onFaultRef.current = onFault;
    }, [onFault]);

    // R4: the srcdoc is built ONCE per mount from the source text. A
    // re-render with the same source produces the same srcdoc string; the
    // iframe is not recreated. On unmount, React removes the element and
    // the frame's scripts are gone with it. There is no pooling and no
    // reuse across screens — each ScreenFrame instance is one frame, one
    // lifecycle.
    const srcdoc = buildScreenSrcDoc(source, SCREEN_FRAME_CSP);

    // The fault listener receives the frame's own postMessage calls
    // (R5 — Step 3 surfaces these on the Extensions list). It checks the
    // `origin` of every message: an opaque-origin iframe has the sentinel
    // `"null"` origin, and we only act on messages carrying our
    // `__screenFault` marker. Any other message — including a
    // same-origin one from our own app — is ignored. This is NOT a host
    // API (R6): the channel carries fault signals only, no data, and the
    // frame cannot use it to request anything of the host.
    useEffect(() => {
        function handler(event: MessageEvent) {
            if (event.origin !== 'null') return;
            const data = event.data as { __screenFault?: boolean; kind?: ScreenFaultKind; message?: string } | null;
            if (!data || data.__screenFault !== true) return;
            setFaulted(true);
            onFaultRef.current?.({
                modId,
                screenId: screen.id,
                kind: data.kind ?? 'threw',
                message: data.message ?? 'screen threw without a message',
            });
        }
        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [modId, screen.id]);

    // R4: a load error is a fault the host keeps running through. The
    // frame's `onError` fires for resource failures (a srcdoc document
    // has none in 5.1, but a future screen that references a network
    // resource would trip it under R3's `default-src 'none'`).
    useEffect(() => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        function onError() {
            setFaulted(true);
            onFaultRef.current?.({
                modId,
                screenId: screen.id,
                kind: 'load',
                message: `screen "${screen.id}" failed to load`,
            });
        }
        iframe.addEventListener('error', onError);
        return () => iframe.removeEventListener('error', onError);
    }, [modId, screen.id]);

    if (faulted) {
        return (
            <div
                data-screen-frame={modId}
                data-screen-id={screen.id}
                data-screen-faulted="true"
                className="bg-void p-3 border border-danger/40 rounded"
            >
                <div className="text-[11px] font-mono font-bold text-text-primary break-all">
                    {modId} · {screen.id}
                </div>
                <p className="text-[9px] text-danger leading-tight mt-1">
                    This screen faulted and was stopped. The app is unaffected.
                </p>
            </div>
        );
    }

    return (
        <iframe
            ref={iframeRef}
            title={`${modId}.${screen.id}`}
            srcDoc={srcdoc}
            sandbox={SCREEN_SANDBOX_ATTRIBUTE}
            data-screen-frame={modId}
            data-screen-id={screen.id}
            className="w-full bg-void border border-border rounded"
            style={{ minHeight: '120px' }}
        />
    );
}