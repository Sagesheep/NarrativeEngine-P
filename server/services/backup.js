import fs from 'fs';
import path from 'path';
import { CAMPAIGNS_DIR, BACKUPS_DIR, readJson, writeJson, computeCampaignHash, campaignFiles, campaignFileNames, archiveIndexPath } from '../lib/fileStore.js';
import { listArchiveSceneIds, deleteArchiveEmbedding } from '../lib/vectorStore.js';

export function createBackup(id, opts = {}) {
    const { label = '', trigger = 'manual', isAuto = false } = opts;
    const now = Date.now();
    const hash = computeCampaignHash(id);

    if (isAuto) {
        const backupDir = path.join(BACKUPS_DIR, id);
        if (fs.existsSync(backupDir)) {
            const folders = fs.readdirSync(backupDir)
                .filter(f => fs.statSync(path.join(backupDir, f)).isDirectory())
                .sort()
                .reverse();
            for (const folder of folders) {
                const metaFile = path.join(backupDir, folder, 'meta.json');
                if (fs.existsSync(metaFile)) {
                    const meta = readJson(metaFile);
                    if (meta && meta.isAuto && meta.hash === hash) {
                        return { skipped: true };
                    }
                    break;
                }
            }
        }
    }

    const backupPath = path.join(BACKUPS_DIR, id, String(now));
    fs.mkdirSync(backupPath, { recursive: true });

    const files = campaignFiles(id);
    for (const name of files) {
        const src = path.join(CAMPAIGNS_DIR, name);
        const dst = path.join(backupPath, name);
        fs.copyFileSync(src, dst);
    }

    const campaignMeta = readJson(path.join(CAMPAIGNS_DIR, `${id}.json`), {});

    const meta = {
        timestamp: now,
        label,
        trigger,
        hash,
        fileCount: files.length,
        isAuto,
        campaignName: campaignMeta.name || 'Unknown',
    };
    writeJson(path.join(backupPath, 'meta.json'), meta);

    if (isAuto) {
        pruneAutoBackups(id, 10);
    }

    return { timestamp: now, hash, fileCount: files.length };
}

/**
 * Roll a campaign back to a backup.
 *
 * Restore REPLACES the campaign's file set — it does not merge into it.
 * `createBackup` only copies files that already exist (`campaignFiles`), so a
 * backup taken before the first scene contains no `.archive.md`,
 * `.archive.index.json` or `.archive.chapters.json` at all. Copying only what
 * the backup holds therefore left every file written AFTER the backup in place:
 * restoring a blank campaign kept the scenes, the archive index and the
 * chapters recorded since, and sealing the chapter then summarised scenes the
 * restored state never contained. Any campaign file the backup lacks must go.
 *
 * Returns the pre-restore backup so the caller can offer an undo.
 */
export function restoreBackup(id, ts) {
    const backupPath = path.join(BACKUPS_DIR, id, String(ts));
    if (!fs.existsSync(backupPath)) {
        const err = new Error('Backup not found');
        err.statusCode = 404;
        throw err;
    }

    const preRestore = createBackup(id, {
        label: `Pre-restore from ${new Date(Number(ts)).toLocaleString()}`,
        trigger: 'pre-restore',
        isAuto: false,
    });

    const backupFiles = new Set(fs.readdirSync(backupPath).filter(f => f !== 'meta.json'));
    const metaName = `${id}.json`;
    for (const name of campaignFileNames(id)) {
        const dst = path.join(CAMPAIGNS_DIR, name);
        if (backupFiles.has(name)) {
            fs.copyFileSync(path.join(backupPath, name), dst);
        } else if (name !== metaName && fs.existsSync(dst)) {
            // Never delete `${id}.json` — it is the campaign's identity record,
            // and dropping it would unlist the campaign entirely. The backup
            // endpoint refuses to run without it, so a real backup always
            // carries one; this only guards hand-made backup directories.
            fs.rmSync(dst, { force: true });
        }
    }

    purgeOrphanedSceneEmbeddings(id);

    return preRestore;
}

/**
 * Scene vectors live in embeddings.db, which backups do not cover. Drop every
 * vector whose scene is absent from the (restored) archive index — otherwise
 * semantic recall keeps surfacing scenes the campaign no longer has. Non-fatal:
 * a stale vector degrades recall, it does not corrupt the save.
 */
function purgeOrphanedSceneEmbeddings(id) {
    try {
        const index = readJson(archiveIndexPath(id), []);
        const restoredIds = new Set(
            (Array.isArray(index) ? index : [])
                .map(e => String(e?.sceneId ?? '').trim())
                .filter(Boolean)
                .map(s => s.padStart(3, '0'))
        );
        for (const sceneId of listArchiveSceneIds(id)) {
            if (!restoredIds.has(String(sceneId).padStart(3, '0'))) {
                deleteArchiveEmbedding(id, sceneId);
            }
        }
    } catch (e) {
        console.warn(`[Backup] Restore embedding purge failed: ${e.message}`);
    }
}

export function updateBackupLabel(id, ts, label) {
    const backupPath = path.join(BACKUPS_DIR, id, String(ts));
    const metaPath = path.join(backupPath, 'meta.json');
    if (!fs.existsSync(metaPath)) return null;

    const meta = readJson(metaPath, {});
    meta.label = label ? String(label).trim() : '';
    writeJson(metaPath, meta);
    return meta;
}

export function pruneAutoBackups(id, keep) {
    const backupDir = path.join(BACKUPS_DIR, id);
    if (!fs.existsSync(backupDir)) return;

    const folders = fs.readdirSync(backupDir)
        .filter(f => fs.statSync(path.join(backupDir, f)).isDirectory())
        .map(f => {
            const meta = readJson(path.join(backupDir, f, 'meta.json'), {});
            return { folder: f, isAuto: meta.isAuto || false, label: meta.label || '' };
        })
        .filter(f => f.isAuto && !f.label.trim())
        .sort((a, b) => Number(b.folder) - Number(a.folder));

    for (let i = keep; i < folders.length; i++) {
        const dirToRemove = path.join(backupDir, folders[i].folder);
        fs.rmSync(dirToRemove, { recursive: true, force: true });
    }
}

