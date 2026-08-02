// escape-net.js — fetch/XHR/WebSocket to our own API AND to any host MUST fail.
//
// R3: `default-src 'none'` leaves the frame NO NETWORK of any kind —
// no fetch, no XHR, no WebSocket, no font, no image except `data:`. The
// frame can compute and draw. It cannot phone anywhere. This is the
// network barrier 3.4 proved for its own sandbox, one layer up.
//
// This fixture TRIES each network API and reports what it got back. The
// harness asserts each FAILED. If R3 were violated (a `connect-src`
// directive added, or the CSP meta removed), `fetch` would return a
// response and the suite would go red. The specific thing that must not
// happen: a network request to our own API succeeds.
//
// `fetch` is defined on window (the opaque origin has the standard
// globals), so the probe checks the RESULT, not the existence of the
// function. A fetch that throws (CSP-blocked) is a PASS; a fetch that
// resolves is a FAIL.
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

    // XHR: try to OPEN a connection (CSP blocks at the network layer, but
    // the open() call itself may throw or the send() may fail).
    try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', 'http://127.0.0.1:3001/api/mods', false);
        probe.xhrOpen = 'opened';
    } catch (err) {
        probe.xhrOpen = 'blocked';
        probe.xhrOpenError = String(err);
    }

    // WebSocket: try to construct one. CSP blocks ws:// connections.
    try {
        const ws = new WebSocket('ws://127.0.0.1:3001/');
        probe.webSocket = 'constructed';
        ws.close();
    } catch (err) {
        probe.webSocket = 'blocked';
        probe.webSocketError = String(err);
    }

    parent.postMessage(probe, '*');
}