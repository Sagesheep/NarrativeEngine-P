// Every mod we actually ship must survive the real loader.
//
// WHY THIS EXISTS
// ---------------
// `arc.mod.json` — the COMPUTE gate's own artefact — was REJECTED at startup
// from the day it shipped, and nothing noticed for weeks. It declared
// `table:read:mod.arc.arcs`, its own table, and `validateComputeCapability`
// checked that against a fixed allowlist of HOST tables which had no concept
// of mod-owned ones (`COMPUTE_TABLE_READS`, modLoader.js).
//
// `arc.test.ts` and `arcUninstall.test.ts` stayed green throughout — 46 tests —
// because they exercise the compute logic and the uninstall path DIRECTLY and
// never reach the loader. The project kept proving the half it wrote a test
// for (12_PROJECT_GATE.md §6; the same shape as 06_FACADE.md §13).
//
// This test closes that gap for good: it loads the REAL `mods/` directory
// through the REAL loader and demands zero faults. A manifest that fails
// validation now fails a suite instead of failing silently in production.
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadMods } from '../lib/modLoader.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const modsDir = path.join(projectRoot, 'mods');
const appVersion = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
).version as string;

describe('shipped mods load cleanly', () => {
    it('every *.mod.json in mods/ loads with ZERO faults', () => {
        const { faults } = loadMods(modsDir, appVersion);
        // Print the reason, not just a count — a bare `toHaveLength(0)` tells
        // the next person nothing about which manifest broke or why.
        expect(faults.map((f) => `${f.file}: ${f.reason}`)).toEqual([]);
    });

    it('loads every manifest present on disk', () => {
        const onDisk = fs.readdirSync(modsDir).filter((f) => f.endsWith('.mod.json')).sort();
        const { mods } = loadMods(modsDir, appVersion);
        expect(mods.map((m) => m.file).sort()).toEqual(onDisk);
    });

    it('arc ships as a mod and the loader accepts its own-table capabilities', () => {
        const { mods } = loadMods(modsDir, appVersion);
        const arc = mods.find((m) => m.id === 'arc');
        expect(arc, 'arc.mod.json must load — it is the COMPUTE gate artefact').toBeDefined();
        // The exact capabilities that were rejected before the fix.
        expect(arc!.compute!.capabilities).toContain('table:read:mod.arc.arcs');
        expect(arc!.compute!.capabilities).toContain('table:write:mod.arc.arcs');
    });

    it('a mod may NOT name another mod\'s table', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-mod-'));
        try {
            fs.copyFileSync(path.join(modsDir, 'arc.compute.js'), path.join(tmp, 'arc.compute.js'));
            fs.writeFileSync(path.join(tmp, 'thief.mod.json'), JSON.stringify({
                id: 'thief',
                name: 'Thief',
                version: '1.0.0',
                contributions: [{ id: 'c', order: 900, text: '.' }],
                tables: [{ name: 'own', recordShape: 'array' }],
                compute: {
                    file: 'arc.compute.js',
                    hook: 'postTurn',
                    capabilities: ['table:read:mod.arc.arcs'],
                },
            }));
            const { mods, faults } = loadMods(tmp, appVersion);
            expect(mods).toHaveLength(0);
            expect(faults[0].reason).toMatch(/may not reach another mod's tables/);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('a mod may NOT name an own-table it never declared', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'undeclared-'));
        try {
            fs.copyFileSync(path.join(modsDir, 'arc.compute.js'), path.join(tmp, 'arc.compute.js'));
            fs.writeFileSync(path.join(tmp, 'typo.mod.json'), JSON.stringify({
                id: 'typo',
                name: 'Typo',
                version: '1.0.0',
                contributions: [{ id: 'c', order: 900, text: '.' }],
                tables: [{ name: 'notes', recordShape: 'array' }],
                compute: {
                    file: 'arc.compute.js',
                    hook: 'postTurn',
                    capabilities: ['table:write:mod.typo.notez'],
                },
            }));
            const { mods, faults } = loadMods(tmp, appVersion);
            expect(mods).toHaveLength(0);
            expect(faults[0].reason).toMatch(/not one of mod "typo"'s own declared tables/);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
