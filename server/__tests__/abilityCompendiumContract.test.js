import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadMods } from '../lib/modLoader.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const modsDir = path.join(projectRoot, 'mods');
const appVersion = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;

function abilityLoad() {
    return loadMods(modsDir, appVersion).mods.find((mod) => mod.id === 'ability-compendium');
}

describe('recovered Ability & Power Compendium contract', () => {
    it('installs and reloads through the real Generation 1 loader', () => {
        const first = abilityLoad();
        const second = abilityLoad();
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        expect(first.apiVersion).toBe(1);
        expect(first.native?.generateInterceptor).toBe('interceptPrompt');
        expect(first.screens).toEqual([{ id: 'manager', file: 'ability-compendium.screen.js', label: 'Open Ability & Power Compendium' }]);
        expect(first.tables.map((table) => table.name)).toEqual([
            'abilities', 'assignments', 'runtime', 'proposals', 'config', 'prompt-index',
        ]);
        expect(first.screenSources[0]).not.toContain('campaign.read');
        expect(first.screenSources[0]).not.toContain('file.download');
        expect(second.tables).toEqual(first.tables);
    });

    it('is absent after uninstall without changing the base loader', () => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ability-uninstall-'));
        try {
            const result = loadMods(empty, appVersion);
            expect(result.faults).toEqual([]);
            expect(result.mods.find((mod) => mod.id === 'ability-compendium')).toBeUndefined();
        } finally {
            fs.rmSync(empty, { recursive: true, force: true });
        }
    });
});
