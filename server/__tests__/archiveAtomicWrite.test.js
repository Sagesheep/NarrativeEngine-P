import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * `.archive.md` is the campaign's lossless record and has no second copy.
 *
 * Every derived JSON file around it went through `writeJson`'s tmp+rename,
 * but the archive markdown itself was rewritten with a bare `writeFileSync`
 * by four separate mutators — so a crash or a full disk part-way through a
 * rewrite truncated the one file that cannot be reconstructed.
 *
 * These tests pin the two properties that make that safe: the whole-file
 * rewrite is atomic, and a failed rewrite leaves the previous content intact.
 */

let tmpDir;
let fileStore;
let repo;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-atomic-'));
    process.env.DATA_DIR = tmpDir;
    fileStore = await import('../lib/fileStore.js');
    repo = await import('../services/archiveRepository.js');
    fileStore.ensureDirs();
});

afterAll(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

const ID = 'campaign-atomic';

beforeEach(() => {
    vi.restoreAllMocks();
    const p = fileStore.archivePath(ID);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    if (fs.existsSync(p + '.tmp')) fs.unlinkSync(p + '.tmp');
});

describe('writeArchiveMd', () => {
    it('writes the content', () => {
        repo.writeArchiveMd(ID, '## SCENE 001\nhello\n');
        expect(repo.readArchiveMd(ID)).toBe('## SCENE 001\nhello\n');
    });

    it('leaves no temp file behind', () => {
        repo.writeArchiveMd(ID, 'content');
        expect(fs.existsSync(fileStore.archivePath(ID) + '.tmp')).toBe(false);
    });

    it('replaces the file by rename, never by truncating it in place', () => {
        repo.writeArchiveMd(ID, 'original content that must survive');

        const renameSpy = vi.spyOn(fs, 'renameSync');
        repo.writeArchiveMd(ID, 'replacement');

        expect(renameSpy).toHaveBeenCalled();
        const [from, to] = renameSpy.mock.calls.at(-1);
        expect(String(from)).toBe(fileStore.archivePath(ID) + '.tmp');
        expect(String(to)).toBe(fileStore.archivePath(ID));
        expect(repo.readArchiveMd(ID)).toBe('replacement');
    });

    it('leaves the previous archive intact when the write fails', () => {
        repo.writeArchiveMd(ID, 'the original lossless record');

        // Simulate a disk-full / permission failure part-way through.
        vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
            throw new Error('ENOSPC: no space left on device');
        });

        expect(() => repo.writeArchiveMd(ID, 'never lands')).toThrow(/ENOSPC/);
        // The point of tmp+rename: the real file was never opened for writing.
        expect(repo.readArchiveMd(ID)).toBe('the original lossless record');
    });
});

describe('archive mutators hold the campaign write lock', () => {
    it('rename, rollback, delete and edit-sync are all async', async () => {
        const svc = await import('../services/archiveService.js');
        // A mutator that takes the per-campaign lock must be async. A
        // synchronous export here means it rewrites the archive and the index
        // outside the lock, which is how a concurrent append loses its entry.
        for (const name of ['renameAcrossArchive', 'rollbackScenesFrom', 'deleteScene', 'updateSceneAssistant']) {
            expect(svc[name].constructor.name, `${name} must be async`).toBe('AsyncFunction');
        }
    });
});
