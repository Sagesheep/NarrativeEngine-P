// WO-P5-17 — THE SCREENS GATE end-to-end load test.
//
// The gate mod (mods/screens-gate.mod.json) declares a screen. This test
// exercises the actual server stack: the mod loader reads the manifest,
// reads the screen source file as TEXT (R2 — the server never evaluates
// it), and carries both on the validated mod. The screen renders in the
// Extensions tab via ModScreens -> ScreenFrame; the isolation proof is
// scripts/verify-screen-frame.mjs (Step 4), not this test.
//
// The gate is real, not a fixture: the test copies the actual
// mods/screens-gate.mod.json and mods/screens-gate.js into a temp mods
// dir, loads them through the real mod loader, and asserts the screen
// declaration and source are present — exactly the path the ModScreens
// component reads.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import url from 'url';
import { loadMods } from '../lib/modLoader.js';

const __projectRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const gateModPath = path.join(__projectRoot, 'mods', 'screens-gate.mod.json');
const gateSourcePath = path.join(__projectRoot, 'mods', 'screens-gate.js');

let tmpDir: string;
let modsDir: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screens-gate-e2e-'));
    modsDir = path.join(tmpDir, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('WO-P5-17 — THE SCREENS GATE end-to-end load', () => {
    it('declare -> load -> screen declaration + source present -> uninstall -> app still runs', () => {
        // 1. DECLARE: copy the real gate mod and its screen source into the tmp mods dir.
        const gateModText = fs.readFileSync(gateModPath, 'utf-8');
        const gateSourceText = fs.readFileSync(gateSourcePath, 'utf-8');
        fs.writeFileSync(path.join(modsDir, 'screens-gate.mod.json'), gateModText);
        fs.writeFileSync(path.join(modsDir, 'screens-gate.js'), gateSourceText);

        // 2. LOAD: the real mod loader reads the manifest + source.
        const { mods, faults } = loadMods(modsDir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods).toHaveLength(1);
        const gate = mods[0];
        expect(gate.id).toBe('screens-gate');
        expect(gate.screens).toHaveLength(1);
        expect(gate.screens[0]).toEqual({
            id: 'gate-screen',
            file: 'screens-gate.js',
            label: 'Gate Screen',
        });
        // R2: the source ships as TEXT. The server never evaluates it —
        // it carries the raw string, not a parsed module. The source
        // contains the `export default` the ScreenFrame's buildScreenSrcDoc
        // will rewrite at render time.
        expect(gate.screenSources).toHaveLength(1);
        expect(gate.screenSources[0]).toBe(gateSourceText);
        expect(gate.screenSources[0]).toContain('export default');
        expect(gate.screenSources[0]).toContain('screens-gate: rendered in an isolated frame');
    });

    it('uninstall: delete the gate mod and the app still runs (no other mods affected)', () => {
        // Copy both the gate mod and a second, unrelated mod.
        fs.writeFileSync(path.join(modsDir, 'screens-gate.mod.json'), fs.readFileSync(gateModPath, 'utf-8'));
        fs.writeFileSync(path.join(modsDir, 'screens-gate.js'), fs.readFileSync(gateSourcePath, 'utf-8'));
        fs.writeFileSync(path.join(modsDir, 'other.mod.json'), JSON.stringify({
            id: 'other',
            name: 'Other',
            version: '1.0.0',
            contributions: [{ id: 'x', order: 100, text: '.' }],
        }));

        // Both load.
        let { mods, faults } = loadMods(modsDir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods.map((m) => m.id).sort()).toEqual(['other', 'screens-gate']);

        // UNINSTALL: delete the gate mod and its source.
        fs.unlinkSync(path.join(modsDir, 'screens-gate.mod.json'));
        fs.unlinkSync(path.join(modsDir, 'screens-gate.js'));

        // The other mod still loads; the gate mod is gone. No faults.
        ({ mods, faults } = loadMods(modsDir, '1.0.4'));
        expect(faults).toEqual([]);
        expect(mods.map((m) => m.id)).toEqual(['other']);
    });

    it('R2: the server never evaluates the screen source (a syntax error in the source is not a load fault)', () => {
        // The screen source is read as TEXT. A syntax error that would
        // fail at eval time is NOT a load fault — the server never
        // evaluates it. The frame evaluates it at render time, and a
        // syntax error there is a 'threw' fault (R5), not a load
        // rejection. This is the same rule as computeSource: the server
        // holds the vault; mod code never runs on the machine with the
        // keys.
        fs.writeFileSync(path.join(modsDir, 'screens-gate.mod.json'), fs.readFileSync(gateModPath, 'utf-8'));
        fs.writeFileSync(path.join(modsDir, 'screens-gate.js'), 'this is not valid javascript {{{');

        const { mods, faults } = loadMods(modsDir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods).toHaveLength(1);
        expect(mods[0].screenSources[0]).toBe('this is not valid javascript {{{');
    });
});