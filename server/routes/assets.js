import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { PUBLIC_ASSETS_DIR } from '../lib/fileStore.js';
import { wrapAsync } from '../lib/asyncHandler.js';
import { serverError } from '../lib/serverError.js';

/**
 * The portraits folder is served statically on the API origin, and
 * express.static picks the Content-Type from the extension. A file saved as
 * `x.html` would therefore be served as a page on http://localhost:3001 with
 * same-origin access to every /api route, whatever bytes the "image" held.
 * Only raster image extensions are written. SVG is deliberately absent: it
 * is a document format that can carry script.
 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp']);

/** Returns the safe basename, or null when the name is unusable. */
export function safeImageFilename(rawFilename) {
    if (typeof rawFilename !== 'string') return null;
    const filename = path.basename(rawFilename);
    if (!filename || filename.startsWith('.')) return null;
    const dot = filename.lastIndexOf('.');
    if (dot <= 0) return null;
    const ext = filename.slice(dot + 1).toLowerCase();
    return IMAGE_EXTENSIONS.has(ext) ? filename : null;
}

const BAD_FILENAME = `Filename must end in an image extension (${[...IMAGE_EXTENSIONS].join(', ')})`;

export function createAssetsRouter() {
    const router = Router();

    router.post('/api/assets/upload', wrapAsync(async (req, res) => {
        const { dataUrl, filename: rawFilename } = req.body;
        if (!dataUrl || !rawFilename) return res.status(400).json({ error: 'Missing dataUrl or filename' });

        const filename = safeImageFilename(rawFilename);
        if (!filename) {
            return res.status(400).json({ error: BAD_FILENAME });
        }

        // Validate data URL prefix to avoid writing arbitrary base64 garbage.
        const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,/.exec(dataUrl);
        if (!match) return res.status(400).json({ error: 'Invalid data URL (must be base64 image)' });

        const base64 = dataUrl.slice(match[0].length);
        let buffer;
        try {
            buffer = Buffer.from(base64, 'base64');
        } catch {
            return res.status(400).json({ error: 'Invalid base64 payload' });
        }

        const filePath = path.join(PUBLIC_ASSETS_DIR, filename);
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(path.resolve(PUBLIC_ASSETS_DIR))) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        fs.writeFileSync(filePath, buffer);

        const relativePath = `/assets/portraits/${filename}`;
        res.json({ ok: true, path: relativePath });
    }));

    router.post('/api/assets/download', wrapAsync(async (req, res) => {
        const { url, filename: rawFilename } = req.body;
        if (!url || !rawFilename) return res.status(400).json({ error: 'Missing url or filename' });

        const filename = safeImageFilename(rawFilename);
        if (!filename) {
            return res.status(400).json({ error: BAD_FILENAME });
        }

        try {
            const response = await fetch(url);
            if (!response.ok) {
                return res.status(502).json({ error: `Upstream returned ${response.status}` });
            }

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            const filePath = path.join(PUBLIC_ASSETS_DIR, filename);
            const resolved = path.resolve(filePath);
            if (!resolved.startsWith(path.resolve(PUBLIC_ASSETS_DIR))) {
                return res.status(400).json({ error: 'Invalid filename' });
            }
            fs.writeFileSync(filePath, buffer);

            const relativePath = `/assets/portraits/${filename}`;
            res.json({ ok: true, path: relativePath });
        } catch (err) {
            if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
                return res.status(502).json({ error: `Failed to fetch asset: ${err.code}` });
            }
            serverError(res, err, 'Asset Download');
        }
    }));

    return router;
}