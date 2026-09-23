import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Changing the embedding size rebuilds the vector tables empty. That part is
 * unavoidable — vectors of the old size are unusable — but three things around
 * it were broken:
 *
 *   1. It was silent: one console line, and recall quietly fell back to
 *      keyword search.
 *   2. `embedding_meta` survived the rebuild still claiming every item was
 *      embedded at the current version, so the status screen reported
 *      everything current.
 *   3. Re-index only rebuilds rows below the current version, so it found
 *      nothing to do. There was no way back through the UI.
 *
 * These drive the whole path: embed, change the size, re-open, confirm the
 * damage is reported and recoverable, then recover.
 */

let tmpDir;
let settingsFile;
let vs;

function writeDims(dims) {
    fs.writeFileSync(settingsFile, JSON.stringify({ settings: { embeddingDims: dims } }), 'utf-8');
}

const vec = (dims, fill = 0.5) => Buffer.from(new Float32Array(dims).fill(fill).buffer);

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vec-rebuild-'));
    process.env.DATA_DIR = tmpDir;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fileStore = await import('../lib/fileStore.js');
    settingsFile = fileStore.SETTINGS_FILE;
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    writeDims(8);
    vs = await import('../lib/vectorStore.js');
    vs.initDb();
});

afterAll(() => {
    vi.restoreAllMocks();
    try { vs.getDb()?.close(); } catch { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('vector store — embedding size change', () => {
    it('is healthy before anything changes', () => {
        vs.storeArchiveEmbedding('camp-a', '001', vec(8));
        vs.storeArchiveEmbedding('camp-a', '002', vec(8));
        vs.storeLoreEmbedding('camp-a', 'lore-1', vec(8));
        vs.storeArchiveEmbedding('camp-b', '001', vec(8));

        expect(vs.getEmbeddingStatus('camp-a').scenes).toEqual({ total: 2, current: 2, stale: 0 });
        expect(vs.getVectorHealth('camp-a')).toEqual({ status: 'ok' });
    });

    it('marks every surviving embedding stale when the size changes', () => {
        writeDims(16);
        vs.initDb();   // re-open: the stored schema is 8, the configured size is now 16

        // Status used to read "2 current" here, over empty tables.
        expect(vs.getEmbeddingStatus('camp-a').scenes).toEqual({ total: 2, current: 0, stale: 2 });
        expect(vs.getEmbeddingStatus('camp-a').lore).toEqual({ total: 1, current: 0, stale: 1 });
    });

    it('reports the damage per campaign so the banner can say so', () => {
        expect(vs.getVectorHealth('camp-a')).toEqual({ status: 'reindex-needed', count: 3 });
        expect(vs.getVectorHealth('camp-b')).toEqual({ status: 'reindex-needed', count: 1 });
        expect(vs.getVectorHealth('never-embedded')).toEqual({ status: 'ok' });
    });

    it('clears as each item is re-embedded, which is what re-index does', () => {
        // Re-index rebuilds exactly the rows below the current version, and
        // stamps each one current as it goes. Do that by hand for camp-a.
        vs.storeArchiveEmbedding('camp-a', '001', vec(16));
        expect(vs.getVectorHealth('camp-a')).toEqual({ status: 'reindex-needed', count: 2 });

        vs.storeArchiveEmbedding('camp-a', '002', vec(16));
        vs.storeLoreEmbedding('camp-a', 'lore-1', vec(16));
        expect(vs.getVectorHealth('camp-a')).toEqual({ status: 'ok' });
        expect(vs.getEmbeddingStatus('camp-a').scenes).toEqual({ total: 2, current: 2, stale: 0 });

        // Other campaigns are unaffected until they are re-indexed themselves.
        expect(vs.getVectorHealth('camp-b')).toEqual({ status: 'reindex-needed', count: 1 });
    });

    it('stores new-size vectors through the re-opened connection', () => {
        // Guards the cached prepared statements: they were bound to the first
        // connection, and must be rebuilt for the one `initDb` just opened.
        expect(() => vs.storeArchiveEmbedding('camp-b', '001', vec(16))).not.toThrow();
        expect(vs.getVectorHealth('camp-b')).toEqual({ status: 'ok' });
    });

    it('reports an unavailable store and turns vector calls into no-ops', () => {
        vs.markVectorStoreUnavailable('extension failed to load');
        expect(vs.getVectorHealth('camp-a')).toEqual({ status: 'unavailable', detail: 'extension failed to load' });
        expect(() => vs.storeArchiveEmbedding('camp-a', '003', vec(16))).not.toThrow();
    });
});
