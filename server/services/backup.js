import fs from 'fs';
import path from 'path';
import { CAMPAIGNS_DIR, BACKUPS_DIR, readJson, writeJson, computeCampaignHash, campaignFiles } from '../lib/fileStore.js';

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

export function pruneAutoBackups(id, keep) {
    const backupDir = path.join(BACKUPS_DIR, id);
    if (!fs.existsSync(backupDir)) return;

    const folders = fs.readdirSync(backupDir)
        .filter(f => fs.statSync(path.join(backupDir, f)).isDirectory())
        .map(f => {
            const meta = readJson(path.join(backupDir, f, 'meta.json'), {});
            return { folder: f, isAuto: meta.isAuto || false };
        })
        .filter(f => f.isAuto)
        .sort((a, b) => Number(b.folder) - Number(a.folder));

    for (let i = keep; i < folders.length; i++) {
        const dirToRemove = path.join(backupDir, folders[i].folder);
        fs.rmSync(dirToRemove, { recursive: true, force: true });
    }
}
