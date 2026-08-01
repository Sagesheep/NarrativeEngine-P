// Client-side mod table machinery — Project 5 / WO-P5-05 Step 4.
//
// A mod table is DATA ONLY: a file on disk, a GET/PUT pair, hydration, and
// export/import — with zero mod code (WO-P5-05 §1). This module provides the
// generic get/save through the dynamic `/mod-tables/:table` route pair (Step 3),
// plus the hydration helper that fills the store's `modTables` map.
//
// The store holds one namespaced map: `modTables: Record<string, unknown>`,
// keyed by the descriptor's full namespaced name (`mod.<modId>.<name>`)
// (WO-P5-05 §6). Mod tables do NOT get individual top-level store fields —
// those are hand-written per table and the whole point is that no code is
// written. Panels (phase PANELS) make them pleasant to use; that is not this
// work order.

import { API_BASE as API } from '../../lib/apiBase';
import type { ValidatedMod, ValidatedModTable } from './modTypes';

/**
 * The namespaced name for a mod table: `mod.<modId>.<name>`. Mirrors the
 * server-side `modTableName` (server/lib/modTableRegistry.js) and the
 * contribution namespace `mod.<id>.<cid>` (modAdapter.ts).
 */
export function modTableName(modId: string, name: string): string {
    return `mod.${modId}.${name}`;
}

/**
 * Generic GET for a mod table. Hits the dynamic route pair at
 * `/api/campaigns/:id/mod-tables/:table` (Step 3). Returns the record-shape
 * default (`[]` for array, `null` for single-object) on a non-ok response —
 * mirroring the existing read accessors in campaignStore.ts.
 */
export async function getModTable(
    campaignId: string,
    table: ValidatedModTable,
    modId: string,
): Promise<unknown> {
    const name = modTableName(modId, table.name);
    const res = await fetch(`${API}/campaigns/${campaignId}/mod-tables/${name}`);
    if (!res.ok) return table.recordShape === 'array' ? [] : null;
    return res.json();
}

/**
 * Generic PUT for a mod table. Fire-and-forget, mirroring the existing save
 * accessors (saveLoreChunks/saveNPCLedger/etc).
 */
export async function saveModTable(
    campaignId: string,
    table: ValidatedModTable,
    modId: string,
    body: unknown,
): Promise<void> {
    const name = modTableName(modId, table.name);
    await fetch(`${API}/campaigns/${campaignId}/mod-tables/${name}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/**
 * Collect every declared mod table across all loaded mods, as
 * `{ modId, table }` pairs. Used by the hydrator to fetch each table's data.
 */
export function collectDeclaredModTables(mods: readonly ValidatedMod[]): Array<{ modId: string; table: ValidatedModTable }> {
    const out: Array<{ modId: string; table: ValidatedModTable }> = [];
    for (const mod of mods) {
        if (!Array.isArray(mod.tables)) continue;
        for (const table of mod.tables) {
            out.push({ modId: mod.id, table });
        }
    }
    return out;
}

/**
 * Hydrate every declared mod table for a campaign. Fetches all tables in
 * parallel (mirrors the campaign hydrator's `Promise.all` fan-out) and
 * returns a map keyed by the namespaced name, ready to spread into the
 * store's `modTables` field.
 *
 * NEVER THROWS. A failed fetch for one table yields that table's default
 * (`[]` or `null`), not a rejection — a single bad table must not break
 * campaign hydration.
 */
export async function hydrateModTables(
    campaignId: string,
    mods: readonly ValidatedMod[],
): Promise<Record<string, unknown>> {
    const declarations = collectDeclaredModTables(mods);
    if (declarations.length === 0) return {};

    const entries = await Promise.all(
        declarations.map(async ({ modId, table }) => {
            const name = modTableName(modId, table.name);
            try {
                const data = await getModTable(campaignId, table, modId);
                return [name, data] as const;
            } catch {
                // A failed fetch yields the default, not a rejection. A single
                // bad table must not break campaign hydration.
                return [name, table.recordShape === 'array' ? [] : null] as const;
            }
        }),
    );

    const map: Record<string, unknown> = {};
    for (const [name, data] of entries) {
        map[name] = data;
    }
    return map;
}