import { Router } from 'express';
import { KeyVault } from '../vault.js';
import { wrapAsync } from '../lib/asyncHandler.js';
import { AppError, serverError } from '../lib/serverError.js';

export function createVaultRouter(vault) {
    const router = Router();

    router.get('/api/vault/status', wrapAsync((_req, res) => {
        res.json({
            exists: vault.exists(),
            unlocked: vault.isUnlocked(),
            hasRemember: vault.hasRememberedKey()
        });
    }));

    router.post('/api/vault/setup', wrapAsync((req, res) => {
        const { password, presets } = req.body;

        if (vault.exists()) {
            return res.status(400).json({ error: 'Vault already exists' });
        }

        const initialData = { presets: presets || [] };

        try {
            vault.create(initialData, password);
            res.json({ ok: true, unlocked: true });
        } catch (err) {
            serverError(res, err, 'Vault Setup');
        }
    }));

    router.post('/api/vault/unlock', wrapAsync((req, res) => {
        const { password, remember } = req.body;

        if (!vault.exists()) {
            return res.status(404).json({ error: 'Vault does not exist' });
        }

        try {
            vault.unlock(password || null);

            if (remember && password) {
                vault.saveRememberedKey();
            }

            res.json({ ok: true, unlocked: true });
        } catch (err) {
            console.warn('[Vault] Unlock failed:', err.message);
            res.status(401).json({ error: 'Invalid password' });
        }
    }));

    router.post('/api/vault/unlock-remembered', wrapAsync((_req, res) => {
        if (!vault.hasRememberedKey()) {
            return res.status(400).json({ error: 'No remembered key' });
        }

        const success = vault.unlockWithRemembered();
        if (success) {
            res.json({ ok: true, unlocked: true });
        } else {
            res.status(401).json({ error: 'Remembered key failed' });
        }
    }));

    router.post('/api/vault/lock', wrapAsync((_req, res) => {
        vault.lock();
        res.json({ ok: true, unlocked: false });
    }));

    router.get('/api/vault/keys', wrapAsync((_req, res) => {
        try {
            const data = vault.getData();
            res.json(data);
        } catch (err) {
            if (err.message === 'Vault is locked') {
                return res.status(403).json({ error: 'Vault is locked' });
            }
            serverError(res, err, 'Vault Keys');
        }
    }));

    router.put('/api/vault/keys', wrapAsync((req, res) => {
        const data = req.body;
        if (!data || !Array.isArray(data.presets)) {
            return res.status(400).json({ error: 'Invalid payload: presets must be an array' });
        }

        const allowedRootKeys = new Set(['presets']);
        for (const key of Object.keys(data)) {
            if (!allowedRootKeys.has(key)) {
                return res.status(400).json({ error: `Invalid payload: unexpected property "${key}"` });
            }
        }

        const allowedPresetKeys = new Set(['id', 'name', 'storyAI', 'imageAI', 'summarizerAI', 'utilityAI', 'auxiliaryAI', 'sampling']);
        const allowedAIKeys = new Set(['endpoint', 'apiKey', 'modelName']);

        for (const preset of data.presets) {
            if (typeof preset !== 'object' || preset === null) {
                return res.status(400).json({ error: 'Invalid preset structure: must be an object' });
            }

            for (const key of Object.keys(preset)) {
                if (!allowedPresetKeys.has(key)) {
                    return res.status(400).json({ error: `Invalid preset: unexpected property "${key}"` });
                }
            }

            if (typeof preset.id !== 'string' || !preset.id) {
                return res.status(400).json({ error: 'Invalid preset: id is a required non-empty string' });
            }
            if (typeof preset.name !== 'string' || !preset.name) {
                return res.status(400).json({ error: 'Invalid preset: name is a required non-empty string' });
            }

            const aiSections = ['storyAI', 'imageAI', 'summarizerAI', 'utilityAI', 'auxiliaryAI'];
            for (const section of aiSections) {
                if (preset[section]) {
                    const conf = preset[section];
                    if (typeof conf !== 'object' || conf === null) {
                        return res.status(400).json({ error: `Invalid preset: ${section} must be an object` });
                    }
                    for (const key of Object.keys(conf)) {
                        if (!allowedAIKeys.has(key)) {
                            return res.status(400).json({ error: `Invalid preset AI config in ${section}: unexpected property "${key}"` });
                        }
                    }
                    if (conf.endpoint !== undefined && typeof conf.endpoint !== 'string') {
                        return res.status(400).json({ error: `Invalid preset: ${section} endpoint must be a string` });
                    }
                    if (conf.apiKey !== undefined && typeof conf.apiKey !== 'string') {
                        return res.status(400).json({ error: `Invalid preset: ${section} apiKey must be a string` });
                    }
                    if (conf.modelName !== undefined && typeof conf.modelName !== 'string') {
                        return res.status(400).json({ error: `Invalid preset: ${section} modelName must be a string` });
                    }
                }
            }

            if (preset.sampling) {
                if (typeof preset.sampling !== 'object') {
                    return res.status(400).json({ error: 'Invalid preset: sampling must be an object' });
                }
            }
        }

        try {
            vault.saveData(data);
            res.json({ ok: true });
        } catch (err) {
            if (err.message === 'Vault is locked') {
                return res.status(403).json({ error: 'Vault is locked' });
            }
            serverError(res, err, 'Vault Save');
        }
    }));

    router.post('/api/vault/export', wrapAsync((req, res) => {
        const { password } = req.body;

        try {
            const buffer = vault.exportWithPassword(password);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', 'attachment; filename="narrative-engine-keys.nevault"');
            res.send(buffer);
        } catch (err) {
            if (err.message === 'Vault must be unlocked to export') {
                return res.status(403).json({ error: err.message });
            }
            if (err.message === 'Invalid export file' || err.message.includes('decrypt')) {
                return res.status(400).json({ error: 'Export failed: invalid password or corrupt vault' });
            }
            serverError(res, err, 'Vault Export');
        }
    }));

    router.post('/api/vault/import', wrapAsync((req, res) => {
        const { file, password, merge = true } = req.body;

        if (!file || !password) {
            return res.status(400).json({ error: 'Missing file or password' });
        }

        try {
            const buffer = Buffer.from(file, 'base64');
            const importedData = KeyVault.importFromBuffer(buffer, password);

            if (merge && vault.isUnlocked()) {
                const existing = vault.getData();
                const existingPresets = existing.presets || [];
                const importedPresets = importedData.presets || [];
                const mergedPresets = [...existingPresets];

                for (const importedPreset of importedPresets) {
                    const existingIndex = mergedPresets.findIndex(p => p.name === importedPreset.name);
                    if (existingIndex >= 0) {
                        mergedPresets[existingIndex] = importedPreset;
                    } else {
                        mergedPresets.push(importedPreset);
                    }
                }

                vault.saveData({ presets: mergedPresets });
            } else {
                vault.saveData(importedData);
            }

            res.json({ ok: true, unlocked: true });
        } catch (err) {
            if (err.message === 'Invalid export file' || err.message.includes('decrypt') || err.message.includes('Invalid vault')) {
                return res.status(400).json({ error: 'Import failed: invalid file or wrong password' });
            }
            if (err.message === 'Vault is locked') {
                return res.status(403).json({ error: 'Vault is locked' });
            }
            serverError(res, err, 'Vault Import');
        }
    }));

    router.delete('/api/vault/remember', wrapAsync((_req, res) => {
        vault.clearRememberedKey();
        res.json({ ok: true });
    }));

    // Keep a recoverable encrypted copy when a user resets a forgotten password.
    router.post('/api/vault/reset', wrapAsync((_req, res) => {
        const archived = vault.archiveForRecovery();
        res.json({ ok: true, archived });
    }));

    router.delete('/api/vault', wrapAsync((_req, res) => {
        try {
            vault.delete();
            res.json({ ok: true });
        } catch (err) {
            serverError(res, err, 'Vault Delete');
        }
    }));

    return router;
}