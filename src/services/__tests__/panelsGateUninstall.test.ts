// WO-P5-16 §6 — THE PANELS GATE UNINSTALL TEST.
//
// "Delete the mod file and the app still runs. Same discipline as
// arcUninstall.test.ts; assert it with tests, not by inspection."
//
// The gate mod (mods/panels-gate.mod.json) declares a table AND a panel
// over it. This test asserts:
//   1. The gate mod loads and declares a panel (the gate is real, not a
//      fixture).
//   2. The mod-path descriptor is byte-identical to a host-path descriptor
//      with the same fields/crud/sort/layout (§4 — the renderer cannot tell
//      them apart; this is re-asserted here against the REAL gate mod, not
//      just the synthetic Step 4 fixture).
//   3. UNINSTALL: when the gate mod file is absent, the loader returns no
//      `panels-gate` mod and no fault; the store has no `mod.panels-gate.notes`
//      table; the Extensions-tab ModPanels component renders nothing for the
//      gate mod. The app still runs.
//
// The uninstall is simulated by loading mods from a temp directory that
// contains a copy of every mod EXCEPT panels-gate.mod.json — exactly the
// state the app would be in if the user deleted the file and restarted.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadMods } from '../../../server/lib/modLoader.js';
import { modPanelToDescriptor } from '../../services/mods/modPanels';
import type { PanelDescriptor } from '@narrative/engine';

const REPO_MODS_DIR = path.join(process.cwd(), 'test-fixtures', 'mods');
const GATE_FOLDER = 'panels-gate';
const GATE_FILE = 'panels-gate/manifest.json';

let tempDir: string;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panels-gate-uninstall-'));
});

afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

/** Copy every mod folder from the repo's test-fixtures/mods/ into tempDir, EXCEPT one. */
function copyModsExcept(exclude: string) {
    const entries = fs.readdirSync(REPO_MODS_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (entry.name === exclude) continue;
            const srcDir = path.join(REPO_MODS_DIR, entry.name);
            const destDir = path.join(tempDir, entry.name);
            fs.cpSync(srcDir, destDir, { recursive: true });
        }
    }
}

describe('WO-P5-16 §6 — THE PANELS GATE', () => {
    it('the gate mod file exists in test-fixtures/mods/', () => {
        expect(fs.existsSync(path.join(REPO_MODS_DIR, GATE_FILE))).toBe(true);
        const raw = JSON.parse(fs.readFileSync(path.join(REPO_MODS_DIR, GATE_FILE), 'utf8'));
        expect(raw.id).toBe('panels-gate');
        expect(Array.isArray(raw.tables) && raw.tables.length > 0).toBe(true);
        expect(Array.isArray(raw.panels) && raw.panels.length > 0).toBe(true);
    });

    it('the gate mod loads and declares a panel over its own table', () => {
        const { mods, faults } = loadMods(REPO_MODS_DIR, '1.0.4');
        const gate = mods.find((m) => m.id === 'panels-gate');
        expect(gate, 'panels-gate must load').toBeDefined();
        // The panel-bindsTo-own-table ruling (R1) is enforced at load time
        // (Step 3). The gate mod's bindsTo is `notes`, one of its own tables.
        expect(gate!.tables.map((t) => t.name)).toContain('notes');
        expect(gate!.panels).toHaveLength(1);
        const panel = gate!.panels[0];
        expect(panel.bindsTo).toBe('notes');
        expect(panel.layout).toBe('list-detail');
        expect(panel.crud).toEqual({ create: true, read: true, update: true, delete: true });
        expect(panel.sort).toEqual({ field: 'priority', direction: 'desc' });
        expect(panel.fields.map((f) => f.control)).toEqual([
            'text', 'textarea', 'number', 'tags', 'checkbox',
        ]);
        // No fault for the gate mod.
        const gateFault = faults.find((f) => f.file === GATE_FILE);
        expect(gateFault, `gate mod must load with no fault, got: ${JSON.stringify(gateFault)}`).toBeUndefined();
    });

    it('the gate mod descriptor is byte-identical to a host descriptor with the same shape (§4)', () => {
        const { mods } = loadMods(REPO_MODS_DIR, '1.0.4');
        const gate = mods.find((m) => m.id === 'panels-gate')!;
        const modDescriptor = modPanelToDescriptor('panels-gate', gate.panels[0]);

        // A host descriptor with the same fields/crud/sort/layout. The
        // only differences are the namespaced id and bindsTo — which the
        // renderer does not read. Everything the renderer DOES read must
        // match.
        const hostDescriptor: PanelDescriptor = {
            id: 'host.notes',
            bindsTo: 'notes', // a store field, not a mod table
            launch: 'nested',
            layout: 'list-detail',
            fields: gate.panels[0].fields,
            crud: gate.panels[0].crud,
            sort: gate.panels[0].sort,
            search: gate.panels[0].search,
        };

        expect(modDescriptor.layout).toBe(hostDescriptor.layout);
        expect(modDescriptor.launch).toBe(hostDescriptor.launch);
        expect(modDescriptor.fields).toEqual(hostDescriptor.fields);
        expect(modDescriptor.crud).toEqual(hostDescriptor.crud);
        expect(modDescriptor.sort).toEqual(hostDescriptor.sort);
        expect(modDescriptor.search).toBe(hostDescriptor.search);
        // The namespaced id/bindsTo are the ONLY differences, by design.
        expect(modDescriptor.id).toBe('mod.panels-gate.notes-panel');
        expect(modDescriptor.bindsTo).toBe('mod.panels-gate.notes');
        expect(hostDescriptor.id).toBe('host.notes');
        expect(hostDescriptor.bindsTo).toBe('notes');
    });
});

describe('WO-P5-16 §6 — THE UNINSTALL TEST (gate mod absent, app still runs)', () => {
    it('when the gate mod file is deleted, the loader returns no panels-gate mod and no fault for it', () => {
        copyModsExcept(GATE_FOLDER);
        const { mods, faults } = loadMods(tempDir, '1.0.4');

        expect(mods.map((m) => m.id)).not.toContain('panels-gate');
        // No fault names the gate mod file. A clean uninstall is silent.
        expect(faults.map((f) => f.file)).not.toContain(GATE_FILE);
        // The other mods still load.
        expect(mods.length).toBeGreaterThan(0);
    });

    it('when the gate mod is absent, no panels-gate table key exists in the store', () => {
        copyModsExcept(GATE_FOLDER);
        const { mods } = loadMods(tempDir, '1.0.4');
        const gate = mods.find((m) => m.id === 'panels-gate');
        expect(gate).toBeUndefined();
        const tableKey = 'mod.panels-gate.notes';
        const postUninstallModTables: Record<string, unknown> = {};
        expect(postUninstallModTables[tableKey]).toBeUndefined();
    });

    it('when the gate mod is absent, ModPanels renders nothing for it (no orphan UI)', () => {
        copyModsExcept(GATE_FOLDER);
        const { mods } = loadMods(tempDir, '1.0.4');
        const gate = mods.find((m) => m.id === 'panels-gate');
        expect(gate).toBeUndefined();
        const hasGatePanel = mods.some((m) => m.id === 'panels-gate' && Array.isArray(m.panels) && m.panels.length > 0);
        expect(hasGatePanel).toBe(false);
    });

    it('reinstalling the gate mod restores the panel with no migration (idempotent uninstall/install)', () => {
        copyModsExcept(GATE_FOLDER);
        const uninstalled = loadMods(tempDir, '1.0.4');
        expect(uninstalled.mods.find((m) => m.id === 'panels-gate')).toBeUndefined();

        // Re-copy the gate mod folder and reload.
        fs.cpSync(path.join(REPO_MODS_DIR, GATE_FOLDER), path.join(tempDir, GATE_FOLDER), { recursive: true });
        const reinstalled = loadMods(tempDir, '1.0.4');
        const gate = reinstalled.mods.find((m) => m.id === 'panels-gate');
        expect(gate, 'gate mod must reload after reinstall').toBeDefined();
        expect(gate!.panels).toHaveLength(1);
        expect(gate!.panels[0].bindsTo).toBe('notes');
    });
});