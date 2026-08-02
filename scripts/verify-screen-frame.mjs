// WO-P5-17 / WO-P5-18 — real-browser proof for screen isolation and host API.
//
// This intentionally uses only a local HTTP server, CDP, and the installed
// headless Edge. jsdom is used for wiring tests, not for this isolation proof.
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
    'comment-export.js',
    'api-table.js',
    'api-foreign-table.js',
    'api-theme.js',
    'api-resize.js',
    'api-unknown.js',
    'api-forgery.js',
    'api-flood.js',
    'hang.js',
];

const SCREEN_FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";
const SCREEN_THEME = {
    version: 1,
    colors: {
        background: '#10131a',
        surface: '#181d27',
        border: '#3b4658',
        text: '#e7ebf2',
        muted: '#9aa6b8',
        accent: '#a78bfa',
        danger: '#f87171',
    },
    fontSizes: { small: '11px', body: '13px', heading: '16px' },
    radii: { small: '4px', medium: '8px' },
};
const MAX_INBOUND_MESSAGES = 1000;
const MIN_SCREEN_HEIGHT_PX = 120;
const MAX_SCREEN_HEIGHT_PX = 1200;

function listen(server) {
    return new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', rejectPromise);
            resolvePromise(server.address().port);
        });
    });
}

function waitForJson(url, predicate, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolvePromise, rejectPromise) => {
        const poll = async () => {
            if (Date.now() >= deadline) {
                rejectPromise(new Error(`Timed out waiting for ${url}`));
                return;
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 1000);
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
                clearTimeout(timer);
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

async function startBrowserHost() {
    const pageHtml = `<!doctype html><meta charset="utf-8"><script>
const __csp = ${JSON.stringify(SCREEN_FRAME_CSP)};
const __theme = ${JSON.stringify(SCREEN_THEME)};
const __maxInbound = ${MAX_INBOUND_MESSAGES};
const __minHeight = ${MIN_SCREEN_HEIGHT_PX};
const __maxHeight = ${MAX_SCREEN_HEIGHT_PX};

function __rewriteExportDefault(source) {
    const target = 'export default';
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        const next = source[i + 1];
        if (ch === '/' && next === '/') {
            const nl = source.indexOf(String.fromCharCode(10), i + 2);
            if (nl === -1) return source;
            i = nl + 1;
            continue;
        }
        if (ch === '/' && next === '*') {
            const close = source.indexOf('*/', i + 2);
            if (close === -1) return source;
            i = close + 2;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === String.fromCharCode(96)) {
            const quote = ch;
            i += 1;
            while (i < source.length) {
                const c = source[i];
                if (c === '\\\\') { i += 2; continue; }
                if (c === quote) { i += 1; break; }
                i += 1;
            }
            continue;
        }
        if (source.startsWith(target, i)) {
            const after = source[i + target.length];
            if (after === ' ' || after === '\\t' || after === '\\n' || after === '\\r') {
                return source.slice(0, i) + 'globalThis.__screenMod = ' + source.slice(i + target.length + 1);
            }
        }
        i += 1;
    }
    return source;
}

function __buildSrcDoc(source, csp) {
    const moduleBody = __rewriteExportDefault(String(source));
    const closeScript = '<' + '/script>';
    return [
        '<!doctype html>', '<html>', '<head>',
        '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
        '<meta charset="utf-8">', '</head>', '<body>',
        '<script>', '(function () {',
        '  var __nonce = null;',
        '  var __theme = null;',
        '  var __pending = new Map();',
        '  var __nextId = 1;',
        '  globalThis.__screenInitReceived = false;',
        '  globalThis.__screenNonce = null;',
        '  window.addEventListener("message", function (event) {',
        '    if (event.source !== parent) return;',
        '    var data = event.data;',
        '    if (!data || typeof data !== "object") return;',
        '    if (data.__screenInit === true) {',
        '      if (globalThis.__screenInitReceived || typeof data.nonce !== "string" || !data.nonce) return;',
        '      globalThis.__screenInitReceived = true;',
        '      __nonce = data.nonce;',
        '      globalThis.__screenNonce = data.nonce;',
        '      __theme = data.theme;',
        '      globalThis.__screenTheme = data.theme;',
        '      if (typeof globalThis.__screenStart === "function") globalThis.__screenStart();',
        '      return;',
        '    }',
        '    if (data.__screenResponse !== true || data.nonce !== __nonce) return;',
        '    if (!__pending.has(data.id)) return;',
        '    var waiter = __pending.get(data.id);',
        '    __pending.delete(data.id);',
        '    if (data.ok) waiter.resolve(data.result);',
        '    else waiter.reject(new Error(data.error || "screen API request denied"));',
        '  });',
        '  globalThis.__screenApi = {',
        '    request: function (request) {',
        '      return new Promise(function (resolve, reject) {',
        '        var requestObject = typeof request === "string" ? { capability: request } : request;',
        '        if (!__nonce) { reject(new Error("screen API not initialised")); return; }',
        '        if (!requestObject || typeof requestObject !== "object" || typeof requestObject.capability !== "string") { reject(new Error("malformed screen API request")); return; }',
        '        var id = __nextId++;',
        '        __pending.set(id, { resolve: resolve, reject: reject });',
        '        parent.postMessage(Object.assign({}, requestObject, { __screenRequest: true, id: id, nonce: __nonce }), "*");',
        '      });',
        '    },',
        '    get theme() { return __theme; }',
        '  };',
        '})();', closeScript,
        '<script>', '(function () {',
        '  globalThis.__screenStart = function () {',
        '    if (globalThis.__screenStarted) return;',
        '    globalThis.__screenStarted = true;',
        '    try {',
        '      ' + moduleBody,
        '      if (typeof globalThis.__screenMod !== "function") throw new Error("screen has no default export");',
        '      var result = globalThis.__screenMod();',
        '      if (result && typeof result.then === "function") result.catch(function (err) {',
        '        parent.postMessage({ __screenFault: true, nonce: globalThis.__screenNonce, kind: "threw", message: String(err && err.message ? err.message : err) }, "*");',
        '      });',
        '    } catch (err) {',
        '      parent.postMessage({ __screenFault: true, nonce: globalThis.__screenNonce, kind: "threw", message: String(err && err.message ? err.message : err) }, "*");',
        '    }',
        '  };',
        '  if (globalThis.__screenInitReceived) globalThis.__screenStart();',
        '})();', closeScript,
        '</body>', '</html>',
    ].join('\\n');
}

window.__runFrame = function (name, source, timeoutMs, options) {
    options = options || {};
    return new Promise(function (resolvePromise) {
        let settled = false;
        let frame = null;
        let attacker = null;
        let target = null;
        let attackerTarget = null;
        let timer = null;
        let inbound = 0;
        const nonce = 'target-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
        const state = {
            table: [{ id: 'seed', label: 'original' }],
            height: __minHeight,
            fault: null,
            forgeryRejected: false,
            tornDown: false,
        };

        const removeFrames = function () {
            if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
            if (attacker && attacker.parentNode) attacker.parentNode.removeChild(attacker);
        };
        const finish = function (result) {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            window.removeEventListener('message', handleMessage);
            if (name === 'api-forgery.js' && result.kind === 'fixture') {
                result.data = Object.assign({}, result.data, { forgeryRejected: state.forgeryRejected });
            }
            if (name === 'api-resize.js' && result.kind === 'fixture') {
                result.data = Object.assign({}, result.data, { hostHeight: state.height });
            }
            if (name === 'api-flood.js' && result.kind === 'host-fault') {
                result.data = Object.assign({}, result.data, { inboundCount: inbound, tornDown: state.tornDown });
            }
            removeFrames();
            resolvePromise(result);
        };
        const hostFault = function (kind, message, tearDown) {
            state.fault = { kind: kind, message: message };
            state.tornDown = Boolean(tearDown);
            finish({ kind: 'host-fault', data: state.fault });
        };
        const respond = function (request, ok, result, error) {
            try {
                target.postMessage({ __screenResponse: true, id: request.id, nonce: nonce, ok: ok, result: result, error: error }, '*');
            } catch {}
        };
        const handleRequest = function (data) {
            inbound += 1;
            if (inbound > __maxInbound) {
                hostFault('flood', 'inbound message cap ' + __maxInbound + ' exceeded', true);
                return;
            }
            if (!data || data.__screenRequest !== true || typeof data.id !== 'number' || typeof data.capability !== 'string') {
                hostFault('malformed', 'request envelope is malformed', false);
                return;
            }
            if (data.nonce !== nonce) {
                respond(data, false, undefined, 'denied: invalid screen nonce');
                hostFault('denied', 'invalid screen nonce', false);
                return;
            }
            if (data.capability === 'table.read') {
                if (data.table !== 'tree') {
                    respond(data, false, undefined, 'denied: table is not declared by this mod');
                    hostFault('denied', 'table is not declared by this mod', false);
                    return;
                }
                respond(data, true, state.table);
                return;
            }
            if (data.capability === 'table.write') {
                if (data.table !== 'tree') {
                    respond(data, false, undefined, 'denied: table is not declared by this mod');
                    hostFault('denied', 'table is not declared by this mod', false);
                    return;
                }
                if (!Array.isArray(data.value)) {
                    respond(data, false, undefined, 'malformed: table expects an array');
                    hostFault('malformed', 'table expects an array', false);
                    return;
                }
                state.table = data.value;
                respond(data, true, { written: true });
                return;
            }
            if (data.capability === 'theme') {
                respond(data, true, __theme);
                return;
            }
            if (data.capability === 'resize') {
                if (typeof data.height !== 'number' || !Number.isFinite(data.height)) {
                    respond(data, false, undefined, 'malformed: resize requires a finite height');
                    hostFault('malformed', 'resize requires a finite height', false);
                    return;
                }
                state.height = Math.min(__maxHeight, Math.max(__minHeight, Math.round(data.height)));
                frame.style.height = state.height + 'px';
                respond(data, true, { height: state.height });
                return;
            }
            respond(data, false, undefined, 'denied: unknown capability "' + data.capability + '"');
            hostFault('denied', 'unknown capability "' + data.capability + '"', false);
        };
        function handleMessage(event) {
            const data = event.data;
            if (attackerTarget && event.source === attackerTarget && data && data.__screenRequest === true) {
                state.forgeryRejected = true;
                return;
            }
            if (event.source !== target) return;
            if (data && data.__screenFixture === name) {
                finish({ kind: 'fixture', data: data });
                return;
            }
            if (data && data.__screenFault === true) {
                finish({ kind: 'fault', data: data });
                return;
            }
            if (options.api && data && data.__screenRequest === true) handleRequest(data);
        }
        window.addEventListener('message', handleMessage);

        frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('srcdoc', __buildSrcDoc(source, __csp));
        frame.setAttribute('data-fixture', name);
        frame.style.width = '100%';
        frame.style.height = __minHeight + 'px';
        frame.onload = function () {
            target = frame.contentWindow;
            target.postMessage({ __screenInit: true, nonce: nonce, theme: __theme }, '*');
            if (name !== 'api-forgery.js') return;
            attacker = document.createElement('iframe');
            attacker.setAttribute('sandbox', 'allow-scripts');
            const forged = {
                __screenRequest: true,
                id: 9001,
                nonce: nonce,
                capability: 'table.write',
                table: 'tree',
                value: [{ id: 'forged', label: 'forged write' }],
            };
            const attackerSource = 'export default function () { parent.postMessage(' + JSON.stringify(forged) + ', "*"); }';
            attacker.setAttribute('srcdoc', __buildSrcDoc(attackerSource, __csp));
            attacker.onload = function () {
                attackerTarget = attacker.contentWindow;
                attackerTarget.postMessage({ __screenInit: true, nonce: 'attacker-' + nonce, theme: __theme }, '*');
            };
            document.body.appendChild(attacker);
        };
        document.body.appendChild(frame);
        timer = setTimeout(function () { finish({ kind: 'timeout' }); }, Math.max(1, timeoutMs));
    });
};

window.__verifyScreenFrame = async function ({ sources, timeoutMs }) {
    const results = {};
    for (const name of ['ok.js', 'escape-dom.js', 'escape-storage.js', 'escape-net.js', 'throws.js', 'comment-export.js']) {
        results[name] = await window.__runFrame(name, sources[name], timeoutMs, { api: false });
    }
    for (const name of ['api-table.js', 'api-foreign-table.js', 'api-theme.js', 'api-resize.js', 'api-unknown.js', 'api-forgery.js', 'api-flood.js']) {
        results[name] = await window.__runFrame(name, sources[name], timeoutMs, { api: true });
    }

    const hangStart = performance.now();
    let parentTimerFiredAt = null;
    const parentResponsiveProbe = new Promise((resolvePromise) => {
        setTimeout(() => {
            parentTimerFiredAt = performance.now();
            resolvePromise(parentTimerFiredAt - hangStart);
        }, 200);
    });
    const hangResult = await window.__runFrame('hang.js', sources['hang.js'], timeoutMs, { api: false });
    let parentResponsiveMs = parentTimerFiredAt === null
        ? await Promise.race([parentResponsiveProbe, new Promise((resolvePromise) => setTimeout(() => resolvePromise(null), 300))])
        : parentTimerFiredAt - hangStart;
    results['hang.js'] = Object.assign({}, hangResult, {
        parentResponsiveMs: parentResponsiveMs,
        parentStayedResponsive: parentResponsiveMs !== null && parentResponsiveMs < 1000,
    });
    return { results: results, csp: __csp };
};
</script>`;

    const pageServer = createServer((request, response) => {
        if (request.url !== '/') {
            response.writeHead(404).end();
            return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(pageHtml);
    });
    const pagePort = await listen(pageServer);
    const debugPortServer = createServer();
    const debugPort = await listen(debugPortServer);
    await new Promise((resolvePromise) => debugPortServer.close(resolvePromise));
    const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const profilePath = join(process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp', `screen-frame-verify-edge-${process.pid}`);
    const edge = spawn(edgePath, [
        '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox',
        '--disable-extensions', '--no-first-run', '--disable-background-networking',
        '--remote-allow-origins=*', `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${profilePath}`, `http://127.0.0.1:${pagePort}/`,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    try {
        const target = await waitForJson(
            `http://127.0.0.1:${debugPort}/json/list`,
            (value) => value.find((candidate) => candidate.type === 'page' && candidate.url === `http://127.0.0.1:${pagePort}/` && candidate.webSocketDebuggerUrl),
        );
        const cdp = await connectCdp(target.webSocketDebuggerUrl);
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        const browserVersion = await cdp.send('Browser.getVersion');
        return {
            async run(sources, timeoutMs) {
                let ready = false;
                for (let attempt = 0; attempt < 100; attempt += 1) {
                    const probe = await cdp.send('Runtime.evaluate', { expression: 'typeof window.__verifyScreenFrame', returnByValue: true });
                    if (probe?.result?.value === 'function') { ready = true; break; }
                    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
                }
                if (!ready) throw new Error('screen-frame page did not define __verifyScreenFrame');
                const expression = `window.__verifyScreenFrame({ sources: ${JSON.stringify(sources)}, timeoutMs: ${timeoutMs} })`;
                const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
                if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
                return { value: result.result.value, browserVersion };
            },
            async close() {
                cdp.close();
                try { await terminateProcessTree(edge); }
                finally {
                    await removeProfile(profilePath);
                    await new Promise((resolvePromise) => pageServer.close(resolvePromise));
                }
            },
        };
    } catch (error) {
        try { await terminateProcessTree(edge); }
        finally {
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
    const timeoutMs = 4000;
    const browserHost = await startBrowserHost();
    let runResult;
    try {
        runResult = await browserHost.run(sources, timeoutMs);
    } finally {
        await browserHost.close();
    }
    const result = runResult.value;
    const r = result.results;

    const ok = r['ok.js'];
    assert(ok.kind === 'fixture' && ok.data.bodyHasMarker === true && ok.data.textContent === 'screen rendered', `ok.js failed: ${JSON.stringify(ok)}`);
    assert(ok.data.selfOrigin === 'null', `ok.js origin was not opaque: ${JSON.stringify(ok.data)}`);

    const dom = r['escape-dom.js'];
    assert(dom.kind === 'fixture' && dom.data.reached === false, `escape-dom.js failed: ${JSON.stringify(dom)}`);

    const store = r['escape-storage.js'];
    assert(store.kind === 'fixture', `escape-storage.js did not report: ${JSON.stringify(store)}`);
    assert(store.data.localStorage === 'blocked' || store.data.localStorage === 'null', `localStorage escaped: ${JSON.stringify(store.data)}`);
    assert(store.data.cookieReadable === false || store.data.cookieValue === '' || store.data.cookieValue === null, `cookies escaped: ${JSON.stringify(store.data)}`);
    assert(store.data.indexedDB === 'blocked' || store.data.indexedDB === 'null', `indexedDB escaped: ${JSON.stringify(store.data)}`);
    assert(store.data.sessionStorage === 'blocked' || store.data.sessionStorage === 'null', `sessionStorage escaped: ${JSON.stringify(store.data)}`);

    const net = r['escape-net.js'];
    assert(net.kind === 'fixture', `escape-net.js did not report: ${JSON.stringify(net)}`);
    assert(net.data.fetchOwnApi === 'blocked' && net.data.fetchExternal === 'blocked' && net.data.xhrSend === 'blocked' && net.data.webSocket === 'blocked', `network barrier failed: ${JSON.stringify(net.data)}`);

    const throws = r['throws.js'];
    assert(throws.kind === 'fault' && throws.data.kind === 'threw' && typeof throws.data.message === 'string', `throws.js failed: ${JSON.stringify(throws)}`);

    const commentExport = r['comment-export.js'];
    assert(commentExport.kind === 'fixture' && commentExport.data.ranDefaultExport === true, `comment-export.js failed: ${JSON.stringify(commentExport)}`);

    const table = r['api-table.js'];
    assert(table.kind === 'fixture' && table.data.before[0].label === 'original' && table.data.after[0].label === 'edited' && table.data.write.written === true, `api-table.js failed: ${JSON.stringify(table)}`);

    const foreign = r['api-foreign-table.js'];
    assert(foreign.kind === 'host-fault' && foreign.data.kind === 'denied', `api-foreign-table.js was not denied: ${JSON.stringify(foreign)}`);

    const theme = r['api-theme.js'];
    assert(theme.kind === 'fixture' && theme.data.hasTokenValues === true && theme.data.noStylesheet === true && theme.data.noClassNames === true, `api-theme.js failed: ${JSON.stringify(theme)}`);

    const resize = r['api-resize.js'];
    assert(resize.kind === 'fixture' && resize.data.applied === MAX_SCREEN_HEIGHT_PX && resize.data.hostHeight === MAX_SCREEN_HEIGHT_PX, `api-resize.js was not clamped: ${JSON.stringify(resize)}`);

    const unknown = r['api-unknown.js'];
    assert(unknown.kind === 'host-fault' && unknown.data.kind === 'denied' && unknown.data.message.includes('unknown capability'), `api-unknown.js failed: ${JSON.stringify(unknown)}`);

    const forgery = r['api-forgery.js'];
    assert(forgery.kind === 'fixture' && forgery.data.forgeryRejected === true && forgery.data.readAfterAttack[0].id === 'seed', `api-forgery.js failed: ${JSON.stringify(forgery)}`);

    const flood = r['api-flood.js'];
    assert(flood.kind === 'host-fault' && flood.data.kind === 'flood' && flood.data.inboundCount === MAX_INBOUND_MESSAGES + 1 && flood.data.tornDown === true, `api-flood.js failed: ${JSON.stringify(flood)}`);

    const hang = r['hang.js'];
    assert(hang.kind === 'timeout' && hang.parentStayedResponsive === true, `hang.js parent responsiveness failed: ${JSON.stringify(hang)}`);

    console.log('SCREEN FRAME BROWSER VERIFICATION');
    console.log(`browser=${process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'}`);
    console.log(`browserVersion=${JSON.stringify(runResult.browserVersion)}`);
    console.log(`csp=${result.csp}`);
    console.log(`timeoutMs=${timeoutMs}`);
    console.log(`fixtures=${JSON.stringify(Object.fromEntries(fixtureNames.map((name) => [name, r[name].kind])))}`);
    for (const name of fixtureNames) console.log(`${name.replace('.js', '')}=${JSON.stringify(r[name].data ?? r[name])}`);
    console.log(`HANG_FINDING: parentResponsiveMs=${hang.parentResponsiveMs}, parentStayedResponsive=${hang.parentStayedResponsive}`);
    console.log('PASS');
}

main().catch((error) => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
});
