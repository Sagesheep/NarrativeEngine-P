// escape-net.js — fetch/XHR/WebSocket to our own API AND to any host MUST fail.
//
// R3: `default-src 'none'` leaves the frame NO NETWORK of any kind —
// no fetch, no XHR, no WebSocket, no font, no image except `data:`. The
// frame can compute and draw. It cannot phone anywhere. This is the
// network barrier 3.4 proved for its own sandbox, one layer up.
//
// WO-P5-18 §2.1: the previous version called `xhr.open()` and NEVER
// `send()` — `open()` issues no request — and constructed a WebSocket
// WITHOUT awaiting its `error` event, which is where a CSP block actually
// surfaces. Both reported "opened"/"constructed", which proved nothing.
// `default-src 'none'` probably covers `connect-src`, but "probably" is
// the exact thing this harness exists to eliminate.
//
// This version:
//   - calls `xhr.send()` and awaits the `load`/`error`/`abort`/`timeout`
//     event (or a synchronous throw from send), with a timeout backstop.
//     A send that fires `load` means the barrier is gone — the harness
//     asserts `xhrSend === 'blocked'`.
//   - awaits the WebSocket's `open`/`error`/`close` event, with a
//     timeout backstop. An `open` event means the barrier is gone — the
//     harness asserts `webSocket === 'blocked'` (never `'opened'`).
//
// The harness asserts all four channels failed: `fetchOwnApi`, `fetchExternal`,
// `xhrSend`, and `webSocket`. If a future CSP change allows `connect-src`,
// those assertions fail.
export default async function () {
    const probe = {
        __screenFixture: 'escape-net.js',
        fetchDefined: typeof fetch === 'function',
        fetchOwnApi: 'unknown',
        fetchOwnApiError: null,
        fetchExternal: 'unknown',
        fetchExternalError: null,
        xhrOpen: 'unknown',
        xhrOpenError: null,
        xhrSend: 'unknown',
        xhrSendError: null,
        webSocket: 'unknown',
        webSocketError: null,
    };

    if (typeof fetch === 'function') {
        // Try our own API — the path the app's frontend uses.
        try {
            const res = await fetch('http://127.0.0.1:3001/api/mods', { mode: 'no-cors' });
            probe.fetchOwnApi = 'resolved';
        } catch (err) {
            probe.fetchOwnApi = 'blocked';
            probe.fetchOwnApiError = String(err);
        }
        // Try an external host.
        try {
            const res = await fetch('https://example.com/', { mode: 'no-cors' });
            probe.fetchExternal = 'resolved';
        } catch (err) {
            probe.fetchExternal = 'blocked';
            probe.fetchExternalError = String(err);
        }
    } else {
        probe.fetchOwnApi = 'fetch-undefined';
        probe.fetchExternal = 'fetch-undefined';
    }

    // XHR: `open()` issues no request — it validates the URL only. The
    // request happens on `send()`. CSP blocks at the network layer, so
    // `send()` either throws synchronously (rare) or fires an `error`
    // event (the common case). We await either, with a timeout backstop.
    // A `load` event means the barrier is gone — the harness fails.
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', 'http://127.0.0.1:3001/api/mods', true);
        probe.xhrOpen = 'opened';
        probe.xhrSend = await new Promise((resolve) => {
            let settled = false;
            const finish = (v) => { if (settled) return; settled = true; resolve(v); };
            xhr.addEventListener('load', () => finish('loaded'));
            xhr.addEventListener('error', () => finish('blocked'));
            xhr.addEventListener('abort', () => finish('blocked'));
            xhr.addEventListener('timeout', () => finish('blocked'));
            try {
                xhr.send();
            } catch (err) {
                // A synchronous throw from send() is a CSP block too.
                probe.xhrSendError = String(err);
                finish('blocked');
            }
            // Timeout backstop — if neither load nor error fires (e.g. the
            // browser silently dropped the request), treat as blocked.
            setTimeout(() => finish('blocked'), 1500);
        });
    } catch (err) {
        probe.xhrOpen = 'blocked';
        probe.xhrOpenError = String(err);
        probe.xhrSend = 'blocked';
        probe.xhrSendError = String(err);
    }

    // WebSocket: construct one and await the `open`/`error`/`close` event.
    // CSP blocks `ws://` at the network layer, surfacing as an `error`
    // event (and then `close`). If `open` fires, the barrier is gone. We
    // resolve the probe when EITHER fires, with a timeout backstop.
    try {
        const ws = new WebSocket('ws://127.0.0.1:3001/');
        probe.webSocket = await new Promise((resolve) => {
            let settled = false;
            const finish = (v) => { if (settled) return; settled = true; resolve(v); };
            ws.addEventListener('open', () => finish('opened'));
            ws.addEventListener('error', () => finish('blocked'));
            ws.addEventListener('close', () => finish('blocked'));
            // Timeout backstop — if no event fires in 1500ms, treat as
            // blocked (the connection was never established).
            setTimeout(() => finish('blocked'), 1500);
        });
        try { ws.close(); } catch {}
    } catch (err) {
        probe.webSocket = 'blocked';
        probe.webSocketError = String(err);
    }

    parent.postMessage(probe, '*');
}