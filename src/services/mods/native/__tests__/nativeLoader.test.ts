/**
 * Phase 1.5 — native loader tests.
 *
 * Pins the done-when criteria from the work order:
 *   • a fixture native mod imports, activates, logs — verified by recording
 *     the hook calls (the running-app verification is the manual walkthrough
 *     in §4 of the work order; these tests pin the loader's contract).
 *   • a deliberately throwing mod produces a `load` fault; the app still works.
 *   • a missing export produces a `missing-export` fault, not a `load` fault.
 *   • CSS mount/unmount is idempotent and reversible.
 *   • the module cache is forgotten on `disable` so a re-enable re-imports.
 *
 * The `import()` seam is faked via `NativeLoaderOptions.importModule` so the
 * tests do not hit the network. The fake returns a module namespace with
 * the named exports the manifest declares; tests that exercise fault paths
 * throw from the fake or return a namespace missing the declared export.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createNativeLoader,
    nativeModuleUrl,
    nativeCssUrl,
    NativeMissingExportError,
} from '../nativeLoader';

const apiBase = 'http://test.local/api';

const modWithJs = (overrides = {}) => ({
    id: 'test-mod',
    name: 'Test Mod',
    version: '1.0.0',
    native: { js: 'index.js', hooks: { activate: 'onActivate', disable: 'onDisable' } },
    folder: 'test-mod',
    ...overrides,
});

describe('nativeModuleUrl', () => {
    it('builds the asset-route URL for a flat path', () => {
        expect(nativeModuleUrl('arc', 'index.js', apiBase)).toBe('http://test.local/api/mods/arc/index.js');
    });
    it('builds the asset-route URL for a nested path', () => {
        expect(nativeModuleUrl('arc', 'screens/editor.js', apiBase)).toBe('http://test.local/api/mods/arc/screens/editor.js');
    });
    it('URL-encodes the folder name', () => {
        expect(nativeModuleUrl('my mod', 'index.js', apiBase)).toBe('http://test.local/api/mods/my%20mod/index.js');
    });
});

describe('nativeCssUrl', () => {
    it('builds the asset-route URL for the css file', () => {
        expect(nativeCssUrl('arc', 'style.css', apiBase)).toBe('http://test.local/api/mods/arc/style.css');
    });
    it('URL-encodes the folder name', () => {
        expect(nativeCssUrl('my mod', 'style.css', apiBase)).toBe('http://test.local/api/mods/my%20mod/style.css');
    });
});

describe('createNativeLoader — load', () => {
    it('returns undefined for a mod with no native block', async () => {
        const loader = createNativeLoader({ apiBase, importModule: vi.fn() });
        const hooks = await loader.load({ id: 'plain', name: 'Plain', version: '1.0.0' });
        expect(hooks).toBeUndefined();
    });

    it('resolves named exports from the module namespace', async () => {
        const onActivate = vi.fn();
        const onDisable = vi.fn();
        const importModule = vi.fn().mockResolvedValue({ onActivate, onDisable });
        const loader = createNativeLoader({ apiBase, importModule });
        const hooks = await loader.load(modWithJs());
        expect(hooks).toBeDefined();
        expect(hooks?.activate).toBe(onActivate);
        expect(hooks?.disable).toBe(onDisable);
    });

    it('returns an empty object for a mod with no declared hooks', async () => {
        const importModule = vi.fn().mockResolvedValue({ onActivate: vi.fn() });
        const loader = createNativeLoader({ apiBase, importModule });
        const mod = modWithJs({ native: { js: 'index.js' } });
        const hooks = await loader.load(mod);
        expect(hooks).toEqual({});
    });

    it('caches the module so a second load does not re-import', async () => {
        const onActivate = vi.fn();
        const importModule = vi.fn().mockResolvedValue({ onActivate });
        const loader = createNativeLoader({ apiBase, importModule });
        const mod = modWithJs({ native: { js: 'index.js', hooks: { activate: 'onActivate' } } });
        await loader.load(mod);
        await loader.load(mod);
        expect(importModule).toHaveBeenCalledTimes(1);
    });

    it('throws when import() throws (load fault source)', async () => {
        const importModule = vi.fn().mockRejectedValue(new Error('syntax error at line 4'));
        const loader = createNativeLoader({ apiBase, importModule });
        await expect(loader.load(modWithJs())).rejects.toThrow(/syntax error at line 4/);
    });

    it('throws NativeMissingExportError when a declared export is not a function', async () => {
        const importModule = vi.fn().mockResolvedValue({ onActivate: 'not a function' });
        const loader = createNativeLoader({ apiBase, importModule });
        await expect(loader.load(modWithJs())).rejects.toBeInstanceOf(NativeMissingExportError);
    });

    it('throws when the mod has a native block but no folder', async () => {
        const loader = createNativeLoader({ apiBase, importModule: vi.fn() });
        const mod = modWithJs({ folder: undefined });
        await expect(loader.load(mod)).rejects.toThrow(/no folder/);
    });

    it('throws when the manifest declares an unknown hook name', async () => {
        const importModule = vi.fn().mockResolvedValue({ onActivate: vi.fn() });
        const loader = createNativeLoader({ apiBase, importModule });
        const mod = modWithJs({ native: { js: 'index.js', hooks: { unknownHook: 'onActivate' } } });
        await expect(loader.load(mod)).rejects.toThrow(/unknown hook "unknownHook"/);
    });
});

describe('createNativeLoader — mountCss / unmountCss', () => {
    beforeEach(() => {
        // Clean the DOM between tests so a leaked `<link>` from one test does
        // not satisfy another test's idempotence check.
        document.head.querySelectorAll('link[data-mod-css]').forEach((link) => link.remove());
    });

    it('mounts a <link> for a mod with css', () => {
        const loader = createNativeLoader({ apiBase, importModule: vi.fn() });
        const href = loader.mountCss({ id: 'arc', folder: 'arc', native: { css: 'style.css' } });
        expect(href).toBe('http://test.local/api/mods/arc/style.css');
        const link = document.head.querySelector('link[data-mod-css="arc"]');
        expect(link).not.toBeNull();
        expect(link?.getAttribute('href')).toBe(href);
        expect(link?.rel).toBe('stylesheet');
    });

    it('returns null for a mod with no css', () => {
        const loader = createNativeLoader({ apiBase, importModule: vi.fn() });
        const href = loader.mountCss({ id: 'arc', folder: 'arc', native: {} });
        expect(href).toBeNull();
        expect(document.head.querySelectorAll('link[data-mod-css]')).toHaveLength(0);
    });

    it('is idempotent: a second mount does not create a second link', () => {
        const loader = createNativeLoader({ apiBase, importModule: vi.fn() });
        const mod = { id: 'arc', folder: 'arc', native: { css: 'style.css' } };
        loader.mountCss(mod);
        loader.mountCss(mod);
        expect(document.head.querySelectorAll('link[data-mod-css="arc"]')).toHaveLength(1);
    });

    it('unmountCss removes the link', () => {
        const loader = createNativeLoader({ apiBase, importModule: vi.fn() });
        loader.mountCss({ id: 'arc', folder: 'arc', native: { css: 'style.css' } });
        const removed = loader.unmountCss('arc');
        expect(removed).toBe(true);
        expect(document.head.querySelectorAll('link[data-mod-css="arc"]')).toHaveLength(0);
    });

    it('unmountCss is idempotent: a second call returns false (nothing to remove)', () => {
        const loader = createNativeLoader({ apiBase, importModule: vi.fn() });
        loader.mountCss({ id: 'arc', folder: 'arc', native: { css: 'style.css' } });
        loader.unmountCss('arc');
        const removed = loader.unmountCss('arc');
        expect(removed).toBe(false);
    });

    it('unmountCss on a never-mounted mod is a no-op', () => {
        const loader = createNativeLoader({ apiBase, importModule: vi.fn() });
        expect(loader.unmountCss('never-mounted')).toBe(false);
    });
});

describe('createNativeLoader — forget / clear', () => {
    it('forget drops the cached module so the next load re-imports', async () => {
        const onActivate = vi.fn();
        const importModule = vi.fn().mockResolvedValue({ onActivate });
        const loader = createNativeLoader({ apiBase, importModule });
        const mod = modWithJs({ native: { js: 'index.js', hooks: { activate: 'onActivate' } } });
        await loader.load(mod);
        loader.forget('test-mod');
        await loader.load(mod);
        expect(importModule).toHaveBeenCalledTimes(2);
    });

    it('clear drops all caches', async () => {
        const onActivate = vi.fn();
        const importModule = vi.fn().mockResolvedValue({ onActivate });
        const loader = createNativeLoader({ apiBase, importModule });
        const mod = modWithJs({ native: { js: 'index.js', hooks: { activate: 'onActivate' } } });
        await loader.load(mod);
        loader.clear();
        await loader.load(mod);
        expect(importModule).toHaveBeenCalledTimes(2);
    });
});