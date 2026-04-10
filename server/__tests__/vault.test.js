import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KeyVault } from '../vault.js';

let tmpDir;
let vault;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nevault-test-'));
    vault = new KeyVault(tmpDir);
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('KeyVault lifecycle', () => {
    it('does not exist before create()', () => {
        expect(vault.exists()).toBe(false);
    });

    it('is not unlocked before create()', () => {
        expect(vault.isUnlocked()).toBe(false);
    });

    it('creates a machine-key vault (null password)', () => {
        vault.create({ presets: [] }, null);
        expect(vault.exists()).toBe(true);
    });

    it('auto-unlocks with machine key after create', () => {
        vault.create({ presets: [] }, null);
        vault.unlock(null);
        expect(vault.isUnlocked()).toBe(true);
    });

    it('stores and retrieves data', () => {
        vault.create({ presets: [] }, null);
        vault.unlock(null);
        vault.saveData({ presets: [{ name: 'test', storyAI: { apiKey: 'sk-test' } }] });
        const data = vault.getData();
        expect(data.presets[0].name).toBe('test');
        expect(data.presets[0].storyAI.apiKey).toBe('sk-test');
    });

    it('locks and prevents getData', () => {
        vault.create({ presets: [] }, null);
        vault.unlock(null);
        vault.lock();
        expect(vault.isUnlocked()).toBe(false);
        expect(() => vault.getData()).toThrow();
    });

    it('creates and unlocks with password', () => {
        vault.create({ presets: [] }, 'mypassword');
        vault.unlock('mypassword');
        expect(vault.isUnlocked()).toBe(true);
    });

    it('rejects wrong password', () => {
        vault.create({ presets: [] }, 'mypassword');
        expect(() => vault.unlock('wrongpassword')).toThrow();
    });

    it('deletes the vault file', () => {
        vault.create({ presets: [] }, null);
        vault.delete();
        expect(vault.exists()).toBe(false);
    });

    it('exports and re-imports vault data', () => {
        vault.create({ presets: [{ name: 'exported' }] }, null);
        vault.unlock(null);
        const buf = vault.exportWithPassword('exportpass');
        expect(Buffer.isBuffer(buf)).toBe(true);

        const imported = KeyVault.importFromBuffer(buf, 'exportpass');
        expect(imported.presets[0].name).toBe('exported');
    });

    it('hasRememberedKey returns false initially', () => {
        vault.create({ presets: [] }, null);
        expect(vault.hasRememberedKey()).toBe(false);
    });
});
