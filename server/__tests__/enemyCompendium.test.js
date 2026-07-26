import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir;

describe('enemy compendium campaign files', () => {
    // Isolate file-store imports so DATA_DIR is resolved independently per test.
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enemy-compendium-'));
        vi.resetModules();
    });

    // Remove only the temporary campaign directory created by this test.
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it('includes .enemies.json in campaign backup file discovery', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        const store = await import('../lib/fileStore.js?' + Date.now());
        fs.mkdirSync(store.CAMPAIGNS_DIR, { recursive: true });
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.json'), '{}');
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.enemies.json'), '[]');
        expect(store.campaignFiles('test')).toContain('test.enemies.json');
    });
});
