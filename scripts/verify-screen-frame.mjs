// WO-P5-17 Step 4 — the screen-frame isolation proof, in a real browser.
//
// Modelled directly on scripts/verify-sandbox.mjs: a local http server
// plus headless Edge spawned with --headless=new, NO new dependency,
// EDGE_PATH overridable. jsdom does NOT enforce the sandbox attribute
// (WORKORDER-P5-17 §5) — it will happily let a frame reach the parent,
// so a passing jsdom test proves the WIRING and NOTHING about the
// isolation. This script is the real proof.
//
// Fixtures (each asserts the SPECIFIC thing that must not happen, so
// removing a barrier turns the suite red — per §5, a test asserting only
// "no exception was thrown" is the weak assertion 3.5 already had to fix
// once):
//
//   ok.js             renders; parent unaffected
//   escape-dom.js     cannot read or write parent DOM
//   escape-storage.js localStorage / cookies / IndexedDB unreachable
//   escape-net.js     fetch to our own API AND to any host fails
//   throws.js         frame reports a fault; app keeps running
//   hang.js           §2 — measure whether the parent stays responsive
//
// The hang.js finding is the most important result this sub-phase can
// produce. If the parent froze, that is a STOP CONDITION (§7) and the
// PM's call — do not invent a mitigation.
import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtureRoot = join(projectRoot, 'scripts', 'screen-frame-fixtures');
const fixtureNames = [
    'ok.js',
    'escape-dom.js',
    'escape-storage.js',
    'escape-net.js',
    'throws.js',
    'hang.js',
];

// R3: the exact CSP the ScreenFrame component injects. Duplicated here
// (not imported from the TS) because this script runs in Node ESM and the
// component is TypeScript — the work order says "no new dependency", and
// a build step to bridge them would be one. The R1 test in
// ScreenFrame.r1.test.tsx pins the constant in the component; a drift
// here would show up as a fixture failing in a way the component's tests
// didn't predict.
const SCREEN_FRAME_CSP =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

function listen(server) {
    return new Promise((resolvePromise, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolvePromise(server.address().port);
        });
    });
}

function waitForJson(url, predicate, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolvePromise, reject) => {
        const poll = async () => {
            if (Date.now() >= deadline) {
                reject(new Error(`Timed out waiting for ${url}`));
                return;
            }
            const controller = new AbortController();
            const abortTimer = setTimeout(() => controller.abort(), 1000);
            try {
                const response = await fetch(url, { signal: controller.signal });
                const value = await response.json();
                const match = predicate(value);
                if (match) {
                    resolvePromise(match);
                    return;
                }
            } catch {}
            finally {
                clearTimeout(abortTimer);
            }
            setTimeout(poll, 50);
        };
        poll();
    });
}

function connectCdp(webSocketUrl) {
    return new Promise((resolvePromise, rejectPromise) => {
        const socket = new WebSocket(webSocketUrl);
        const pending = new Map();
        let nextId = 1;
        let opened = false;

        const connection = {
            send(method, params = {}) {
                const id = nextId++;
                return new Promise((resolveMessage, rejectMessage) => {
                    pending.set(id, { resolveMessage, rejectMessage });
                    socket.send(JSON.stringify({ id, method, params }));
                });
            },
            close() {
                for (const { rejectMessage } of pending.values()) rejectMessage(new Error('CDP connection closed'));
                pending.clear();
                socket.close();
            },
        };

        socket.addEventListener('open', () => {
            opened = true;
            resolvePromise(connection);
        });
        socket.addEventListener('message', (event) => {
            const message = JSON.parse(String(event.data));
            if (message.id == null) return;
            const waiter = pending.get(message.id);
            if (!waiter) return;
            pending.delete(message.id);
            if (message.error) waiter.rejectMessage(new Error(JSON.stringify(message.error)));
            else waiter.resolveMessage(message.result);
        });
        socket.addEventListener('error', () => {
            if (!opened) rejectPromise(new Error('CDP WebSocket error'));
        });
    });
}

async function terminateProcessTree(child) {
    if (child.exitCode !== null) return;
    await new Promise((resolvePromise) => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        const timer = setTimeout(() => {
            killer.kill();
            resolvePromise();
        }, 5000);
        const finish = () => {
            clearTimeout(timer);
            resolvePromise();
        };
        killer.once('exit', finish);
        killer.once('error', finish);
    });
}

async function removeProfile(profilePath) {
    let lastError;
    for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
            await rm(profilePath, { recursive: true, force: true });
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
        }
    }
    console.error(`PROFILE_CLEANUP ${lastError?.message ?? String(lastError)}`);
}

// The host page. It receives the fixture sources via CDP, builds an
// iframe per fixture using the SAME srcdoc wrapper the ScreenFrame
// component uses, and collects the frames' postMessages. The parent
// stays responsive throughout — the hang.js measurement is a parent-side
// setTimeout that records how long it actually took to fire while the
// hang frame was running.
//
// The page is served with NO CSP of its own (the host page is trusted;
// the FRAME's CSP is the one under test, injected into the srcdoc).
//
// buildScreenSrcDoc uses string concatenation (NOT template literals) so
// its .toString() is safe to embed in the page's outer template literal
// — a template literal inside the function body would have its ${...}
// interpolated by the OUTER literal at Node time, breaking the page.
function buildScreenSrcDoc(source, csp) {
    var moduleBody = String(source).replace(/^\s*export\s+default\s+/, 'globalThis.__screenMod = ');
    return [
        '<!doctype html>',
        '<html>',
        '<head>',
        '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
        '<meta charset="utf-8">',
        '</head>',
        '<body>',
        '<script>',
        '(function () {',
        '  try {',
        '    ' + moduleBody,
        '    if (typeof globalThis.__screenMod === "function") {',
        '      var result = globalThis.__screenMod();',
        '      if (result && typeof result.then === "function") {',
        '        result.then(function () {}, function (err) {',
        '          parent.postMessage({ __screenFault: true, screenId: null, kind: "threw", message: String(err && err.message ? err.message : err) }, "*");',
        '        });',
        '      }',
        '    }',
        '  } catch (err) {',
        '    parent.postMessage({ __screenFault: true, screenId: null, kind: "threw", message: String(err && err.message ? err.message : err) }, "*");',
        '  }',
        '})();',
        '</script>',
        '</body>',
        '</html>',
    ].join('\n');
}

async function startBrowserHost() {
    const pageHtml = `<!doctype html><meta charset="utf-8"><script>
const __csp = ${JSON.stringify(SCREEN_FRAME_CSP)};
// The srcdoc builder, inlined here (not via .toString()) to avoid the
// HTML parser seeing a literal closing-script tag in a JS string. The
// closing tag is assembled from concatenation so no single string
// literal in the source contains it.
function __buildSrcDoc(source, csp) {
    var moduleBody = String(source).replace(/export\\s+default\\s+/, 'globalThis.__screenMod = ');
    var closeScript = '<' + '/script>';
    return [
        '<!doctype html>',
        '<html>',
        '<head>',
        '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
        '<meta charset="utf-8">',
        '</head>',
        '<body>',
        '<' + 'script>',
        '(function () {',
        '  try {',
        '    ' + moduleBody,
        '    if (typeof globalThis.__screenMod === "function") {',
        '      var result = globalThis.__screenMod();',
        '      if (result && typeof result.then === "function") {',
        '        result.then(function () {}, function (err) {',
        '          parent.postMessage({ __screenFault: true, screenId: null, kind: "threw", message: String(err && err.message ? err.message : err) }, "*");',
        '        });',
        '      }',
        '    }',
        '  } catch (err) {',
        '    parent.postMessage({ __screenFault: true, screenId: null, kind: "threw", message: String(err && err.message ? err.message : err) }, "*");',
        '  }',
        '})();',
        closeScript,
        '</body>',
        '</html>',
    ].join('\\n');
}

// Collect one result per fixture. Each entry resolves when the frame
// posts its __screenFixture (ok/escape-*) or __screenFault (throws)
// message, OR when a timeout elapses (hang.js never posts).
window.__screenResults = {};
window.__screenWaiting = new Map();

window.addEventListener('message', function (event) {
    // A sandboxed opaque-origin frame has the sentinel "null" origin.
    // We accept messages from "null" only — a same-origin message from
    // our own page would have a real origin and is ignored.
    if (event.origin !== 'null') return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    // The fault path: throws.js posts __screenFault: true. The wrapper
    // posts this ONLY on error (a throw or a rejected promise); a
    // successful run posts nothing — the fixture's own __screenFixture
    // message is the success signal.
    if (data.__screenFault === true) {
        const waiter = window.__screenWaiting.get('__fault');
        if (waiter) {
            window.__screenWaiting.delete('__fault');
            waiter({ kind: 'fault', data });
        }
        return;
    }

    // The fixture-report path: ok/escape-* post __screenFixture.
    if (typeof data.__screenFixture === 'string') {
        const waiter = window.__screenWaiting.get(data.__screenFixture);
        if (waiter) {
            window.__screenWaiting.delete(data.__screenFixture);
            waiter({ kind: 'fixture', data });
        }
    }
});

// Mount a frame for a fixture source and resolve when the frame posts
// back (or when the timeout elapses — hang.js never posts).
window.__runFrame = function (name, source, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            window.__screenWaiting.delete(name);
            window.__screenWaiting.delete('__fault');
            // R4: destroy the frame on unmount. Remove the element so
            // the frame's scripts are gone with it.
            if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
            resolve(result);
        };
        // Register the waiter for both the fixture-report and the fault
        // path (throws.js posts __screenFault, not __screenFixture).
        window.__screenWaiting.set(name, (result) => finish(result));
        window.__screenWaiting.set('__fault', (result) => finish(result));

        const srcdoc = __buildSrcDoc(source, __csp);
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('srcdoc', srcdoc);
        frame.setAttribute('data-fixture', name);
        frame.style.width = '100%';
        frame.style.minHeight = '40px';
        document.body.appendChild(frame);

        // Timeout: hang.js never posts back. The timeout is the
        // measurement window for the parent-responsiveness check.
        setTimeout(() => finish({ kind: 'timeout' }), Math.max(1, timeoutMs));
    });
};

// The harness entry point. Returns the collected results plus the
// parent-responsiveness measurement for hang.js.
window.__verifyScreenFrame = async ({ sources, timeoutMs }) => {
    const results = {};

    // Run the non-hang fixtures sequentially. Each gets its own frame
    // (R4 — no reuse), and we wait for its postMessage or a timeout.
    for (const name of ['ok.js', 'escape-dom.js', 'escape-storage.js', 'escape-net.js', 'throws.js']) {
        results[name] = await window.__runFrame(name, sources[name], timeoutMs);
    }

    // hang.js — §2. Measure whether the PARENT stays responsive while
    // the hang frame is spinning. We:
    //   1. Note the time.
    //   2. Mount the hang frame (it starts spinning immediately).
    //   3. Schedule a parent-side setTimeout(..., 200) and record how
    //      long it actually takes to fire.
    //   4. Also record the time the hang frame's run promise resolves
    //      (via the harness timeout).
    //
    // If the setTimeout fires near 200ms, the parent stayed responsive
    // (the frame got its own process — site isolation did its job). If
    // it fires MUCH later (or we hit the harness timeout first), the
    // parent FROZE.
    const hangStart = performance.now();
    let parentTimerFiredAt = null;
    const parentResponsiveProbe = new Promise((resolve) => {
        setTimeout(() => {
            parentTimerFiredAt = performance.now();
            resolve(parentTimerFiredAt - hangStart);
        }, 200);
    });

    const hangPromise = window.__runFrame('hang.js', sources['hang.js'], timeoutMs);
    // Race the responsiveness probe against the frame's timeout. We do
    // NOT await the probe alone — if the parent froze, the probe would
    // never resolve and we'd hang the harness. The frame's timeout
    // (resolved via finish()) is the backstop.
    const hangResult = await hangPromise;
    // After the frame is destroyed, give the responsiveness probe a
    // moment to resolve if it hasn't already.
    let parentResponsiveMs = null;
    if (parentTimerFiredAt !== null) {
        parentResponsiveMs = parentTimerFiredAt - hangStart;
    } else {
        // The probe hasn't fired yet. Wait a short grace period — if
        // the parent was responsive, it fires almost immediately after
        // the frame is removed. If it STILL doesn't fire, the parent
        // event loop was blocked.
        const grace = await Promise.race([
            parentResponsiveProbe.then((ms) => ms),
            new Promise((resolve) => setTimeout(() => resolve(null), 300)),
        ]);
        parentResponsiveMs = grace;
    }

    results['hang.js'] = {
        ...hangResult,
        parentResponsiveMs,
        parentStayedResponsive: parentResponsiveMs !== null && parentResponsiveMs < 1000,
    };

    return { results, csp: __csp };
};
</script>`;

    const pageServer = createServer((request, response) => {
        if (request.url !== '/') {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
        });
        response.end(pageHtml);
    });
    const pagePort = await listen(pageServer);
    const debugPortServer = createServer();
    const debugPort = await listen(debugPortServer);
    await new Promise((resolvePromise) => debugPortServer.close(resolvePromise));

    const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const profilePath = join(process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp', `screen-frame-verify-edge-${process.pid}`);
    const edge = spawn(edgePath, [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-extensions',
        '--no-first-run',
        '--disable-background-networking',
        '--remote-allow-origins=*',
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profilePath}`,
        `http://127.0.0.1:${pagePort}/`,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    try {
        const target = await waitForJson(
            `http://127.0.0.1:${debugPort}/json/list`,
            (value) => value.find((candidate) => candidate.type === 'page' && candidate.url === `http://127.0.0.1:${pagePort}/` && candidate.webSocketDebuggerUrl),
        );
        const cdp = await connectCdp(target.webSocketDebuggerUrl);
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        return {
            async run(sources, timeoutMs) {
                // Wait for the page script to define __verifyScreenFrame.
                // The page may still be loading when CDP connects; poll
                // until the function is available (or a timeout elapses).
                let ready = false;
                for (let attempt = 0; attempt < 100; attempt += 1) {
                    const probe = await cdp.send('Runtime.evaluate', { expression: "typeof window.__verifyScreenFrame", returnByValue: true });
                    if (probe?.result?.value === 'function') { ready = true; break; }
                    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
                }
                if (!ready) {
                    const parsed = await cdp.send('Runtime.evaluate', { expression: "({ html: document.documentElement.outerHTML.slice(0, 800), scriptCount: document.querySelectorAll('script').length })", returnByValue: true });
                    throw new Error(`screen-frame page did not define __verifyScreenFrame: ${JSON.stringify(parsed?.result?.value)}`);
                }
                const expression = `window.__verifyScreenFrame({ sources: ${JSON.stringify(sources)}, timeoutMs: ${timeoutMs} })`;
                const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
                if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
                return result.result.value;
            },
            async close() {
                cdp.close();
                try {
                    await terminateProcessTree(edge);
                } finally {
                    await removeProfile(profilePath);
                    await new Promise((resolvePromise) => pageServer.close(resolvePromise));
                }
            },
        };
    } catch (error) {
        try {
            await terminateProcessTree(edge);
        } finally {
            await removeProfile(profilePath);
            await new Promise((resolvePromise) => pageServer.close(resolvePromise));
        }
        throw error;
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function main() {
    const sources = Object.fromEntries(await Promise.all(fixtureNames.map(async (name) => [
        name,
        await readFile(join(fixtureRoot, name), 'utf8'),
    ])));

    // The per-fixture timeout. hang.js is the long one — we give it 3000ms
    // to let the parent-responsiveness probe fire (200ms) and then some.
    // The other fixtures should resolve in well under 1000ms.
    const timeoutMs = 3000;

    const browserHost = await startBrowserHost();
    let result;
    try {
        result = await browserHost.run(sources, timeoutMs);
    } finally {
        await browserHost.close();
    }

    const r = result.results;

    // ── ok.js — renders; parent unaffected ────────────────────────────
    const ok = r['ok.js'];
    assert(ok.kind === 'fixture', `ok.js did not report: ${JSON.stringify(ok)}`);
    assert(ok.data.bodyHasMarker === true, `ok.js did not render its marker: ${JSON.stringify(ok.data)}`);
    assert(ok.data.textContent === 'screen rendered', `ok.js marker text wrong: ${JSON.stringify(ok.data)}`);
    // R1: the frame's own origin is the opaque-origin sentinel. If this
    // is a real URL, allow-same-origin was added.
    assert(ok.data.selfOrigin === 'null', `ok.js self origin is not "null" (R1 violated): ${ok.data.selfOrigin}`);

    // ── escape-dom.js — cannot read or write parent DOM ───────────────
    const dom = r['escape-dom.js'];
    assert(dom.kind === 'fixture', `escape-dom.js did not report: ${JSON.stringify(dom)}`);
    assert(dom.data.reached === false, `escape-dom.js REACHED parent DOM (R1 violated): ${JSON.stringify(dom.data)}`);
    assert(dom.data.parentDocument === 'null' || dom.data.parentDocumentType === 'undefined' || dom.data.error !== null,
        `escape-dom.js parent.document was accessible: ${JSON.stringify(dom.data)}`);

    // ── escape-storage.js — localStorage / cookies / IndexedDB unreachable ──
    const store = r['escape-storage.js'];
    assert(store.kind === 'fixture', `escape-storage.js did not report: ${JSON.stringify(store)}`);
    assert(store.data.localStorage === 'blocked' || store.data.localStorage === 'null',
        `escape-storage.js localStorage was reached (R1 violated): ${store.data.localStorage}`);
    // Cookies on an opaque origin throw SecurityError (the document is
    // sandboxed and lacks the allow-same-origin flag). The fixture sets
    // cookieReadable to false when the access throws. If cookieReadable
    // is true AND the value is non-empty, the frame has same-origin
    // cookies (R1 violated).
    assert(store.data.cookieReadable === false || store.data.cookieValue === '' || store.data.cookieValue === null,
        `escape-storage.js cookie was readable and non-empty (R1 violated): ${JSON.stringify(store.data.cookieValue)}`);
    assert(store.data.indexedDB === 'blocked' || store.data.indexedDB === 'null',
        `escape-storage.js indexedDB was opened (R1 violated): ${store.data.indexedDB}`);
    assert(store.data.sessionStorage === 'blocked' || store.data.sessionStorage === 'null',
        `escape-storage.js sessionStorage was reached (R1 violated): ${store.data.sessionStorage}`);

    // ── escape-net.js — fetch to our own API AND to any host fails ────
    const net = r['escape-net.js'];
    assert(net.kind === 'fixture', `escape-net.js did not report: ${JSON.stringify(net)}`);
    // fetch is DEFINED on the opaque origin (it's a standard global).
    // The barrier is the CSP: the fetch must FAIL (throw or the promise
    // rejects). A fetch that RESOLVES means the network barrier is gone.
    assert(net.data.fetchOwnApi === 'blocked',
        `escape-net.js fetch to own API RESOLVED (R3 violated): ${net.data.fetchOwnApi}`);
    assert(net.data.fetchExternal === 'blocked',
        `escape-net.js fetch to external host RESOLVED (R3 violated): ${net.data.fetchExternal}`);

    // ── throws.js — frame reports a fault; app keeps running ──────────
    const throws = r['throws.js'];
    assert(throws.kind === 'fault', `throws.js did not report a fault: ${JSON.stringify(throws)}`);
    assert(throws.data.kind === 'threw', `throws.js fault kind wrong: ${JSON.stringify(throws.data)}`);
    assert(typeof throws.data.message === 'string' && throws.data.message.length > 0,
        `throws.js fault had no message: ${JSON.stringify(throws.data)}`);
    // The app kept running: we got here, and the next fixture (hang.js)
    // ran after throws.js. The sequential loop proves the parent survived.

    // ── hang.js — §2. The parent-responsiveness measurement. ──────────
    const hang = r['hang.js'];
    // hang.js never posts back — it should hit the timeout.
    assert(hang.kind === 'timeout', `hang.js did not spin as expected: ${JSON.stringify(hang)}`);

    console.log('SCREEN FRAME BROWSER VERIFICATION');
    console.log(`browser=${process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'}`);
    console.log(`csp=${result.csp}`);
    console.log(`timeoutMs=${timeoutMs}`);
    console.log(`fixtures=${JSON.stringify(Object.fromEntries(fixtureNames.map((name) => [name, r[name].kind])))}`);
    console.log(`ok=${JSON.stringify(r['ok.js'].data)}`);
    console.log(`escape-dom=${JSON.stringify(r['escape-dom.js'].data)}`);
    console.log(`escape-storage=${JSON.stringify(r['escape-storage.js'].data)}`);
    console.log(`escape-net=${JSON.stringify(r['escape-net.js'].data)}`);
    console.log(`throws=${JSON.stringify(r['throws.js'].data)}`);
    console.log(`hang=${JSON.stringify(r['hang.js'])}`);
    console.log(`HANG_FINDING: parentResponsiveMs=${hang.parentResponsiveMs}, parentStayedResponsive=${hang.parentStayedResponsive}`);

    // The hang.js finding is stated plainly here. If the parent froze,
    // this assert fails and the script exits non-zero — the executor
    // reports it as a STOP CONDITION, not a failure to fix.
    if (!hang.parentStayedResponsive) {
        console.log('HANG_STOP: the parent FROZE while hang.js ran. This is a STOP CONDITION (WO-P5-17 §7). Report it; do not invent a mitigation.');
        process.exitCode = 2;
    } else {
        console.log('PASS');
    }
}

main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
});