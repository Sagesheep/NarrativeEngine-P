import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { CAMPAIGNS_DIR, BACKUPS_DIR, readJson } from '../lib/fileStore.js';
import { createBackup } from '../services/backup.js';

export function createBackupsRouter() {
    const router = Router();

    // ═══════════════════════════════════════════
    //  Campaign Backups
    // ═══════════════════════════════════════════

    router.post('/api/campaigns/:id/backup', (req, res) => {
        try {
            const id = req.params.id;
            const campaignFile = path.join(CAMPAIGNS_DIR, `${id}.json`);
            if (!fs.existsSync(campaignFile)) {
                return res.json({ skipped: true, reason: 'Campaign file not yet saved to disk' });
            }
            const result = createBackup(id, {
                label: req.body.label || '',
                trigger: req.body.trigger || 'manual',
                isAuto: req.body.isAuto || false,
            });
            res.json(result);
        } catch (err) {
            console.error('[Backup] Create failed:', err);
            res.status(500).json({ error: 'Failed to create backup' });
        }
    });

    router.get('/api/campaigns/:id/backups', (req, res) => {
        try {
            const backupDir = path.join(BACKUPS_DIR, req.params.id);
            if (!fs.existsSync(backupDir)) return res.json({ backups: [] });

            const backups = fs.readdirSync(backupDir)
                .filter(f => fs.statSync(path.join(backupDir, f)).isDirectory())
                .map(f => {
                    const meta = readJson(path.join(backupDir, f, 'meta.json'), null);
                    if (!meta) return null;
                    return { ...meta, timestamp: Number(f) };
                })
                .filter(Boolean)
                .sort((a, b) => b.timestamp - a.timestamp);

            res.json({ backups });
        } catch (err) {
            console.error('[Backup] List failed:', err);
            res.status(500).json({ error: 'Failed to list backups' });
        }
    });

    router.get('/api/campaigns/:id/backups/:ts', (req, res) => {
        try {
            const backupPath = path.join(BACKUPS_DIR, req.params.id, req.params.ts);
            if (!fs.existsSync(backupPath)) {
                return res.status(404).json({ error: 'Backup not found' });
            }
            const meta = readJson(path.join(backupPath, 'meta.json'), {});
            const files = fs.readdirSync(backupPath).filter(f => f !== 'meta.json');
            res.json({ meta, files });
        } catch (err) {
            res.status(500).json({ error: 'Failed to read backup' });
        }
    });

    router.post('/api/campaigns/:id/backups/:ts/restore', async (req, res) => {
        try {
            const id = req.params.id;
            const ts = req.params.ts;
            const backupPath = path.join(BACKUPS_DIR, id, ts);
            if (!fs.existsSync(backupPath)) {
                return res.status(404).json({ error: 'Backup not found' });
            }

            const restoreBackup = createBackup(id, {
                label: `Pre-restore from ${new Date(Number(ts)).toLocaleString()}`,
                trigger: 'pre-restore',
                isAuto: false,
            });

            const backupFiles = fs.readdirSync(backupPath).filter(f => f !== 'meta.json');
            for (const name of backupFiles) {
                const src = path.join(backupPath, name);
                const dst = path.join(CAMPAIGNS_DIR, name);
                fs.copyFileSync(src, dst);
            }

            res.json({ ok: true, preRestoreBackup: restoreBackup });
        } catch (err) {
            console.error('[Backup] Restore failed:', err);
            res.status(500).json({ error: 'Failed to restore backup' });
        }
    });

    router.delete('/api/campaigns/:id/backups/:ts', (req, res) => {
        try {
            const backupPath = path.join(BACKUPS_DIR, req.params.id, req.params.ts);
            if (!fs.existsSync(backupPath)) {
                return res.status(404).json({ error: 'Backup not found' });
            }
            fs.rmSync(backupPath, { recursive: true, force: true });
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: 'Failed to delete backup' });
        }
    });

    return router;
}
