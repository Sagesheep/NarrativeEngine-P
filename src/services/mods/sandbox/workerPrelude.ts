import { MAX_JOURNAL_ENTRIES } from './sandboxTypes';

/**
 * Build the classic-script source executed by one browser Worker for one compute run.
 *
 * This is defence in depth for buggy, hand-installed, local, single-user mods. It blocks the
 * network and the most obvious escape/persistence primitives, but it is not a claim that a
 * determined attacker with JavaScript execution cannot find an escape. Mod code never runs on
 * the server, which is the machine holding the encrypted vault.
 */
export function buildWorkerSource(modSource: string): string {
    // Strip ES module syntax so the mod source runs as a classic script in the
    // Worker. The mod source is a valid ES module (it may have `export default`
    // and named `export` declarations so tests can import the pure helpers); the
    // Worker is a classic script, so both forms are stripped here.
    //   - `export default async function ...` → `async function ...` (the
    //     prelude assigns it to `__sandboxMod` below).
    //   - `export function foo` / `export const bar` → `function foo` /
    //     `const bar` (named exports become top-level bindings inside the
    //     worker; the worker never re-exports them, they are just in scope).
    //   - `export { ... };` (a named export block, used by `mods/arc/compute.js`
    //     to expose pure helpers for the oracle test) → removed. The names
    //     are already in scope as top-level bindings; the export block is
    //     pure syntax in a classic script and would be a parse error.
    //
    // The `export default` strip uses the `m` flag so it matches at the start
    // of any line — `mods/arc/compute.js` puts the default export at the
    // bottom (after the pure helpers), not the top, and the strip must still
    // catch it. (Phase 4.0: this is the latent bug that prevented Arc from
    // running even after the binding was fixed — the strip only caught the
    // default export when it was the first token of the file.)
    const stripped = modSource
        .replace(/^\s*export\s+default\s+/gm, '')
        .replace(/^(\s*)export\s+(function|const|let|var|class)\s/gm, '$1$2 ')
        .replace(/^\s*export\s*\{[^]*?\}\s*;?\s*(?=\n|$)/gm, '');

    // Phase 4.0 — the default export becomes either:
    //   (a) an anonymous function expression at the START of the source
    //       (e.g. `export default async function (ctx) { ... }` →
    //       `async function (ctx) { ... }`), which is a valid RHS for
    //       `globalThis.__sandboxMod = ...`; OR
    //   (b) a named function declaration anywhere in the source (e.g.
    //       `mods/arc/compute.js` puts `export default async function
    //       arcCompute(ctx) { ... }` at the bottom, after the pure helpers),
    //       which is a hoisted declaration accessible by name from inside an
    //       IIFE.
    //
    // Case (a) is detected by `stripped` starting with `async function ` or
    // `function ` (an anonymous expression form). Case (b) is everything
    // else — the source has declarations, and the default export is a named
    // declaration somewhere in it.
    //
    // The OLD prelude (`globalThis.__sandboxMod = ${stripped}`) only handled
    // case (a) where the default export was the FIRST token of the file.
    // `mods/arc/compute.js` is case (b) and broke the OLD prelude silently:
    // `__sandboxMod` was set to the first comment's `undefined`, then
    // `const ARC_TICK_DC = ...` was a syntax error after the assignment.
    const isAnonymousExpression = /^\s*(async\s+)?function\s*\(/.test(stripped);
    const defaultSource = isAnonymousExpression
        ? `globalThis.__sandboxMod = ${stripped};`
        : [
            'globalThis.__sandboxMod = (function() {',
            stripped,
            '  // Look for a named default function declaration (hoisted to this IIFE scope).',
            '  const __sandboxCandidates = ["arcCompute", "compute", "tick", "default"];',
            '  for (const __sandboxName of __sandboxCandidates) {',
            '    try { if (typeof eval(__sandboxName) === "function") return eval(__sandboxName); } catch {}',
            '  }',
            '  return null;',
            '})();',
        ].join('\n');
    return [
        "'use strict';",
        'const __sandboxDenyGlobal = (name) => {',
        "  try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); } catch {}",
        '};',
        "['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedArrayBuffer', 'Atomics', 'indexedDB', 'caches'].forEach(__sandboxDenyGlobal);",
        "try { Object.defineProperty(navigator, 'sendBeacon', { value: undefined, writable: false, configurable: false }); } catch {}",
        'try { navigator.sendBeacon = undefined; } catch {}',
        'const __sandboxFreeze = (value, seen = new WeakSet()) => {',
        "  if (value && typeof value === 'object' && !seen.has(value)) {",
        '    seen.add(value); Object.freeze(value); for (const child of Object.values(value)) __sandboxFreeze(child, seen);',
        '  } return value;',
        '};',
        // Phase 4.0 — `defaultSource` is now the FULL `globalThis.__sandboxMod = ...`
        // statement (anonymous expression form) or the IIFE-wrapped named-
        // declaration form. See the comment above for the case split.
        defaultSource,
        'let __sandboxController;',
        'let __sandboxModelRoles = [];',
        'let __sandboxRpcId = 0;',
        'let __sandboxJournal = [];',
        'const __sandboxRpcPending = new Map();',
        'const __sandboxReply = (message) => {',
        '  const pending = __sandboxRpcPending.get(message.id);',
        '  if (!pending) return;',
        '  __sandboxRpcPending.delete(message.id);',
        '  if (message.ok) pending.resolve(message.value);',
        '  else pending.reject(new Error(message.error || "sandbox RPC failed"));',
        '};',
        'const __sandboxRpc = (channel, method, args) => new Promise((resolve, reject) => {',
        '  const id = ++__sandboxRpcId;',
        '  __sandboxRpcPending.set(id, { resolve, reject });',
        '  try { self.postMessage({ type: "rpc", id, channel, ...(method ? { method } : {}), args }); }',
        '  catch (error) { __sandboxRpcPending.delete(id); reject(error); }',
        '});',
        'const __sandboxWrite = new Proxy({}, {',
        '  get(_target, name) {',
        '    if (typeof name !== "string") return undefined;',
        '    return (...args) => {',
        `      if (__sandboxJournal.length >= ${MAX_JOURNAL_ENTRIES}) throw new Error('[sandbox] journal cap exceeded (${MAX_JOURNAL_ENTRIES} entries)');`,
        '      __sandboxJournal.push({ kind: "store", name, args });',
        '    };',
        '  },',
        '});',
        'const __sandboxTable = Object.freeze({',
        '  read: (name) => __sandboxRpc("table", "read", [name]),',
        '  write: (name, rows) => {',
        `    if (__sandboxJournal.length >= ${MAX_JOURNAL_ENTRIES}) throw new Error('[sandbox] journal cap exceeded (${MAX_JOURNAL_ENTRIES} entries)');`,
        '    __sandboxJournal.push({ kind: "table", name, rows });',
        '  },',
        '});',
        'const __sandboxModel = Object.freeze({',
        '  call: (role, request) => __sandboxRpc("model", "call", [role, request]).then((reply) => ({ content: String(reply?.content ?? "") })),',
        '  callJson: (role, request, options) => __sandboxRpc("model", "callJson", [role, request, options || {}]).then((reply) => reply.content),',
        '  available: (role) => __sandboxModelRoles.includes(role),',
        '});',
        'const __sandboxNativeOnly = (name) => () => {',
        '  throw new Error("[sandbox] " + name + " is native-tier only (EVENTS.md §5.1); a sandboxed compute mod cannot hold a listener across a run");',
        '};',
        'const __sandboxContext = {',
        '  get mod() { return __sandboxSnapshot.mod; },',
        '  get api() { return __sandboxSnapshot.api; },',
        '  get data() { return __sandboxSnapshot.data; },',
        '  get config() { return __sandboxSnapshot.config; },',
        '  write: __sandboxWrite,',
        '  model: __sandboxModel,',
        '  table: __sandboxTable,',
        '  get signal() { return __sandboxController.signal; },',
        '  refresh: () => __sandboxRpc("refresh", undefined, []),',
        '  log: (...args) => { self.postMessage({ type: "log", args }); },',
        '  subscribe: __sandboxNativeOnly("ctx.subscribe"),',
        '  events: Object.freeze({',
        '    on: __sandboxNativeOnly("ctx.events.on"),',
        '    off: __sandboxNativeOnly("ctx.events.off"),',
        '    once: __sandboxNativeOnly("ctx.events.once"),',
        '    emit: __sandboxNativeOnly("ctx.events.emit"),',
        '  }),',
        '};',
        'Object.freeze(__sandboxContext);',
        'let __sandboxSnapshot;',
        'let __sandboxStarted = false;',
        'self.onmessage = (event) => {',
        '  const message = event.data;',
        '  if (message && message.type === "rpc-reply") { __sandboxReply(message); return; }',
        '  if (message && message.type === "abort") { __sandboxController?.abort(); return; }',
        '  if (!message || message.type !== "run") return;',
        '  if (__sandboxStarted) { self.postMessage({ type: "error", message: "[sandbox] worker run already started" }); return; }',
        '  __sandboxStarted = true;',
        '  __sandboxModelRoles = Array.isArray(message.modelRoles) ? [...message.modelRoles] : [];',
        '  __sandboxSnapshot = __sandboxFreeze(message.snapshot);',
        '  __sandboxController = new AbortController();',
        '  Promise.resolve().then(() => {',
        '    if (typeof globalThis.__sandboxMod !== "function") throw new Error("[sandbox] compute source must export a default function");',
        '    return globalThis.__sandboxMod(__sandboxContext);',
        '  }).then((result) => {',
        '    try { self.postMessage({ type: "done", writes: __sandboxJournal, result }); }',
        '    catch (error) { self.postMessage({ type: "error", message: String(error), stack: error && error.stack ? String(error.stack) : "" }); }',
        '  }).catch((error) => {',
        '    self.postMessage({ type: "error", message: String(error), stack: error && error.stack ? String(error.stack) : "" });',
        '  });',
        '};',
    ].join('\n');
}

export const workerPrelude = buildWorkerSource;

