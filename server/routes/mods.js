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

    return router;
}
