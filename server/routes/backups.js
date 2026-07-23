import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { CAMPAIGNS_DIR, BACKUPS_DIR, readJson, validateCampaignId, campaignFileNames } from '../lib/fileStore.js';
import { createBackup, updateBackupLabel } from '../services/backup.js';
import { wrapAsync } from '../lib/asyncHandler.js';
import { serverError } from '../lib/serverError.js';

export function createBackupsRouter() {
    const router = Router();

    router.post('/api/campaigns/:id/backup', wrapAsync((req, res) => {
        const id = req.params.id;
        validateCampaignId(id);
        const campaignFile = path.join(CAMPAIGNS_DIR, `${id}.json`);
        if (!fs.existsSync(campaignFile)) {
            return res.json({ skipped: true, reason: 'Campaign file not yet saved to disk' });
        }
        try {
            const result = createBackup(id, {
                label: req.body.label || '',
                trigger: req.body.trigger || 'manual',
                isAuto: req.body.isAuto || false,
            });
            res.json(result);
        } catch (err) {
            serverError(res, err, 'Backup');
        }
    }));

    router.patch('/api/campaigns/:id/backups/:ts', wrapAsync((req, res) => {
        const id = req.params.id;
        validateCampaignId(id);
        const ts = req.params.ts;
        if (!/^\d+$/.test(ts)) {
            return res.status(400).json({ error: 'Invalid timestamp parameter' });
        }
        const { label } = req.body;
        if (typeof label !== 'string') {
            return res.status(400).json({ error: 'Label must be a string' });
        }
        try {
            const updated = updateBackupLabel(id, ts, label);
            if (!updated) {
                return res.status(404).json({ error: 'Backup not found' });
            }
            res.json({ ok: true, meta: updated });
        } catch (err) {
            serverError(res, err, 'Backup');
        }
    }));


    router.get('/api/campaigns/:id/backups', wrapAsync((req, res) => {
        const id = req.params.id;
        validateCampaignId(id);
        const backupDir = path.join(BACKUPS_DIR, id);
        if (!fs.existsSync(backupDir)) return res.json({ backups: [] });
        try {
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
            serverError(res, err, 'Backup');
        }
    }));

    router.get('/api/campaigns/:id/backups/:ts', wrapAsync((req, res) => {
        const id = req.params.id;
        validateCampaignId(id);
        const ts = req.params.ts;
        if (!/^\d+$/.test(ts)) {
            return res.status(400).json({ error: 'Invalid timestamp parameter' });
        }
        const backupPath = path.join(BACKUPS_DIR, id, ts);
        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ error: 'Backup not found' });
        }
        try {
            const meta = readJson(path.join(backupPath, 'meta.json'), {});
            const files = fs.readdirSync(backupPath).filter(f => f !== 'meta.json');
            res.json({ meta, files });
        } catch (err) {
            serverError(res, err, 'Backup');
        }
    }));

    router.post('/api/campaigns/:id/backups/:ts/restore', wrapAsync(async (req, res) => {
        const id = req.params.id;
        validateCampaignId(id);
        const ts = req.params.ts;
        if (!/^\d+$/.test(ts)) {
            return res.status(400).json({ error: 'Invalid timestamp parameter' });
        }
        const backupPath = path.join(BACKUPS_DIR, id, ts);
        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ error: 'Backup not found' });
        }

        try {
            const restoreBackup = createBackup(id, {
                label: `Pre-restore from ${new Date(Number(ts)).toLocaleString()}`,
                trigger: 'pre-restore',
                isAuto: false,
            });

            const allowedNames = new Set(campaignFileNames(id));
            const backupFiles = fs.readdirSync(backupPath).filter(f => f !== 'meta.json');
            for (const name of backupFiles) {
                if (!allowedNames.has(name)) {
                    continue;
                }
                const src = path.join(backupPath, name);
                const dst = path.join(CAMPAIGNS_DIR, name);
                fs.copyFileSync(src, dst);
            }

            res.json({ ok: true, preRestoreBackup: restoreBackup });
        } catch (err) {
            serverError(res, err, 'Backup');
        }
    }));

    router.delete('/api/campaigns/:id/backups/:ts', wrapAsync((req, res) => {
        const id = req.params.id;
        validateCampaignId(id);
        const ts = req.params.ts;
        if (!/^\d+$/.test(ts)) {
            return res.status(400).json({ error: 'Invalid timestamp parameter' });
        }
        const backupPath = path.join(BACKUPS_DIR, id, ts);
        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ error: 'Backup not found' });
        }
        try {
            fs.rmSync(backupPath, { recursive: true, force: true });
            res.json({ ok: true });
        } catch (err) {
            serverError(res, err, 'Backup');
        }
    }));

    return router;
}