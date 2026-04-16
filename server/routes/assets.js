import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { PUBLIC_ASSETS_DIR } from '../lib/fileStore.js';

export function createAssetsRouter() {
    const router = Router();

    // ═══════════════════════════════════════════
    //  Assets (NPC Portraits)
    // ═══════════════════════════════════════════

    router.post('/api/assets/download', async (req, res) => {
        const { url, filename: rawFilename } = req.body;
        if (!url || !rawFilename) return res.status(400).json({ error: 'Missing url or filename' });

        const filename = path.basename(rawFilename);
        if (!filename || filename.startsWith('.')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            const filePath = path.join(PUBLIC_ASSETS_DIR, filename);
            const resolved = path.resolve(filePath);
            if (!resolved.startsWith(path.resolve(PUBLIC_ASSETS_DIR))) {
                return res.status(400).json({ error: 'Invalid filename' });
            }
            fs.writeFileSync(filePath, buffer);

            // Return the relative path for the frontend (Vite serves /public at root)
            const relativePath = `/assets/portraits/${filename}`;
            res.json({ ok: true, path: relativePath });
        } catch (err) {
            console.error('[Asset Download] Error:', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    });

    return router;
}
