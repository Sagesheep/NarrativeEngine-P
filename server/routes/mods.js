import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import { loadMods } from '../lib/modLoader.js';
import { registerModTables } from '../lib/modTableRegistry.js';
import { serverTableRegistry } from '../lib/tableRegistry.js';
import { serverError } from '../lib/serverError.js';

/**
 * Project 2 / WO-P2-04 — mod listing endpoint.
 *
 * Mounted at `/api/mods` (see `server.js`). Reads the mods folder on every request rather than
 * caching: the folder is how a user installs a mod ("drop a file in", plan §7), so a cache
 * would mean a restart before an install took effect, and the cost is a handful of small JSON
 * reads on a screen the user opens by hand.
 *
 * `loadMods` never throws, so the `catch` here is belt-and-braces for genuinely exceptional
 * failures (e.g. a serialisation error), not for bad mod files — those come back as `faults`.
 *
 * WO-P5-05: after loading, mod-declared tables are registered into the server table registry
 * so the derived campaign-file suffixes, generic routes, and transfer bundle include them.
 * Registration clears the previous batch first so an uninstalled mod's suffix does not linger.
 */
export function createModsRouter({ modsDir, appVersion } = {}) {
    const router = Router();

    router.get('/', (_req, res) => {
        try {
            const result = loadMods(modsDir, appVersion);
            registerModTables(serverTableRegistry, result.mods);
            res.json(result);
        } catch (err) {
            serverError(res, err, 'Mods');
        }
    });

    router.get('/:folder/*path', (req, res) => {
        try {
            const folder = req.params.folder;
            // path-to-regexp v8 delivers the splat as an array (e.g. `['index.js']`
            // or `['screens', 'editor.js']`). Join with `/` to get the mod-relative
            // path that `serveModFile` checks.
            const pathSegments = req.params.path;
            const relativePath = Array.isArray(pathSegments) ? pathSegments.join('/') : (pathSegments ?? '');
            const served = serveModFile(modsDir, folder, relativePath);
            if (served === null) {
                return res.status(404).json({ error: 'Not found' });
            }
            res.sendFile(served);
        } catch (err) {
            const statusCode = err.statusCode || 404;
            res.status(statusCode).json({ error: statusCode >= 500 ? 'Internal server error' : (err.message || 'Not found') });
        }
    });

    return router;
}

/**
 * Phase 1.5 / MANIFEST.md §6.6 — serve a file from a mod's own folder.
 *
 * The browser needs to `import()` a mod's `native.js` (Phase 1.5 §2.2), and the only
 * place that file can live is the mod's own folder on the user's disk. The server
 * never evaluates mod code (§4); it serves bytes, the browser executes them.
 *
 * ┌─ THE ONE SECURITY BUG THAT STILL MATTERS ───────────────────────────────────────────┐
 * │ Path traversal here reads files the *user* never installed — the server holds the   │
 * │ vault, and `../../server/vault.js` is the canonical attack. Containment is the same  │
 * │ discipline already used by `modLoader.js` for `native.js` / `compute.file`:         │
 * │ `realpathSync` plus `path.relative`, then check the resolved path is inside the     │
 * │ mod's directory. The check is re-applied here (not just trusted from the loader)    │
 * │ because a folder name in a URL is attacker-controlled input.                        │
 * └─────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Returns the resolved absolute path on success, or `null` for a missing file (404).
 * Throws an Error with `statusCode = 403` for a traversal attempt or an unknown mod
 * folder — both are 4xx to the client, never 5xx, because neither is a server fault.
 *
 * The folder name is matched against the mods directory ONLY (it must exist as a
 * direct subdirectory). A folder name containing a path separator is rejected before
 * any filesystem call.
 */
export function serveModFile(modsDir, folderName, relativePath) {
    if (typeof folderName !== 'string' || folderName.length === 0) {
        return notFound();
    }
    if (typeof relativePath !== 'string' || relativePath.length === 0) {
        return notFound();
    }
    // A folder name with a separator is a traversal vector — reject before any
    // filesystem call. The loader only ever produces single-segment folder names.
    if (folderName.includes('/') || folderName.includes('\\') || folderName.includes('..')) {
        return forbidden('invalid mod folder');
    }
    if (relativePath.includes('\\')) {
        return forbidden('mod asset path must use forward slashes');
    }
    // `..` segments are the canonical traversal attack. Reject the whole path
    // before `path.resolve` collapses it.
    if (relativePath.split('/').some((seg) => seg === '..')) {
        return forbidden('mod asset path must not contain .. segments');
    }

    const modDir = path.join(modsDir, folderName);
    let modRoot;
    try {
        modRoot = fs.realpathSync(modDir);
    } catch {
        // Unknown mod folder — same shape as a 404 so an attacker cannot enumerate.
        return notFound();
    }

    const requestedPath = path.resolve(modRoot, relativePath);
    let sourcePath;
    try {
        sourcePath = fs.realpathSync(requestedPath);
    } catch {
        return notFound();
    }

    // Containment: the resolved real path must lie inside the mod's own folder.
    // `path.relative` returns a path starting with `..` (or is absolute) when
    // the target is outside the root. The empty-string case (`path.relative(x, x)`)
    // is rejected too — a request for the folder itself is not a file.
    const relative = path.relative(modRoot, sourcePath);
    if (relative === '' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        return forbidden('mod asset must resolve to a file inside the mod\'s own folder');
    }

    // The URL path is a file (not a directory): enforce here so `sendFile` does
    // not turn into a directory listing on a misconfigured host.
    try {
        const stat = fs.statSync(sourcePath);
        if (!stat.isFile()) return notFound();
    } catch {
        return notFound();
    }

    return sourcePath;
}

function notFound() {
    return null;
}

function forbidden(message) {
    const err = new Error(message);
    err.statusCode = 403;
    throw err;
}
