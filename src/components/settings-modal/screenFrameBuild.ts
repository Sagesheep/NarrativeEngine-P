/**
 * WO-P5-17 / WO-P5-18 frame constants and srcdoc builder.
 */

export const SCREEN_SANDBOX_ATTRIBUTE = 'allow-scripts';

export const SCREEN_FRAME_CSP =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:";

export function rewriteExportDefault(source: string): string {
    const target = 'export default';
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        const next = source[i + 1];
        if (ch === '/' && next === '/') {
            const nl = source.indexOf('\n', i + 2);
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
        if (ch === "'" || ch === '"' || ch === '`') {
            const quote = ch;
            i += 1;
            while (i < source.length) {
                const c = source[i];
                if (c === '\\') {
                    i += 2;
                    continue;
                }
                if (c === quote) {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if (source.startsWith(target, i)) {
            const after = source[i + target.length];
            if (after === ' ' || after === '\t' || after === '\n' || after === '\r') {
                return source.slice(0, i) + 'globalThis.__screenMod = ' + source.slice(i + target.length + 1);
            }
        }
        i += 1;
    }
    return source;
}

export function buildScreenSrcDoc(source: string, csp: string): string {
    const moduleBody = rewriteExportDefault(source);
    return [
        '<!doctype html>',
        '<html>',
        '<head>',
        `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
        '<meta charset="utf-8">',
        '</head>',
        '<body>',
        '<script>',
        '(function () {',
        '  var __nonce = null;',
        '  var __theme = null;',
        '  var __pending = new Map();',
        '  var __nextId = 1;',
        '  var __themeListeners = [];',
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
        '    if (data.__screenThemeUpdate === true) {',
        '      if (data.nonce !== __nonce) return;',
        '      __theme = data.theme;',
        '      globalThis.__screenTheme = data.theme;',
        '      for (var i = 0; i < __themeListeners.length; i++) {',
        '        try { __themeListeners[i](data.theme); } catch (e) {}',
        '      }',
        '      try { window.dispatchEvent(new CustomEvent("themechange", { detail: data.theme })); } catch (e) {}',
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
        '        if (!__nonce) { reject(new Error("screen API not initialised — host did not send init message")); return; }',
        '        if (!requestObject || typeof requestObject !== "object" || typeof requestObject.capability !== "string") {',
        '          reject(new Error("malformed screen API request"));',
        '          return;',
        '        }',
        '        var id = __nextId++;',
        '        __pending.set(id, { resolve: resolve, reject: reject });',
        '        parent.postMessage(Object.assign({}, requestObject, { __screenRequest: true, id: id, nonce: __nonce }), "*");',
        '      });',
        '    },',
        '    get theme() { return __theme; },',
        '    onThemeChange: function (listener) {',
        '      if (typeof listener === "function") {',
        '        __themeListeners.push(listener);',
        '        return function () {',
        '          var idx = __themeListeners.indexOf(listener);',
        '          if (idx !== -1) __themeListeners.splice(idx, 1);',
        '        };',
        '      }',
        '      return function () {};',
        '    }',
        '  };',
        '})();',
        '</script>',
        '<script>',
        '(function () {',
        '  globalThis.__screenStart = function () {',
        '    if (globalThis.__screenStarted) return;',
        '    globalThis.__screenStarted = true;',
        '    try {',
        `      ${moduleBody}`,
        '      if (typeof globalThis.__screenMod !== "function") throw new Error("screen has no default export");',
        '      var result = globalThis.__screenMod();',
        '      if (result && typeof result.then === "function") {',
        '        result.catch(function (err) {',
        '          parent.postMessage({ __screenFault: true, nonce: globalThis.__screenNonce, kind: "threw", message: String(err && err.message ? err.message : err) }, "*");',
        '        });',
        '      }',
        '    } catch (err) {',
        '      parent.postMessage({ __screenFault: true, nonce: globalThis.__screenNonce, kind: "threw", message: String(err && err.message ? err.message : err) }, "*");',
        '    }',
        '  };',
        '  if (globalThis.__screenInitReceived) globalThis.__screenStart();',
        '})();',
        '</script>',
        '</body>',
        '</html>',
    ].join('\n');
}
