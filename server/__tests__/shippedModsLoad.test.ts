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
const bundledModsDir = path.join(projectRoot, 'public', 'bundled-mods');
const appVersion = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
).version as string;

describe('shipped mods load cleanly', () => {
    it('every manifest in mods/ loads with ZERO faults', () => {
        const { faults } = loadMods(modsDir, appVersion);
        // Print the reason, not just a count — a bare `toHaveLength(0)` tells
        // the next person nothing about which manifest broke or why.
        expect(faults.map((f) => `${f.file}: ${f.reason}`)).toEqual([]);
    });

    // Phase 8.5 — the gate above scanned ONE directory, and the mod this whole
    // epic exists to extract now lives in the other one. A bundled mod is the
    // mod a user is least able to fix and most likely to have: it ships in the
    // box, on by default, and a manifest fault in it is a broken install rather
    // than a broken download. It belongs under the same gate, for the reason
    // the file header gives about `arc.mod.json`.
    it('every manifest in public/bundled-mods/ loads with ZERO faults', () => {
        const { faults } = loadMods(modsDir, appVersion, undefined, bundledModsDir);
        expect(faults.map((f) => `${f.file}: ${f.reason}`)).toEqual([]);
    });

    it('enemies ships bundled, and adopts the five retired campaign files', () => {
        const { mods } = loadMods(modsDir, appVersion, undefined, bundledModsDir);
        const enemies = mods.find((m) => m.id === 'enemies');
        expect(enemies, 'the enemies mod must ship — Phase 8.5 §2, bundled and default-on').toBeDefined();
        expect(enemies!.provenance).toBe('bundled');
        // Every retired enemy file has exactly one adopter. A missing row here
        // is a campaign whose data never arrives.
        expect(
            enemies!.tables.map((t: { name: string; migrateFrom?: string }) => `${t.migrateFrom ?? '—'} → ${t.name}`).sort(),
        ).toEqual([
            '.enemies.json → compendium',
            '.enemy-combat.json → config',
            '.enemy-encounters.json → encounters',
            '.enemy-instances.json → instances',
            '.enemy-resolutions.json → resolutions',
        ]);
    });

    it('loads every manifest present on disk', () => {
        const onDisk = fs.readdirSync(modsDir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
            .map((e) => `${e.name}/manifest.json`)
            .sort();
        const { mods } = loadMods(modsDir, appVersion);
        expect(mods.map((m) => m.file).sort()).toEqual(onDisk);
    });

    it('arc ships as a mod and the loader accepts its own-table capabilities', () => {
        const { mods } = loadMods(modsDir, appVersion);
        const arc = mods.find((m) => m.id === 'arc');
        expect(arc, 'arc manifest must load — it is the COMPUTE gate artefact').toBeDefined();
        // The exact capabilities that were rejected before the fix.
        expect(arc!.compute!.capabilities).toContain('table:read:mod.arc.arcs');
        expect(arc!.compute!.capabilities).toContain('table:write:mod.arc.arcs');
    });

    it('a mod may NOT name another mod\'s table', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-mod-'));
        try {
            const thiefDir = path.join(tmp, 'thief');
            fs.mkdirSync(thiefDir);
            fs.copyFileSync(path.join(modsDir, 'arc', 'compute.js'), path.join(thiefDir, 'compute.js'));
            fs.writeFileSync(path.join(thiefDir, 'manifest.json'), JSON.stringify({
                id: 'thief',
                name: 'Thief',
                version: '1.0.0',
                contributions: [{ id: 'c', order: 900, text: '.' }],
                tables: [{ name: 'own', recordShape: 'array' }],
                compute: {
                    file: 'compute.js',
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
            const typoDir = path.join(tmp, 'typo');
            fs.mkdirSync(typoDir);
            fs.copyFileSync(path.join(modsDir, 'arc', 'compute.js'), path.join(typoDir, 'compute.js'));
            fs.writeFileSync(path.join(typoDir, 'manifest.json'), JSON.stringify({
                id: 'typo',
                name: 'Typo',
                version: '1.0.0',
                contributions: [{ id: 'c', order: 900, text: '.' }],
                tables: [{ name: 'notes', recordShape: 'array' }],
                compute: {
                    file: 'compute.js',
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

// Phase 6.3 — bundled mods ship in `public/bundled-mods/`, not in `mods/`.
// This verifies the bundled fixture mod ships, loads, and is tagged `bundled`.
describe('shipped bundled mods load cleanly (Phase 6.3)', () => {
    const bundledDir = path.join(projectRoot, 'public', 'bundled-mods');

    it('every manifest in public/bundled-mods/ loads with ZERO faults', () => {
        const { faults } = loadMods(modsDir, appVersion, undefined, bundledDir);
        expect(faults.map((f) => `${f.file}: ${f.reason}`)).toEqual([]);
    });

    it('the bundled fixture mod loads and is tagged provenance: "bundled"', () => {
        const { mods, faults } = loadMods(modsDir, appVersion, undefined, bundledDir);
        expect(faults).toEqual([]);
        const bundled = mods.find((m) => m.id === 'example-bundled-tone');
        expect(bundled, 'example-bundled-tone must load from public/bundled-mods/').toBeDefined();
        expect(bundled!.provenance).toBe('bundled');
    });

    it('the bundled fixture mod is distinct from every installed mod', () => {
        // No installed mod shares the bundled mod's id.
        const installedOnly = loadMods(modsDir, appVersion);
        const bundledIds = loadMods(modsDir, appVersion, undefined, bundledDir)
            .mods.filter((m) => m.provenance === 'bundled').map((m) => m.id);
        for (const id of bundledIds) {
            expect(installedOnly.mods.find((m) => m.id === id)).toBeUndefined();
        }
    });
});
