/**
 * Phase 1.5 — end-to-end test of the fixture native mods.
 *
 * Proves the done-when criteria against the actual shipped fixture mods
 * in `mods/example-native-mod/` and `mods/example-broken-native/`:
 *   • the working fixture's manifest loads through `loadMods`;
 *   • the broken fixture's manifest loads through `loadMods` (the throw is
 *     at import time, not load time);
 *   • the asset route serves the fixture's `index.js` and `style.css`;
 *   • a traversal attempt against the fixture's folder is rejected.
 *
 * The `import()` itself is exercised in `nativeLoader.test.ts` with a faked
 * seam (the Vitest environment does not run the Vite dev server, so a real
 * `import()` of a served URL would fail with a network error). The running-
 * app verification is the manual walkthrough in the work order §4; this
 * test pins the on-disk fixtures that walkthrough exercises.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadMods } from '../../../../../server/lib/modLoader.js';
import { serveModFile } from '../../../../../server/routes/mods.js';

const modsDir = path.resolve(process.cwd(), 'mods');

describe('Phase 1.5 — fixture native mods (e2e on disk)', () => {
    it('the working fixture loads through loadMods with a native block', () => {
        const { mods, faults } = loadMods(modsDir, '1.0.4');
        expect(faults).toEqual([]);
        const fixture = mods.find((m) => m.id === 'example-native-mod');
        expect(fixture).toBeDefined();
        expect(fixture?.native).toBeDefined();
        expect(fixture?.native?.js).toBe('index.js');
        expect(fixture?.native?.css).toBe('style.css');
        expect(fixture?.native?.hooks).toEqual({ activate: 'onActivate', disable: 'onDisable' });
        expect(fixture?.folder).toBe('example-native-mod');
    });

    it('the broken fixture loads through loadMods (the throw is at import time, not load time)', () => {
        const { mods, faults } = loadMods(modsDir, '1.0.4');
        expect(faults).toEqual([]);
        const broken = mods.find((m) => m.id === 'example-broken-native');
        expect(broken).toBeDefined();
        expect(broken?.native).toBeDefined();
        expect(broken?.native?.js).toBe('index.js');
        expect(broken?.native?.hooks).toEqual({ activate: 'onActivate' });
        // The index.js file exists on disk; the throw is INSIDE the file,
        // so loadMods does not fault. The import() at runtime would fault.
        const brokenJs = path.join(modsDir, 'example-broken-native', 'index.js');
        expect(fs.existsSync(brokenJs)).toBe(true);
    });

    it('the asset route serves the working fixture\'s index.js', () => {
        const resolved = serveModFile(modsDir, 'example-native-mod', 'index.js');
        expect(resolved).not.toBeNull();
        expect(resolved).toBe(path.join(modsDir, 'example-native-mod', 'index.js'));
        const content = fs.readFileSync(resolved!, 'utf-8');
        expect(content).toContain('onActivate');
        expect(content).toContain('onDisable');
    });

    it('the asset route serves the working fixture\'s style.css', () => {
        const resolved = serveModFile(modsDir, 'example-native-mod', 'style.css');
        expect(resolved).not.toBeNull();
        expect(resolved).toBe(path.join(modsDir, 'example-native-mod', 'style.css'));
    });

    it('the asset route serves the broken fixture\'s index.js (the throw is in the file, not the route)', () => {
        const resolved = serveModFile(modsDir, 'example-broken-native', 'index.js');
        expect(resolved).not.toBeNull();
        const content = fs.readFileSync(resolved!, 'utf-8');
        expect(content).toContain('deliberate import-time throw');
    });

    it('a traversal attempt against the fixture folder is rejected', () => {
        // The done-when criterion: a traversal attempt
        // (`../../server/vault.js` in the entry path) is rejected.
        expect(() => serveModFile(modsDir, 'example-native-mod', '../../server/vault.js')).toThrow();
        expect(() => serveModFile(modsDir, 'example-broken-native', '../../server/vault.js')).toThrow();
    });

    it('the working fixture exports the named hooks (verified by reading the source)', () => {
        // The native loader resolves `onActivate` and `onDisable` from the
        // module namespace. This test pins that the fixture's source
        // actually exports those names — a regression in the fixture would
        // cause a missing-export fault at runtime.
        const content = fs.readFileSync(
            path.join(modsDir, 'example-native-mod', 'index.js'),
            'utf-8',
        );
        expect(content).toMatch(/export\s+function\s+onActivate/);
        expect(content).toMatch(/export\s+function\s+onDisable/);
    });
});