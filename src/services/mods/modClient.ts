import { API_BASE as API } from '../../lib/apiBase';
import type { ModLoadResult } from './modTypes';

/**
 * Project 2 / WO-P2-04 — client side of `GET /api/mods`.
 *
 * The server reads and validates the mods folder; this just carries the result across. Faults
 * are part of the payload, not an error condition: a rejected mod file is something the user
 * needs to SEE (with its reason), which is why it travels alongside the good mods rather than
 * failing the request.
 */
export async function fetchMods(): Promise<ModLoadResult> {
    const res = await fetch(`${API}/mods`);
    if (!res.ok) throw new Error(`Mods load failed: ${res.status}`);
    return res.json();
}
