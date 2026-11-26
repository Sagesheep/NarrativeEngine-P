import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir;

describe('legacy enemy campaign suffix preservation', () => {
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enemy-suffix-'));
        vi.resetModules();
        vi.stubEnv('DATA_DIR', tmpDir);
    });

    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it.each([
        'test.enemies.json',
        'test.enemy-instances.json',
        'test.enemy-encounters.json',
        'test.enemy-resolutions.json',
        'test.enemy-combat.json',
    ])('keeps %s in campaign backup file discovery', async (suffix) => {
        const store = await import('../lib/fileStore.js?' + Date.now() + Math.random());
        fs.mkdirSync(store.CAMPAIGNS_DIR, { recursive: true });
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.json'), '{}');
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, suffix), '{}');
        expect(store.campaignFiles('test')).toContain(suffix);
    });
});
