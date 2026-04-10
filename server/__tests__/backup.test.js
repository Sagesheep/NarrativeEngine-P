import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Backup functions read CAMPAIGNS_DIR and BACKUPS_DIR from fileStore at import time.
// We control DATA_DIR via env before dynamic import to get a temp-dir-scoped instance.

let tmpDir;
let createBackup;
let pruneAutoBackups;
let CAMPAIGNS_DIR;
let BACKUPS_DIR;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-test-'));
    process.env.DATA_DIR = tmpDir;

    // Dynamic import ensures each test gets fresh module evaluation
    // (vitest resets module cache between tests via isolateModules)
    const backup = await import('../services/backup.js?t=' + Date.now());
    const store = await import('../lib/fileStore.js?t=' + Date.now());

    createBackup = backup.createBackup;
    pruneAutoBackups = backup.pruneAutoBackups;
    CAMPAIGNS_DIR = store.CAMPAIGNS_DIR;
    BACKUPS_DIR = store.BACKUPS_DIR;

    fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
});

afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedCampaign(id, name = 'Test Campaign') {
    const data = { id, name, lastPlayedAt: Date.now() };
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${id}.json`), JSON.stringify(data));
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${id}.state.json`), JSON.stringify({ messages: [] }));
}

describe('createBackup', () => {
    it('creates a backup directory with meta.json', () => {
        const id = 'camp1';
        seedCampaign(id);
        const result = createBackup(id, { label: 'test', trigger: 'manual', isAuto: false });

        expect(result.timestamp).toBeDefined();
        expect(result.fileCount).toBeGreaterThan(0);

        const backupDir = path.join(BACKUPS_DIR, id, String(result.timestamp));
        expect(fs.existsSync(backupDir)).toBe(true);

        const meta = JSON.parse(fs.readFileSync(path.join(backupDir, 'meta.json'), 'utf-8'));
        expect(meta.label).toBe('test');
        expect(meta.trigger).toBe('manual');
        expect(meta.campaignName).toBe('Test Campaign');
    });

    it('copies campaign files into the backup directory', () => {
        const id = 'camp2';
        seedCampaign(id);
        const result = createBackup(id, {});
        const backupDir = path.join(BACKUPS_DIR, id, String(result.timestamp));
        const backedFiles = fs.readdirSync(backupDir).filter(f => f !== 'meta.json');
        expect(backedFiles.length).toBeGreaterThan(0);
    });

    it('skips auto-backup when hash unchanged', () => {
        const id = 'camp3';
        seedCampaign(id);
        createBackup(id, { isAuto: true });
        const result2 = createBackup(id, { isAuto: true });
        expect(result2.skipped).toBe(true);
    });

    it('creates new auto-backup when data changes', () => {
        const id = 'camp4';
        seedCampaign(id);
        createBackup(id, { isAuto: true });
        // Modify campaign data to change hash
        fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${id}.json`), JSON.stringify({ id, name: 'Changed', lastPlayedAt: 999 }));
        const result2 = createBackup(id, { isAuto: true });
        expect(result2.skipped).toBeUndefined();
        expect(result2.timestamp).toBeDefined();
    });
});

describe('pruneAutoBackups', () => {
    it('removes old auto-backups beyond the keep limit', () => {
        const id = 'prune1';
        seedCampaign(id);

        // Create 5 auto-backups with different hashes (change data each time)
        for (let i = 0; i < 5; i++) {
            fs.writeFileSync(
                path.join(CAMPAIGNS_DIR, `${id}.json`),
                JSON.stringify({ id, name: `Campaign v${i}`, lastPlayedAt: i })
            );
            createBackup(id, { isAuto: true });
        }

        pruneAutoBackups(id, 3);

        const backupDir = path.join(BACKUPS_DIR, id);
        const remaining = fs.readdirSync(backupDir)
            .filter(f => fs.statSync(path.join(backupDir, f)).isDirectory());
        expect(remaining.length).toBeLessThanOrEqual(3);
    });
});
