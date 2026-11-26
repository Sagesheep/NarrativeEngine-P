import { API_BASE as API } from '../../lib/apiBase';
import type { ModLoadResult } from './modTypes';

/**
 * Project 2 / WO-P2-04 — client side of `GET /api/mods`.
 *
 * The server reads and validates the mods folder; this just carries the result across. Faults
 * are part of the payload, not an error condition: a rejected mod file is something the user
 * needs to SEE (with its reason), which is why it travels alongside the good mods rather than
 * failing the request.
 *
 * Phase 6.2 — `userOrder` carries the user's chosen load order from
 * `settings.modLoadOrder`. It is passed as `?order=id1,id2,id3` so the
 * server's topological sort uses it as the primary tiebreak (the dependency
 * graph stays a hard constraint). An empty array or `undefined` is the
 * manifest default — the param is simply omitted.
 */
export async function fetchMods(userOrder?: readonly string[]): Promise<ModLoadResult> {
    // Build the URL with the query param if present. `API_BASE` is either
    // `/api` (dev, relative) or an absolute URL (prod). `URL` requires an
    // absolute URL or a base, so use `URLSearchParams` and string
    // concatenation rather than `new URL()` — a relative base would throw.
    const params = new URLSearchParams();
    if (userOrder && userOrder.length > 0) {
        params.set('order', userOrder.join(','));
    }
    const query = params.toString();
    const url = query ? `${API}/mods?${query}` : `${API}/mods`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Mods load failed: ${res.status}`);
    return res.json();
}
