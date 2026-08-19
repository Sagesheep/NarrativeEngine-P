import { solveWorldMap } from './solver.js';
import { mountMapRenderer } from './renderer.js';
import { findRoute, BASE_GRIDS_PER_DAY } from './pathfinder.js';
import {
    ChunkStore,
    biomeAt,
    buildWarpField,
    deserializeHardened,
    hardenCell,
    serializeHardened,
} from './field.js';

const DEFAULT_CLIMATE_GRADIENT = 0.65;
const reportsByCampaign = new Map();
const reportListeners = new Set();
const mapPaintListeners = new Set();
const hardenedByCampaign = new Map();
const chunkStoreByCampaign = new Map();
const worldVersionByCampaign = new Map();
const snapshotCacheByCampaign = new Map();
let solveQueue = Promise.resolve();

// WO 6.1 — click-to-travel route-preview state, per campaign. The preview is
// computed by the mod (which owns the pathfinder and the chunk store) and
// read back by the renderer via `getRoutePreview`. A commit emits
// `mod.worldmap.travelRequest` for the host listener to translate into a
// `composeDeparture` call — the host owns the departure sentence and the
// pending intent, so the sentence stays byte-identical across all three
// entry points (map, Places panel, composer button).
const routePreviewByCampaign = new Map();
// The currently selected travel mode for the map's mode selector. Defaults to
// 'foot'; the host's `context.travelMode` is the source of truth and is read
// at snapshot time, but the selector needs a value between snapshot updates.
let currentTravelMode = 'foot';
// The mode ids the map's selector offers. WO 3's canonical set, in display
// order. The pathfinder accepts foot/mount/cart/boat; `horseback` maps to
// `mount` and `flying` routes as a straight line (no terrain awareness).
const MAP_TRAVEL_MODES = Object.freeze([
    { id: 'foot', label: 'On foot' },
    { id: 'cart', label: 'Cart' },
    { id: 'horseback', label: 'Horseback' },
    { id: 'flying', label: 'Flying' },
]);
// WO 6.1 §1 — a click on a cell with no anchor within 2 cells refuses rather
// than inventing a destination. The radius is in cells.
const ANCHOR_SNAP_RADIUS = 2;

function validSettings(value) {
    return value
        && typeof value === 'object'
        && typeof value.worldSeed === 'string'
        && value.worldSeed.length > 0
        && typeof value.climateGradient === 'number'
        && Number.isFinite(value.climateGradient);
}

function createWorldSeed(campaignId = '') {
    if (globalThis.crypto?.getRandomValues) {
        const values = new Uint32Array(4);
        globalThis.crypto.getRandomValues(values);
        return [...values].map(value => value.toString(16).padStart(8, '0')).join('');
    }
    // Old embedded webviews without Web Crypto still receive a one-time seed.
    // The seed is persisted; determinism begins after this installation write.
    const source = `${campaignId}:${Date.now()}`;
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `fallback-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

async function ensureSettings(ctx) {
    const raw = await ctx.table.read('settings');
    if (validSettings(raw)) {
        return {
            worldSeed: raw.worldSeed,
            climateGradient: Math.max(0, Math.min(1, raw.climateGradient)),
        };
    }
    const settings = {
        worldSeed: createWorldSeed(ctx.data.campaignId ?? ''),
        climateGradient: DEFAULT_CLIMATE_GRADIENT,
    };
    await ctx.table.write('settings', settings);
    return settings;
}

function worldVersion(campaignId) {
    return worldVersionByCampaign.get(campaignId) ?? 0;
}

function bumpWorldVersion(campaignId) {
    const next = (worldVersionByCampaign.get(campaignId) ?? 0) + 1;
    worldVersionByCampaign.set(campaignId, next);
    snapshotCacheByCampaign.delete(campaignId);
    const store = chunkStoreByCampaign.get(campaignId);
    if (store) store.bumpWorldVersion();
    return next;
}

function ensureChunkStore(campaignId, settings, controls, hardened) {
    const existing = chunkStoreByCampaign.get(campaignId);
    if (existing
        && existing.worldSeed === settings.worldSeed
        && existing.climateGradient === settings.climateGradient) {
        existing.setControls(controls);
        existing.hardened = hardened;
        return existing;
    }
    const store = new ChunkStore(settings.worldSeed, settings.climateGradient, controls, hardened);
    chunkStoreByCampaign.set(campaignId, store);
    return store;
}

// ── WO 6.1 — click-to-travel route computation ────────────────────────────
//
// The mod owns the pathfinder and the chunk store, so the route is computed
// here. The host owns the departure sentence and the pending intent, so the
// commit is reported via `mod.worldmap.travelRequest` and the host listener
// translates it into a `composeDeparture` call. This keeps the sentence
// byte-identical across all three entry points (map, Places, composer).

/**
 * Map a WO 3 travel mode to the WO 6.0 pathfinder mode. `horseback` → `mount`;
 * `flying` → `null` (straight-line route, no terrain awareness). The
 * pathfinder's modes are the authority on terrain impassability; WO 3's modes
 * are the authority on the departure sentence and leg count.
 */
function modeToPathfinder(mode) {
    if (mode === 'foot') return 'foot';
    if (mode === 'cart') return 'cart';
    if (mode === 'horseback') return 'mount';
    return null; // flying — handled as a straight-line route
}

/**
 * Compute a straight-line (octile) route between two cells, for `flying` mode.
 * No terrain awareness, no impassable cells — flying goes everywhere. The
 * cost is the octile distance (≈ cell count); days derived from WO 3's flying
 * speed (20 grids/day).
 */
function straightLineRoute(from, to) {
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    const cost = Math.abs(dx - dy) + Math.SQRT2 * Math.min(dx, dy);
    const days = Math.max(1, Math.ceil(cost / 20)); // flying: 20 grids/day
    // Build the cell list as a Bresen line so the renderer has a polyline.
    const cells = [];
    let x = from.x, y = from.y;
    const sx = to.x > from.x ? 1 : to.x < from.x ? -1 : 0;
    const sy = to.y > from.y ? 1 : to.y < from.y ? -1 : 0;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    for (let i = 0; i <= steps; i += 1) {
        cells.push({ x, y });
        if (i < steps) { x += sx; y += sy; }
    }
    return { cells, cost, days };
}

/**
 * Find the nearest anchor within `radius` cells of `(x, y)`. Returns the
 * anchor object or `null`. WO 6.1 §1 — a click on a cell with no anchor
 * within 2 cells snaps to the nearest anchor or refuses; it never invents a
 * destination.
 */
function nearestAnchor(anchors, x, y, radius) {
    let best = null;
    let bestDist = radius + 1;
    for (const anchor of anchors) {
        if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) continue;
        const d = Math.max(Math.abs(anchor.x - x), Math.abs(anchor.y - y));
        if (d <= radius && d < bestDist) {
            bestDist = d;
            best = anchor;
        }
    }
    return best;
}

/**
 * BFS over the ledger's connection graph to find a path from `fromId` to
 * `toId` through intermediate places. Returns an array of place ids
 * `[fromId, ..., toId]` or `null` when no path exists. Transit nodes
 * (`kind: 'transit'`) are excluded — they are roads, not destinations, and
 * routing through them would double-count the road.
 */
function findLedgerPath(ledger, fromId, toId) {
    if (fromId === toId) return [fromId];
    const byId = new Map(ledger.map(l => [l.id, l]));
    const queue = [[fromId]];
    const visited = new Set([fromId]);
    while (queue.length > 0) {
        const path = queue.shift();
        const node = byId.get(path[path.length - 1]);
        if (!node) continue;
        for (const conn of node.connections) {
            const next = byId.get(conn.toId);
            if (!next) continue;
            if (next.kind === 'transit') continue;
            if (visited.has(conn.toId)) continue;
            visited.add(conn.toId);
            const newPath = [...path, conn.toId];
            if (conn.toId === toId) return newPath;
            queue.push(newPath);
        }
    }
    return null;
}

/**
 * Compute a route preview for a click on cell `(toX, toY)`. Snaps to the
 * nearest anchor within `ANCHOR_SNAP_RADIUS` cells; if none, refuses with a
 * blocked preview. Routes from the current place's anchor to the snapped
 * anchor via the pathfinder (single hop if directly connected, multi-hop
 * through the ledger graph otherwise). Each hop is terrain-priced.
 *
 * Returns a preview object shaped for the renderer's `getRoutePreview`:
 *   { cells, cost, days, mode, blocked?, fromAnchor, toAnchor, cellCount, hops }
 * `hops` is the per-hop breakdown for the host's `composeDeparture`/intent.
 */
function computeRoutePreview(ctx, campaignId, toX, toY, mode) {
    const result = reportsByCampaign.get(campaignId);
    if (!result) return { blocked: true, reason: 'no-solve', label: 'No map solve yet' };
    const anchors = result.anchors || [];
    const ledger = ctx.data?.location?.ledger ?? [];
    const fromId = ctx.data?.location?.currentPlaceId ?? null;
    if (!fromId) return { blocked: true, reason: 'no-current-place', label: 'No current place — set one in the Places panel' };

    const fromAnchor = anchors.find(a => a.locationId === fromId);
    if (!fromAnchor || !Number.isFinite(fromAnchor.x) || !Number.isFinite(fromAnchor.y)) {
        return { blocked: true, reason: 'no-current-anchor', label: 'Current place has no map anchor' };
    }

    // Snap the click to the nearest anchor within radius. If the click is on
    // an anchor's exact cell, that anchor is the destination. Otherwise snap.
    const toAnchor = nearestAnchor(anchors, toX, toY, ANCHOR_SNAP_RADIUS);
    if (!toAnchor) {
        return { blocked: true, reason: 'no-anchor-near', label: 'No place within 2 cells — click a place to travel' };
    }
    if (toAnchor.locationId === fromId) {
        return { blocked: true, reason: 'same-place', label: 'Already here' };
    }

    const settings = result.settings;
    const controls = buildWarpField(result.transects || []);
    const hardened = hardenedByCampaign.get(campaignId) ?? new Map();
    const chunkStore = ensureChunkStore(campaignId, settings, controls, hardened);

    // Find the ledger path (A→B→C). Single-hop if directly connected.
    const ledgerPath = findLedgerPath(ledger, fromId, toAnchor.locationId);
    if (!ledgerPath || ledgerPath.length < 2) {
        // No ledger path — the destination is not reachable through known
        // connections. This is a blocked result, not an error: the player
        // clicked a place they have no road to.
        return { blocked: true, reason: 'no-ledger-path', label: 'No road to this place — add a connection in the Places panel' };
    }

    // Route each hop through the pathfinder. Each hop's cells are concatenated
    // (skipping the first cell of hops after the first, since it's the
    // previous hop's last cell). Cost and days accumulate.
    const pfMode = modeToPathfinder(mode);
    const hopResults = [];
    let totalCost = 0;
    let totalDays = 0;
    let allCells = [];
    let blockedByPathfinder = null;
    for (let i = 0; i < ledgerPath.length - 1; i += 1) {
        const hopFromId = ledgerPath[i];
        const hopToId = ledgerPath[i + 1];
        const hopFromAnchor = anchors.find(a => a.locationId === hopFromId);
        const hopToAnchor = anchors.find(a => a.locationId === hopToId);
        if (!hopFromAnchor || !hopToAnchor) {
            blockedByPathfinder = { reason: 'no-anchor', label: `Place ${hopFromId} or ${hopToId} has no anchor` };
            break;
        }
        let route;
        if (pfMode === null) {
            // Flying — straight line, no terrain.
            route = straightLineRoute(
                { x: Math.round(hopFromAnchor.x), y: Math.round(hopFromAnchor.y) },
                { x: Math.round(hopToAnchor.x), y: Math.round(hopToAnchor.y) },
            );
        } else {
            route = findRoute(
                chunkStore,
                { x: hopFromAnchor.x, y: hopFromAnchor.y },
                { x: hopToAnchor.x, y: hopToAnchor.y },
                pfMode,
            );
        }
        if (route.blocked) {
            // WO 6.1 §1 — a blocked route is a real answer. Surface the
            // reason and the mode(s) that would work.
            blockedByPathfinder = {
                reason: route.reason,
                label: blockedLabel(route.reason, mode, chunkStore, hopFromAnchor, hopToAnchor),
            };
            break;
        }
        // Compute terrain-real leg count (≡ days) for this hop under WO 3's
        // speed model. The pathfinder's `days` uses the pathfinder's speed;
        // we re-derive under WO 3's gridsPerDay so the leg count matches the
        // travel loop.
        const gridsPerDay = gridsPerDayForMode(mode);
        const hopLegs = Math.max(1, Math.ceil(route.cost / (pfMode !== null ? pathfinderMultiplier(pfMode) : 1) / gridsPerDay));
        hopResults.push({
            fromId: hopFromId,
            toId: hopToId,
            legs: hopLegs,
            cells: route.cells,
            cost: route.cost,
        });
        totalCost += route.cost;
        totalDays += hopLegs;
        if (allCells.length === 0) {
            allCells = route.cells.slice();
        } else {
            allCells = allCells.concat(route.cells.slice(1));
        }
    }

    if (blockedByPathfinder) {
        const toName = ledger.find(l => l.id === toAnchor.locationId)?.name ?? toAnchor.locationId;
        return {
            cells: allCells,
            cost: totalCost,
            days: totalDays,
            mode,
            blocked: blockedByPathfinder,
            fromAnchor: { locationId: fromAnchor.locationId, name: ledger.find(l => l.id === fromId)?.name ?? fromId },
            toAnchor: { locationId: toAnchor.locationId, name: toName },
            cellCount: Math.max(0, allCells.length - 1),
        };
    }

    const toName = ledger.find(l => l.id === toAnchor.locationId)?.name ?? toAnchor.locationId;
    const fromName = ledger.find(l => l.id === fromId)?.name ?? fromId;
    // `hops` is the per-hop breakdown for the host's intent. Only the hops
    // after the first leg matter to the host (the first hop is the depart);
    // but the host needs all hops to create transit nodes per hop.
    const hops = hopResults.map(h => ({ fromId: h.fromId, toId: h.toId, transitId: '', legs: h.legs }));
    return {
        cells: allCells,
        cost: totalCost,
        days: totalDays,
        mode,
        fromAnchor: { locationId: fromAnchor.locationId, name: fromName },
        toAnchor: { locationId: toAnchor.locationId, name: toName },
        cellCount: Math.max(0, allCells.length - 1),
        hops,
    };
}

/** WO 3 `gridsPerDay` for a mode, mirrored from `travelModes.ts`. */
function gridsPerDayForMode(mode) {
    if (mode === 'foot') return 3;
    if (mode === 'cart') return 5;
    if (mode === 'horseback') return 8;
    if (mode === 'flying') return 20;
    return 3;
}

/** The pathfinder's per-mode multiplier, mirrored from `pathfinder.js:56`. */
function pathfinderMultiplier(pfMode) {
    if (pfMode === 'foot') return 1.0;
    if (pfMode === 'mount') return 0.7;
    if (pfMode === 'cart') return 0.6;
    if (pfMode === 'boat') return 1.0;
    return 1.0;
}

/** Build a human-readable blocked label for a pathfinder `blocked` result. */
function blockedLabel(reason, mode, chunkStore, fromAnchor, toAnchor) {
    if (reason === 'no-route') {
        // Offer the modes that can make it. WO 6.1 §1: "offers the modes that
        // can make it. A cart that cannot cross a pass is the feature working."
        const tryModes = ['foot', 'horseback', 'flying'];
        const working = [];
        for (const altMode of tryModes) {
            if (altMode === mode) continue;
            const pfAlt = modeToPathfinder(altMode);
            if (pfAlt === null) { working.push(altMode); continue; }
            const r = findRoute(chunkStore, { x: fromAnchor.x, y: fromAnchor.y }, { x: toAnchor.x, y: toAnchor.y }, pfAlt, { exploredCap: 5000 });
            if (!r.blocked) working.push(altMode);
        }
        const modeWord = mode === 'horseback' ? 'horseback' : mode;
        const tail = working.length > 0 ? ` — try ${working.join(', ')}` : '';
        return `no route by ${modeWord}${tail}`;
    }
    if (reason === 'search-exhausted') return 'route too long to search — try a closer destination';
    if (reason === 'endpoint-impassable') return `destination impassable by ${mode}`;
    if (reason === 'same-cell') return 'already there';
    if (reason === 'unknown-mode') return 'unknown travel mode';
    return `no route by ${mode}`;
}

function publishResult(campaignId, result, settings) {
    reportsByCampaign.set(campaignId, { ...result, settings });
    bumpWorldVersion(campaignId);
    for (const listener of reportListeners) listener(campaignId);
    for (const listener of mapPaintListeners) listener(campaignId);
}

async function readHardened(ctx) {
    const fresh = await freshCampaignContext(ctx);
    if (!fresh) return new Map();
    const rows = await fresh.table.read('visited');
    return deserializeHardened(Array.isArray(rows) ? rows : []);
}

async function writeHardened(ctx, hardened) {
    const fresh = await freshCampaignContext(ctx);
    if (!fresh) return;
    const campaignId = fresh.data.campaignId;
    await fresh.table.write('visited', serializeHardened(hardened));
    hardenedByCampaign.set(campaignId, hardened);
    bumpWorldVersion(campaignId);
    for (const listener of mapPaintListeners) listener(campaignId);
}

/**
 * Harden the cell under the current location. A cell the party has occupied
 * is frozen — recorded in a mod table, and no future anchor may alter it.
 * The solver treats hardened cells as additional hard constraints.
 */
async function hardenCurrentCell(ctx) {
    const fresh = await freshCampaignContext(ctx);
    if (!fresh) return null;
    const campaignId = fresh.data.campaignId;
    const placeId = fresh.data.location?.currentPlaceId;
    const ledger = fresh.data.location?.ledger ?? [];
    const anchor = (reportsByCampaign.get(campaignId)?.anchors ?? [])
        .find(candidate => candidate.locationId === placeId);
    if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return null;
    const settings = reportsByCampaign.get(campaignId)?.settings;
    if (!settings) return null;
    const existing = hardenedByCampaign.get(campaignId) ?? await readHardened(fresh);
    const controls = buildWarpField(reportsByCampaign.get(campaignId)?.transects ?? []);
    const result = biomeAt(anchor.x, anchor.y, settings.worldSeed, settings.climateGradient, controls, existing);
    if (result.hardened) return existing;
    const next = hardenCell(anchor.x, anchor.y, result.biome, existing);
    await writeHardened(fresh, next);
    return next;
}

async function freshCampaignContext(ctx) {
    if (!ctx) return null;
    const fresh = typeof ctx.refresh === 'function' ? await ctx.refresh() : ctx;
    return fresh?.data?.campaignId ? fresh : null;
}

export async function solveAndPersist(ctx) {
    const fresh = await freshCampaignContext(ctx);
    if (!fresh) return null;
    const campaignId = fresh.data.campaignId;
    const settings = await ensureSettings(fresh);
    const rawAnchors = await fresh.table.read('anchors');
    const existingAnchors = Array.isArray(rawAnchors) ? rawAnchors : [];
    const hardened = hardenedByCampaign.get(campaignId) ?? await readHardened(fresh);
    // WO 4.1 §5 — terrain-aware placement reads cells via `ChunkStore`. The
    // store needs warp controls; on the first solve there are none, so the
    // field is the raw noise. On a re-solve the previous transects bend it.
    // Implicit terrain clauses appended this pass land in `result.transects`
    // and bend the field on the *next* solve — the standard iterative
    // refinement, and exactly what "the field bends to accommodate the
    // place" calls for.
    const previousTransects = reportsByCampaign.get(campaignId)?.transects ?? [];
    const previousControls = buildWarpField(previousTransects);
    const terrainChunkStore = ensureChunkStore(campaignId, settings, previousControls, hardened);
    const result = solveWorldMap({
        locations: fresh.data.location?.ledger ?? [],
        loreChunks: fresh.data.loreChunks ?? [],
        existingAnchors,
        worldSeed: settings.worldSeed,
        hardenedCells: hardened,
        chunkStore: terrainChunkStore,
    });

    // A campaign can change while table I/O is in flight. Confirm the lease
    // before writing so an old campaign's solve never lands in the new file.
    const confirm = await freshCampaignContext(fresh);
    if (!confirm || confirm.data.campaignId !== campaignId) return null;
    await confirm.table.write('anchors', result.anchors);
    publishResult(campaignId, result, settings);
    return result;
}

function queueSolve(ctx) {
    solveQueue = solveQueue
        .then(() => solveAndPersist(ctx))
        .catch(error => ctx?.log?.('[worldmap] solve failed', error));
    return solveQueue;
}

function applyStyle(node, styles) {
    Object.assign(node.style, styles);
    return node;
}

function makeElement(tag, text, styles = {}) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return applyStyle(node, styles);
}

function paintReport(node, ctx, campaignId = ctx.data.campaignId) {
    node.replaceChildren();
    applyStyle(node, {
        boxSizing: 'border-box',
        height: '100%',
        overflow: 'auto',
        padding: '18px',
        color: 'var(--text-primary, inherit)',
        background: 'var(--background-primary, transparent)',
        fontFamily: 'inherit',
    });

    const result = campaignId ? reportsByCampaign.get(campaignId) : null;
    node.append(makeElement('h2', 'World Map solve report', { margin: '0 0 6px', fontSize: '18px' }));
    node.append(makeElement(
        'p',
        result
            ? `Seed ${result.settings.worldSeed} · climate gradient ${result.settings.climateGradient}`
            : campaignId
                ? 'No solve has completed for this campaign yet.'
                : 'Open a campaign to solve its locations.',
        { margin: '0 0 14px', opacity: '0.72', fontSize: '12px', overflowWrap: 'anywhere' },
    ));

    const button = makeElement('button', result ? 'Re-solve from lore' : 'Solve now', {
        padding: '7px 11px',
        marginBottom: '14px',
        border: '1px solid var(--border-primary, currentColor)',
        borderRadius: '6px',
        background: 'var(--background-secondary, transparent)',
        color: 'inherit',
        cursor: campaignId ? 'pointer' : 'not-allowed',
    });
    button.disabled = !campaignId;
    const onClick = async () => {
        const idleLabel = button.textContent;
        button.disabled = true;
        button.textContent = 'Solving…';
        try {
            await queueSolve(ctx);
        } finally {
            // Restore the control unconditionally. The repaint below normally
            // replaces this button wholesale, but it is skipped when the node
            // has been detached, and without this finally the panel was left
            // disabled and stuck on the solving label with no way back.
            button.disabled = !campaignId;
            button.textContent = idleLabel;
        }
        if (node.isConnected) paintReport(node, ctx, campaignId);
    };
    button.addEventListener('click', onClick);
    node.append(button);

    if (!result) return () => button.removeEventListener('click', onClick);

    const report = makeElement('pre', result.report.text, {
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        margin: '0 0 18px',
        padding: '12px',
        border: '1px solid var(--border-primary, currentColor)',
        borderRadius: '7px',
        background: 'var(--background-secondary, transparent)',
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: '12px',
        lineHeight: '1.55',
    });
    node.append(report);

    const table = makeElement('table', undefined, { width: '100%', borderCollapse: 'collapse', fontSize: '12px' });
    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Place', 'X', 'Y', 'Source']) {
        headRow.append(makeElement('th', label, { textAlign: 'left', padding: '6px', borderBottom: '1px solid var(--border-primary, currentColor)' }));
    }
    head.append(headRow);
    table.append(head);
    const body = document.createElement('tbody');
    for (const entry of result.report.entries) {
        const anchor = result.anchors.find(candidate => candidate.locationId === entry.locationId);
        const row = document.createElement('tr');
        for (const value of [entry.name, anchor?.x ?? '—', anchor?.y ?? '—', anchor?.source ?? '—']) {
            row.append(makeElement('td', String(value), { padding: '6px', borderBottom: '1px solid color-mix(in srgb, currentColor 18%, transparent)' }));
        }
        body.append(row);
    }
    table.append(body);
    node.append(table);

    return () => button.removeEventListener('click', onClick);
}

function mountReport(node, ctx) {
    let currentCampaignId = ctx.data.campaignId;
    let cleanupPaint = paintReport(node, ctx, currentCampaignId);

    // `ctx.data` is a frozen snapshot taken when this context was built. For a
    // window registered from `activate` that is cold start — before any campaign
    // is open — so `campaignId` is null forever and the Solve button stays
    // disabled. Re-read it live on mount, the same way `hardenCurrentCell` does.
    // `subscribe` alone cannot cover this: it fires on *change*, and a campaign
    // opened before this window was opened never changes again.
    let disposed = false;
    freshCampaignContext(ctx).then(fresh => {
        const campaignId = fresh?.data.campaignId ?? null;
        if (disposed || campaignId === currentCampaignId) return;
        currentCampaignId = campaignId;
        cleanupPaint?.();
        cleanupPaint = paintReport(node, ctx, currentCampaignId);
    });

    const repaint = campaignId => {
        if (campaignId !== currentCampaignId) return;
        cleanupPaint?.();
        cleanupPaint = paintReport(node, ctx, currentCampaignId);
    };
    reportListeners.add(repaint);
    const unsubscribeCampaign = ctx.subscribe('campaignId', campaignId => {
        currentCampaignId = campaignId;
        cleanupPaint?.();
        cleanupPaint = paintReport(node, ctx, currentCampaignId);
    });
    const unsubscribeAnchors = ctx.table.subscribe('anchors', () => repaint(currentCampaignId));
    return () => {
        cleanupPaint?.();
        unsubscribeCampaign();
        unsubscribeAnchors();
        disposed = true;
        reportListeners.delete(repaint);
        node.replaceChildren();
    };
}

function registerReportWindow(ctx) {
    const reportWindow = ctx.mounts.window({
        id: 'solve-report',
        title: 'World Map · Solve Report',
        defaultSize: { width: 760, height: 560 },
        minSize: { width: 440, height: 320 },
        resizable: true,
        mount: mountReport,
    });
    ctx.mounts.header({
        id: 'open-report',
        icon: 'MapPinned',
        label: 'World Map Report',
        tooltip: 'Open the World Map anchor solve report',
        onSelect: () => reportWindow.open(),
    });
}

/**
 * Build the snapshot the renderer reads. Memoised against `worldVersion`: two
 * calls with no intervening world change return the *same object identity*
 * (WORKORDER 5.3 §7), so the renderer's `terrainKey`/`getSnapshot` hot path
 * becomes an integer compare instead of a `JSON.stringify` over every
 * transect on every paint.
 *
 * The location ledger is indexed into a `Map` once per snapshot instead of
 * the old O(anchors × ledger) `.find()` per anchor.
 *
 * Exported for the renderer-invariant test (`worldMapRenderer.test.js`) so the
 * `getSnapshot()` identity contract (§11) can be asserted against the real
 * memoisation, not a simulation of it.
 */
export function mapSnapshot(ctx) {
    const campaignId = ctx.data?.campaignId;
    const result = campaignId ? reportsByCampaign.get(campaignId) : null;
    if (!result) return null;
    const version = worldVersion(campaignId);
    const cached = snapshotCacheByCampaign.get(campaignId);
    if (cached && cached.worldVersion === version) return cached.snapshot;

    const hardened = hardenedByCampaign.get(campaignId) ?? new Map();
    const ledger = ctx.data?.location?.ledger ?? [];
    const ledgerById = new Map(ledger.map(entry => [entry.id, entry]));
    const anchors = (result.anchors || []).map(anchor => {
        const location = ledgerById.get(anchor.locationId);
        return { ...anchor, name: location?.name ?? anchor.locationId };
    });
    const controls = buildWarpField(result.transects || []);
    const chunkStore = ensureChunkStore(campaignId, result.settings, controls, hardened);
    const snapshot = {
        anchors,
        transects: result.transects || [],
        connections: result.connections || [],
        waypoints: result.waypoints || [],
        settings: result.settings,
        hardened,
        locationId: ctx.data?.location?.currentPlaceId ?? null,
        worldVersion: version,
        chunkStore,
        controls,
    };
    snapshotCacheByCampaign.set(campaignId, { snapshot, worldVersion: version });
    return snapshot;
}

function mountMap(node, ctx) {
    let cleanupRenderer = null;
    // See the note in `mountReport`: `ctx.data` is a snapshot from activate-time
    // cold start. `liveCtx` is swapped for a freshly-read context on mount, which
    // is what makes place names and the current place resolve at all.
    let liveCtx = ctx;
    let currentCampaignId = ctx.data.campaignId;

    // WO 6.1 — the route preview is re-rendered on every paint via
    // `getRoutePreview`. The renderer reads it from the per-campaign map. A
    // paint listener fires when the preview changes so the renderer repaints.
    function refreshPreview() {
        for (const listener of mapPaintListeners) listener(currentCampaignId);
    }

    const handleRouteAction = (action, payload) => {
        if (action === 'cancel') {
            routePreviewByCampaign.delete(currentCampaignId);
            refreshPreview();
            return;
        }
        if (action === 'setMode') {
            currentTravelMode = String(payload || 'foot');
            // Re-route with the new mode if there's a pending click target.
            const preview = routePreviewByCampaign.get(currentCampaignId);
            if (preview && preview._clickCell) {
                const recomputed = computeRoutePreview(liveCtx, currentCampaignId, preview._clickCell.x, preview._clickCell.y, currentTravelMode);
                recomputed._clickCell = preview._clickCell;
                routePreviewByCampaign.set(currentCampaignId, recomputed);
                refreshPreview();
            }
            return;
        }
        if (action === 'commit') {
            const preview = routePreviewByCampaign.get(currentCampaignId);
            if (!preview || preview.blocked) return;
            // WO 6.1 §1 — commit emits `mod.worldmap.travelRequest` for the
            // host listener. The host owns the departure sentence and the
            // pending intent (via `composeDeparture`), so the sentence stays
            // byte-identical across all three entry points.
            const fromId = preview.fromAnchor?.locationId ?? null;
            const toId = preview.toAnchor?.locationId ?? null;
            if (!fromId || !toId) return;
            ctx.events?.emit('travelRequest', {
                fromId,
                toId,
                mode: preview.mode,
                hops: preview.hops || [],
            });
            routePreviewByCampaign.delete(currentCampaignId);
            refreshPreview();
            return;
        }
    };

    const handleClickCell = (x, y) => {
        const snapshot = mapSnapshot(liveCtx);
        if (!snapshot) return;
        // Read the current travel mode from the host context if available,
        // falling back to the selector's last value.
        const ctxMode = liveCtx.data?.location?.currentPlaceId ? currentTravelMode : currentTravelMode;
        const preview = computeRoutePreview(liveCtx, currentCampaignId, x, y, ctxMode);
        preview._clickCell = { x, y };
        routePreviewByCampaign.set(currentCampaignId, preview);
        refreshPreview();
    };

    const getRoutePreview = () => {
        const p = routePreviewByCampaign.get(currentCampaignId);
        if (!p) return null;
        // Strip the internal `_clickCell` before handing to the renderer.
        const { _clickCell, ...rest } = p;
        return rest;
    };

    const getTravelMode = () => currentTravelMode;

    const render = () => {
        if (cleanupRenderer) { cleanupRenderer(); cleanupRenderer = null; }
        const snapshot = () => mapSnapshot(liveCtx);
        if (!snapshot()) {
            node.replaceChildren();
            const placeholder = makeElement('p', 'No solve has completed for this campaign yet.', {
                padding: '18px', opacity: '0.72', fontSize: '12px',
            });
            node.append(placeholder);
            return;
        }
        // Sync the selector's mode from the host context on (re)mount.
        const ctxMode = liveCtx.data?.context?.travelMode;
        if (ctxMode && typeof ctxMode === 'string') currentTravelMode = ctxMode;
        cleanupRenderer = mountMapRenderer(node, {
            getSnapshot: snapshot,
            // WO 4.2 §2 — the renderer now calls `onDragAnchor` exactly once
            // per drag, on pointer-up. The read-modify-write + queueSolve is
            // serialised through `solveQueue` so the commit cannot interleave
            // with a `solveAndPersist` write. No second queue — the existing
            // chain owns both.
            onDragAnchor: async (locationId, x, y) => {
                solveQueue = solveQueue
                    .then(async () => {
                        const fresh = await freshCampaignContext(ctx);
                        if (!fresh || fresh.data.campaignId !== currentCampaignId) return;
                        const rows = await fresh.table.read('anchors');
                        const next = (Array.isArray(rows) ? rows : []).map(anchor =>
                            anchor.locationId === locationId
                                ? { ...anchor, x, y, pinned: true, source: 'player' }
                                : anchor);
                        await fresh.table.write('anchors', next);
                    })
                    .then(() => queueSolve(ctx))
                    .catch(error => ctx?.log?.('[worldmap] drag commit failed', error));
            },
            onClickCell: handleClickCell,
            onRouteAction: handleRouteAction,
            getRoutePreview,
            getTravelMode,
            travelModes: MAP_TRAVEL_MODES,
            log: (...args) => ctx?.log?.('[worldmap:map]', ...args),
        });
    };
    const repaint = campaignId => {
        if (campaignId !== currentCampaignId) return;
        render();
    };
    mapPaintListeners.add(repaint);
    const unsubscribeCampaign = ctx.subscribe('campaignId', campaignId => {
        currentCampaignId = campaignId;
        render();
    });
    const unsubscribeAnchors = ctx.table.subscribe('anchors', () => repaint(currentCampaignId));
    const unsubscribeVisited = ctx.table.subscribe('visited', async () => {
        hardenedByCampaign.set(currentCampaignId, await readHardened(ctx));
        repaint(currentCampaignId);
    });
    let disposed = false;
    freshCampaignContext(ctx).then(async fresh => {
        if (disposed || !fresh) return;
        liveCtx = fresh;
        currentCampaignId = fresh.data.campaignId;
        hardenedByCampaign.set(currentCampaignId, await readHardened(fresh));
        if (!disposed) render();
    });
    return () => {
        disposed = true;
        if (cleanupRenderer) { cleanupRenderer(); cleanupRenderer = null; }
        mapPaintListeners.delete(repaint);
        unsubscribeCampaign();
        unsubscribeAnchors();
        unsubscribeVisited();
        node.replaceChildren();
    };
}

function registerMapWindow(ctx) {
    const mapWindow = ctx.mounts.window({
        id: 'map-canvas',
        title: 'World Map',
        defaultSize: { width: 900, height: 640 },
        minSize: { width: 360, height: 280 },
        resizable: true,
        mount: mountMap,
    });
    ctx.mounts.header({
        id: 'open-map',
        icon: 'Map',
        label: 'World Map',
        tooltip: 'Open the World Map canvas',
        onSelect: () => mapWindow.open(),
    });
}

/** Generate the per-campaign seed on first install when a campaign is open. */
export async function onInstall(ctx) {
    const fresh = await freshCampaignContext(ctx);
    if (fresh) await ensureSettings(fresh);
}

/** Mount the report and keep solved anchors in sync with lore and topology. */
export async function onActivate(ctx) {
    if (!ctx) return;
    registerReportWindow(ctx);
    registerMapWindow(ctx);
    ctx.subscribe('location', () => {
        queueSolve(ctx).then(() => hardenCurrentCell(ctx));
    });
    ctx.subscribe('loreChunks', () => queueSolve(ctx));
    ctx.events?.on('campaign.opened', async () => {
        const fresh = await freshCampaignContext(ctx);
        if (fresh) hardenedByCampaign.set(fresh.data.campaignId, await readHardened(fresh));
        queueSolve(ctx);
    });
    await queueSolve(ctx);
    const initial = await freshCampaignContext(ctx);
    if (initial) {
        hardenedByCampaign.set(initial.data.campaignId, await readHardened(initial));
        await hardenCurrentCell(initial);
    }
}

