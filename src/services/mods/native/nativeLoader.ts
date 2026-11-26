/**
 * Phase 1.5 / MANIFEST.md §3 — the native-tier module loader.
 *
 * The mechanical heart of the modularity epic. This is where mod code stops being
 * text handed to a sandbox and starts being a real ES module in the page:
 *
 *   • `import()` the manifest's `native.js` ONCE per enabled mod, at the moment
 *     `activate` should fire (Phase 1.4 wires the firing moments; this phase
 *     supplies the seam).
 *   • Resolve the named exports from `manifest.native.hooks` against the
 *     module's namespace. A missing export is a `missing-export` fault, not a
 *     silent no-op — a manifest naming an export that does not exist is a bug
 *     the author needs to see.
 *   • Mount `native.css` on activate, unmount on disable. One `<link>` per
 *     mod, idempotent — re-activating does not double-mount.
 *   • Contain an import-time throw as a `load` fault: the app still starts,
 *     the broken mod is surfaced in Extensions, every other mod still loads.
 *     Modelled on `sandboxFaults.ts` (Phase 1.4 §3).
 *
 * ┌─ THE SERVER NEVER EVALUATES MOD CODE ──────────────────────────────────────┐
 * │ This module runs in the browser. The server holds the vault; mod code runs │
 * │ in the page with the app's own access (TRUST.md §C). The asset route in     │
 * │ `server/routes/mods.js` serves the bytes; this module `import()`s them.    │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ THE VITE-IGNORE MECHANISM (Phase 1.5 §5 stop condition, resolved) ────────┐
 * │ The import specifier is a runtime-built URL:                              │
 * │   `${API_BASE}/mods/<folder>/<native.js>`                                  │
 * │ Vite statically analyzes `import()` calls at build time. When the         │
 * │ specifier is a string built at runtime, Vite cannot analyze it and        │
 * │ emits a warning that breaks the build. The Vite-blessed escape hatch is   │
 * │ the `/* @vite-ignore * /` comment inside the `import()` call — this is    │
 * │ not a workaround that becomes permanent, it is the supported Vite API     │
 * │ for "this specifier is built at runtime, do not analyze it" (Vite docs,  │
 * │ "Dynamic Import" feature). MANIFEST.md §3 explicitly states the host      │
 * │ does not bundle or resolve bare imports for a mod; the served file is    │
 * │ the executed file. `@vite-ignore` is the only way to honour that contract │
 * │ under Vite.                                                                │
 * └─────────────────────────────────────────────────────────────────────────────┘
 */
import type {
    NativeHookFn,
    NativeModHooks,
} from '../lifecycle/lifecycleTypes';
import type { PromptInterceptor } from '../interceptors';

/**
 * Build the URL the browser will `import()` for a mod's `native.js`.
 *
 * The asset route is mounted at `/api/mods/:folder/*` (see `server/routes/mods.js`).
 * In Vite dev the `/api` prefix is proxied to the Express server; in Electron
 * production the `API_BASE` is absolute (`http://localhost:3001/api`) so file://
 * loads can reach the server (see `src/lib/apiBase.ts`).
 */
export function nativeModuleUrl(folder: string, jsPath: string, apiBase: string = apiBaseDefault): string {
    // `jsPath` is the manifest's `native.js` value, already validated as a
    // mod-relative path with forward slashes and no `..` (modLoader.js §6.5).
    // The asset route re-applies containment server-side; this side just builds
    // the URL. Encode each segment so a folder name with a space does not
    // break the path.
    const encodedFolder = encodeURIComponent(folder);
    const encodedPath = jsPath.split('/').map(encodeURIComponent).join('/');
    return `${apiBase}/mods/${encodedFolder}/${encodedPath}`;
}

/**
 * Build the URL the browser will use for a mod's `native.css` `<link href>`.
 * Same containment and encoding discipline as `nativeModuleUrl`.
 */
export function nativeCssUrl(folder: string, cssPath: string, apiBase: string = apiBaseDefault): string {
    const encodedFolder = encodeURIComponent(folder);
    const encodedPath = cssPath.split('/').map(encodeURIComponent).join('/');
    return `${apiBase}/mods/${encodedFolder}/${encodedPath}`;
}

/**
 * The asset-route API base. Mirrors `src/lib/apiBase.ts`'s `API_BASE` so the
 * native loader does not depend on a React-only module. The same protocol
 * detection: `file:` (Electron production) → absolute; otherwise relative
 * (Vite dev proxy).
 */
const apiBaseDefault: string =
    typeof window !== 'undefined' && typeof window.location !== 'undefined' && window.location.protocol === 'file:'
        ? 'http://localhost:3001/api'
        : '/api';

/**
 * The shape this loader returns from `import()`. The module may export the
 * hook functions directly, or may export them under names declared in
 * `manifest.native.hooks`. We resolve the declared names against this object.
 */
type NativeModuleExports = Record<string, unknown>;

/**
 * Thrown when a manifest declares a hook whose export name does not resolve
 * to a function on the module. The lifecycle host classifies this as a
 * `missing-export` fault (distinct from a `load` fault, which is a failed
 * `import()` itself) so the user sees "names a missing export" rather than
 * "load failed" — a missing export is a manifest bug, not a network error.
 */
export class NativeMissingExportError extends Error {
    public readonly modId: string;
    public readonly hookName: string;
    public readonly exportName: string;
    constructor(input: { modId: string; hookName: string; exportName: string; actual: string }) {
        super(`[native] mod "${input.modId}" hook "${input.hookName}" names export "${input.exportName}" which is ${input.actual}`);
        this.name = 'NativeMissingExportError';
        this.modId = input.modId;
        this.hookName = input.hookName;
        this.exportName = input.exportName;
    }
}

export interface NativeLoaderOptions {
    /**
     * The API base for the asset route. Defaults to the protocol-aware value
     * from `apiBaseDefault`. Injectable for tests that want to hit a fixture
     * server or stub the network entirely.
     */
    readonly apiBase?: string;
    /**
     * Injectable `import()` for tests. Production uses the real browser
     * `import()`. The function MUST accept a URL string and return a promise
     * of the module namespace, exactly like the dynamic `import()`.
     */
    readonly importModule?: (url: string) => Promise<NativeModuleExports>;
}

export interface NativeLoader {
    /**
     * Load a mod's native module and resolve its named hook exports.
     *
     * Returns `undefined` when the mod has no `native` block (the "behaves
     * identically" rule, Phase 1.4 §3). Returns `undefined` when the mod
     * declares no `native.hooks` at all — a mod with a `native.js` but no
     * hooks is still valid; it just has nothing to fire (MANIFEST.md §3.1
     * "Every hook is optional").
     *
     * THROWS when `import()` fails (syntax error, network 404, etc.) — the
     * caller (the lifecycle host) catches this and records a `load` fault.
     * THROWS when a declared hook name resolves to something that is not a
     * function — the caller records a `missing-export` fault.
     */
    load(mod: {
        readonly id: string;
        readonly name: string;
        readonly native?: { readonly js: string; readonly css?: string; readonly hooks?: Record<string, string> };
        readonly folder?: string;
    }): Promise<NativeModHooks | undefined>;
    /**
     * Phase 5.2 / MANIFEST.md §3 — resolve `native.generateInterceptor` against
     * the module's namespace.
     *
     * A separate method rather than a second return value from `load()`,
     * because the `LoadModHooks` seam is the lifecycle host's contract and an
     * interceptor is not a lifecycle hook. Both read the SAME module cache, so
     * this costs no second `import()`.
     *
     * Returns `undefined` when the mod declares no `native.generateInterceptor`
     * (the common case). THROWS `NativeMissingExportError` when the manifest
     * names an export that is not a function — a manifest naming a missing
     * export is a bug the author needs to see, exactly as for a hook.
     */
    resolveInterceptor(mod: {
        readonly id: string;
        readonly name: string;
        readonly native?: { readonly js: string; readonly generateInterceptor?: string };
        readonly folder?: string;
    }): Promise<PromptInterceptor | undefined>;
    /**
     * Mount the mod's `native.css` as a `<link>` in `<head>`. Idempotent: a
     * second call with the same mod id is a no-op. Returns the href on mount
     * or `null` when the mod declares no css.
     */
    mountCss(mod: {
        readonly id: string;
        readonly native?: { readonly css?: string };
        readonly folder?: string;
    }): string | null;
    /**
     * Remove the mod's `<link>` if present. Idempotent: a second call is a
     * no-op. Returns true if a link was removed.
     */
    unmountCss(modId: string): boolean;
    /**
     * Drop the in-memory module cache for one mod. The next `load()` will
     * re-import. Used on `disable` so a re-enable gets a fresh module
     * (mirrors the sandbox's per-run isolation).
     */
    forget(modId: string): void;
    /** Drop the entire cache. Test/teardown only. */
    clear(): void;
}

export function createNativeLoader(options: NativeLoaderOptions = {}): NativeLoader {
    const apiBase = options.apiBase ?? apiBaseDefault;
    const importModule = options.importModule ?? defaultImport;
    // Cache of resolved module namespaces per mod id, so `enable` does not
    // re-import. `load()` populates this; `forget()` clears one entry; the
    // lifecycle host's `disable` calls `forget()` so a re-enable re-imports
    // (matching the sandbox's per-run isolation — a mod that was disabled
    // and re-enabled should not see stale module state).
    const moduleCache = new Map<string, NativeModuleExports>();
    // Cache of mounted CSS hrefs per mod id, so `mountCss` is idempotent.
    const cssCache = new Map<string, string>();

    /**
     * `import()` the mod's `native.js` once and memoise the namespace.
     * Shared by `load` (hooks) and `resolveInterceptor` (Phase 5.2), so a mod
     * declaring both is imported once, not twice — and both see the same
     * module instance, which matters for any state the module holds between
     * `activate` and the interceptor call.
     */
    async function importExports(mod: {
        readonly id: string;
        readonly native?: { readonly js: string };
        readonly folder?: string;
    }): Promise<NativeModuleExports> {
        const cached = moduleCache.get(mod.id);
        if (cached) return cached;
        if (!mod.folder) {
            // The loader needs the folder to build the URL. A validated mod
            // with a `native` block always carries `folder` (modLoader.js
            // §6.6 sets it on every mod). Throwing here surfaces a programming
            // bug — the caller records a `load` fault and the app continues.
            throw new Error(`[native] mod "${mod.id}" has a native block but no folder`);
        }
        const url = nativeModuleUrl(mod.folder, mod.native!.js, apiBase);
        // The Vite-blessed escape hatch for runtime-dynamic specifiers.
        // See the file header for the full mechanism explanation.
        const exports = await importModule(/* @vite-ignore */ url);
        moduleCache.set(mod.id, exports);
        return exports;
    }

    async function load(mod: {
        readonly id: string;
        readonly name: string;
        readonly native?: { readonly js: string; readonly css?: string; readonly hooks?: Record<string, string> };
        readonly folder?: string;
    }): Promise<NativeModHooks | undefined> {
        if (!mod.native) return undefined;

        const exports = await importExports(mod);

        const declaredHooks = mod.native.hooks;
        if (!declaredHooks || Object.keys(declaredHooks).length === 0) {
            // A mod with a `native.js` but no `hooks` declarations has nothing
            // to fire. Return an empty object so the host short-circuits, the
            // same shape as a mod whose declared hooks all resolve to
            // undefined — but without running any resolution.
            return {};
        }

        const resolved: NativeModHooks = {};
        for (const [hookName, exportName] of Object.entries(declaredHooks)) {
            if (!isLifecycleHookName(hookName)) {
                // The loader already validates hook names at load time
                // (modLoader.js `NATIVE_HOOK_NAMES`); reaching here means the
                // loader and this module disagree on the set. Surface as a
                // missing-export so the discrepancy is visible.
                throw new Error(`[native] mod "${mod.id}" declares unknown hook "${hookName}"`);
            }
            const value = (exports as NativeModuleExports)[exportName];
            if (typeof value !== 'function') {
                throw new NativeMissingExportError({
                    modId: mod.id,
                    hookName,
                    exportName,
                    actual: typeof value,
                });
            }
            (resolved as Record<string, NativeHookFn>)[hookName] = value as NativeHookFn;
        }
        return resolved;
    }

    /**
     * Phase 5.2 / MANIFEST.md §3 — resolve the manifest's
     * `native.generateInterceptor` against the module's exports.
     *
     * Deliberately NOT part of `load()`'s return: the `LoadModHooks` seam is
     * the lifecycle host's contract for the seven hooks, and an interceptor is
     * not one of them (it has a return value and it fires per turn, not per
     * lifecycle event). Sharing `importExports` keeps it free.
     */
    async function resolveInterceptor(mod: {
        readonly id: string;
        readonly name: string;
        readonly native?: { readonly js: string; readonly generateInterceptor?: string };
        readonly folder?: string;
    }): Promise<PromptInterceptor | undefined> {
        const exportName = mod.native?.generateInterceptor;
        if (!mod.native || !exportName) return undefined;

        const exports = await importExports(mod);
        const value = exports[exportName];
        if (typeof value !== 'function') {
            throw new NativeMissingExportError({
                modId: mod.id,
                hookName: 'generateInterceptor',
                exportName,
                actual: typeof value,
            });
        }
        return value as PromptInterceptor;
    }

    function mountCss(mod: {
        readonly id: string;
        readonly native?: { readonly css?: string };
        readonly folder?: string;
    }): string | null {
        if (!mod.native?.css || !mod.folder) return null;
        const existing = cssCache.get(mod.id);
        if (existing) return existing;
        const href = nativeCssUrl(mod.folder, mod.native.css, apiBase);
        if (typeof document === 'undefined') return href;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = href;
        // The data attribute is the unmount key: `unmountCss` finds the link
        // by this attribute rather than by href, so a mod whose folder name
        // changes between mounts (impossible today, but defensive) still
        // unmounts cleanly. Idempotent: a second mount finds the existing
        // link and does not create another.
        link.setAttribute('data-mod-css', mod.id);
        document.head.appendChild(link);
        cssCache.set(mod.id, href);
        return href;
    }

    function unmountCss(modId: string): boolean {
        const had = cssCache.delete(modId);
        if (typeof document === 'undefined') return had;
        const link = document.head.querySelector(`link[data-mod-css="${cssAttrEscape(modId)}"]`);
        if (link) {
            link.parentNode?.removeChild(link);
            return true;
        }
        return had;
    }

    function forget(modId: string): void {
        moduleCache.delete(modId);
    }

    function clear(): void {
        moduleCache.clear();
        cssCache.clear();
    }

    return { load, resolveInterceptor, mountCss, unmountCss, forget, clear };
}

/**
 * The default `import()` for production. Wraps the global dynamic `import()`
 * so tests can swap it out via `NativeLoaderOptions.importModule`.
 *
 * The `/* @vite-ignore * /` comment MUST live on the call site that Vite sees
 * statically — inside `defaultImport`. Vite's analyzer walks the AST and
 * finds the comment on the `import()` call. Putting the comment in
 * `nativeModuleUrl` or in `load()` would not work — Vite only respects the
 * comment when it sits on the `import()` call it is analyzing.
 */
async function defaultImport(url: string): Promise<NativeModuleExports> {
    return await import(/* @vite-ignore */ url);
}

const LIFECYCLE_HOOK_NAMES: ReadonlySet<string> = new Set([
    'install', 'update', 'activate', 'enable', 'disable', 'delete', 'clean',
]);

function isLifecycleHookName(name: string): boolean {
    return LIFECYCLE_HOOK_NAMES.has(name);
}

/**
 * Escape a mod id for safe interpolation into a CSS attribute selector.
 * Mod ids are constrained to `/^[a-zA-Z0-9_-]+$/` by the loader, so this
 * is belt-and-braces — the regex guarantees no quotes or brackets — but
 * defensive escaping keeps the selector safe even if the constraint is
 * ever relaxed.
 */
function cssAttrEscape(value: string): string {
    return value.replace(/["\\]/g, '\\$&');
}