import { reconcilePlaceRecords, isTemporaryPlace } from './placeRecords.js';
import { readRoads, serializeRoads, roadEdges, travelSurfaces, planRoad, roadCandidates, roadConnectedLedger } from './roads.js';
import { readExploration, readGeneratedCells, serializeExploration, revealCells, visibleCells, explorationPoint, validCell } from './exploration.js';
import { worldProfile } from './worldProfiles.js';
import { checkpointKey, readEncounters, serializeEncounters, recordCheckpoint, handleEncounter, noteEncounter, setEncounterFlags } from './encounters.js';
import { fixedSiteAnchors, promoteSite, preferSiteStops } from './siteTravel.js';
import { readDiscoveries, serializeDiscoveries, surveyDiscoveries, nearbyDiscoveries, nameDiscovery, siteLabel } from './discoveries.js';
import { readTrails, serializeTrails, recordTrailProgress } from './trails.js';
import { solveWorldMap } from './solver.js';
import { mountMapRenderer, normaliseLayerSettings } from './renderer.js';
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
const DEFAULT_LAYERS = Object.freeze({ grid: false, roads: true, labels: true });
const reportsByCampaign = new Map();
const reportListeners = new Set();
const mapPaintListeners = new Set();
const hardenedByCampaign = new Map();
const chunkStoreByCampaign = new Map();
const worldVersionByCampaign = new Map();
const snapshotCacheByCampaign = new Map();
let solveQueue = Promise.resolve();
let settingsWriteQueue = Promise.resolve();

// WO 6.2 — the committed journey, per campaign. The mod owns the journey's
// geometry (which cells, which checkpoints, on which terrain); the host owns
// the journey's state (leg, totalLegs, worldDay, and when it ends). This
// record is written at commit — BEFORE the `travelRequest` emit, so the
// record and the departure cannot disagree (WO 6.2 §1) — and cleared when
// `context.travel` goes null (the §4 trigger: arrive, halt, or campaign
// switch all manifest as `travel` becoming null, so watch the state, not the
// transition). `null` when no journey is in progress, mirroring `settings`.
const journeyByCampaign = new Map();
const positionByCampaign = new Map();
const trailsByCampaign = new Map();
const roadsByCampaign = new Map();
const roadEditorsByCampaign = new Map();
function surfacesFor(campaignId) { return travelSurfaces(trailsByCampaign.get(campaignId), roadsByCampaign.get(campaignId) ?? []); }
const discoveriesByCampaign = new Map();
const explorationByCampaign = new Map();
const generatedByCampaign = new Map();
const discoveryContextByCampaign = new Map();
const encountersByCampaign = new Map();
const encounterContextByCampaign = new Map();
let encounterQueue = Promise.resolve();
const routePreferenceByCampaign = new Map();
let movementQueue = Promise.resolve();

// Coordinates belong to the occupied place, so arrival or an explicit place
// change cannot reuse a camp left behind on an earlier journey.
export function stoppedCell(position, location) {
    if (!position || position.placeId !== location?.currentPlaceId) return null;
    if (!Number.isSafeInteger(position.x) || !Number.isSafeInteger(position.y)) return null;
    return { x: position.x, y: position.y };
}

async function hydratePosition(ctx) {
    roadsByCampaign.set(ctx.data.campaignId, readRoads(await ctx.table.read('roads')));
    const savedExploration = await ctx.table.read('exploration');
    explorationByCampaign.set(ctx.data.campaignId, readExploration(savedExploration));
    generatedByCampaign.set(ctx.data.campaignId, readGeneratedCells(savedExploration));
    encountersByCampaign.set(ctx.data.campaignId, readEncounters(await ctx.table.read('encounters')));
    encounterContextByCampaign.delete(ctx.data.campaignId);
    discoveriesByCampaign.set(ctx.data.campaignId, readDiscoveries(await ctx.table.read('discoveries')));
    discoveryContextByCampaign.delete(ctx.data.campaignId);
    const trails = readTrails(await ctx.table.read('trails'));
    trailsByCampaign.set(ctx.data.campaignId, trails);
    if (!Array.isArray(savedExploration?.cells) && trails.edges.size) {
        const explored = explorationByCampaign.get(ctx.data.campaignId);
        revealCells(explored, [...trails.edges.values()].flatMap(edge => [edge.a, edge.b]));
        await ctx.table.write('exploration', serializeExploration(explored, generatedByCampaign.get(ctx.data.campaignId)));
    }
    const position = await ctx.table.read('position');
    positionByCampaign.set(ctx.data.campaignId, position);
    snapshotCacheByCampaign.delete(ctx.data.campaignId);
}

async function updateEncounters(ctx, centre, snapshot, feature) {
    const location = ctx.data.location;
    if (!Number.isFinite(location.worldDay)) return;
    const campaignId = ctx.data.campaignId;
    const input = { worldProfile: worldProfile(snapshot.settings.worldProfile).id, seed: snapshot.settings.worldSeed, x: centre.x, y: centre.y,
        worldDay: location.worldDay, biome: snapshot.chunkStore.getCell(centre.x, centre.y).biome, feature,
        onRoad: [...(surfacesFor(campaignId).edges.values())].some(edge => edge.passes >= 2
            && [edge.a, edge.b].some(cell => cell.x === centre.x && cell.y === centre.y)) };
    const task = encounterQueue.then(async () => {
        const result = recordCheckpoint(encountersByCampaign.get(campaignId) ?? new Map(), input);
        if (result.changed) {
            await ctx.table.write('encounters', serializeEncounters(result.records));
            encountersByCampaign.set(campaignId, result.records);
            snapshotCacheByCampaign.delete(campaignId);
            for (const listener of mapPaintListeners) listener(campaignId);
        }
        return result.record;
    });
    encounterQueue = task.catch(error => ctx.log?.('[worldmap] encounter save failed', error));
    const record = await task;
    const live = await freshCampaignContext(ctx);
    if (!live || live.data.campaignId !== campaignId || live.data.location?.currentPlaceId !== location.currentPlaceId
        || live.data.location?.worldDay !== location.worldDay
        || (live.data.location?.travel?.leg ?? null) !== (location.travel?.leg ?? null)) return;
    const summary = { ...record, placeId: location.currentPlaceId, leg: location.travel?.leg ?? null };
    const profile = worldProfile(snapshot.settings.worldProfile);
    const digest = JSON.stringify([summary, profile]);
    if (encounterContextByCampaign.get(campaignId) !== digest && live.write?.updateContext) {
        encounterContextByCampaign.set(campaignId, digest);
        live.write.updateContext({ mapEncounter: summary, mapWorldSetting: profile });
    }
}

async function observeTerrain(ctx, centres) {
    const campaignId = ctx.data.campaignId;
    const snapshot = mapSnapshot(ctx);
    if (!snapshot) return;
    const explored = new Set(explorationByCampaign.get(campaignId) ?? []);
    const exploredChanged = revealCells(explored, centres);
    const generated = new Set(generatedByCampaign.get(campaignId) ?? []);
    const generatedChanged = revealCells(generated, centres);
    const state = discoveriesByCampaign.get(campaignId) ?? readDiscoveries(null);
    const authored = snapshot.anchors.filter(anchor => anchor.kind !== 'transit' && !state.sites.has(anchor.locationId))
        .map(anchor => ({ ...anchor, id: anchor.locationId, type: 'settlement',
            settlementKind: /\bcapital\b/i.test(anchor.name ?? '') ? 'capital' : /\bcity\b/i.test(anchor.name ?? '') ? 'city' : 'town' }));
    let changed = false;
    for (const centre of centres) changed = surveyDiscoveries(state, snapshot.settings.worldSeed, snapshot.chunkStore,
        centre, surfacesFor(campaignId), ctx.data.location.worldDay, authored, snapshot.settings.worldProfile) || changed;
    if (changed) {
        await ctx.table.write('discoveries', serializeDiscoveries(state));
        discoveriesByCampaign.set(campaignId, state);
        snapshotCacheByCampaign.delete(campaignId);
    }
    let hardened = hardenedByCampaign.get(campaignId) ?? await readHardened(ctx);
    const previous = hardened;
    for (const centre of centres) for (const key of visibleCells(centre)) {
        const [x, y] = key.split(',').map(Number);
        hardened = hardenCell(x, y, snapshot.chunkStore.getCell(x, y).biome, hardened);
    }
    if (hardened !== previous) await writeHardened(ctx, hardened);
    // Publish completed generation only after site/empty results and terrain have saved.
    if (exploredChanged || generatedChanged) {
        await ctx.table.write('exploration', serializeExploration(explored, generated));
        explorationByCampaign.set(campaignId, explored);
        generatedByCampaign.set(campaignId, generated);
        snapshotCacheByCampaign.delete(campaignId);
    }
    for (const listener of mapPaintListeners) listener(campaignId);
}

async function updateDiscoveries(ctx) {
    const campaignId = ctx.data.campaignId;
    const snapshot = mapSnapshot(ctx);
    if (!snapshot) return;
    const location = ctx.data.location;
    const records = reconcilePlaceRecords(location.ledger ?? [], snapshot.anchors,
        discoveriesByCampaign.get(campaignId)?.sites.values() ?? []);
    if (records !== location.ledger && ctx.write?.setLocationLedger) await ctx.write.setLocationLedger(records);
    const centre = snapshot.party ?? snapshot.anchors.find(anchor => anchor.locationId === location.currentPlaceId);
    if (!centre) return;
    await observeTerrain(ctx, [centre]);
    const state = discoveriesByCampaign.get(campaignId) ?? readDiscoveries(null);
    let identityChanged = false;
    for (const entry of location.ledger ?? []) {
        const site = state.sites.get(entry.id);
        const name = String(entry.name ?? '').trim().slice(0, 80);
        const description = String(entry.description ?? '').trim().slice(0, 600);
        if (site && (site.name !== name || site.description !== description)) {
            nameDiscovery(state, site.id, name, description); identityChanged = true;
        }
    }
    if (identityChanged) {
        discoveriesByCampaign.set(campaignId, state);
        await ctx.table.write('discoveries', serializeDiscoveries(state));
        let hardened = hardenedByCampaign.get(campaignId) ?? await readHardened(ctx);
        const previous = hardened;
        for (const site of state.sites.values()) if (site.biome) hardened = hardenCell(site.x, site.y, site.biome, hardened);
        if (hardened !== previous) await writeHardened(ctx, hardened);
        snapshotCacheByCampaign.delete(campaignId);
        for (const listener of mapPaintListeners) listener(campaignId);
    }
    const summary = { placeId: location.currentPlaceId, worldDay: location.worldDay,
        leg: location.travel?.leg ?? null,
        sites: nearbyDiscoveries(state, centre).map(site => ({ id: site.id, name: siteLabel(site),
            description: site.description, type: site.type, distance: site.distance })) };
    const digest = JSON.stringify(summary);
    const live = await freshCampaignContext(ctx);
    if (!live || live.data.campaignId !== campaignId
        || live.data.location?.currentPlaceId !== location.currentPlaceId
        || live.data.location?.worldDay !== location.worldDay
        || (live.data.location?.travel?.leg ?? null) !== (location.travel?.leg ?? null)) return;
    if (discoveryContextByCampaign.get(campaignId) !== digest && ctx.write?.updateContext) {
        discoveryContextByCampaign.set(campaignId, digest);
        ctx.write.updateContext({ mapDiscoveries: summary });
    }
    await updateEncounters(ctx, centre, snapshot, nearbyDiscoveries(state, centre)[0]);
}

async function rememberTrails(ctx, journey) {
    if (!journey) return;
    const location = ctx.data.location;
    const cell = partyCellForJourney(journey, location?.travel);
    const arrived = !location?.travel && location?.currentPlaceId === journey.toId
        && location?.worldDay >= journey.startedOnDay + journey.totalLegs;
    const endIndex = arrived ? journey.cells.length - 1
        : cell ? journey.cells.findIndex(c => c.x === cell.x && c.y === cell.y) : -1;
    if (endIndex >= 0) await observeTerrain(ctx, journey.cells.slice(0, endIndex + 1));
    const trails = trailsByCampaign.get(ctx.data.campaignId) ?? readTrails(null);
    if (!recordTrailProgress(trails, journey, endIndex)) return;
    trailsByCampaign.set(ctx.data.campaignId, trails);
    await ctx.table.write('trails', serializeTrails(trails));
    snapshotCacheByCampaign.delete(ctx.data.campaignId);
    for (const listener of mapPaintListeners) listener(ctx.data.campaignId);
}

async function rememberJourneyPosition(ctx) {
    const campaignId = ctx.data.campaignId;
    const location = ctx.data.location;
    const cell = partyCellForJourney(journeyByCampaign.get(campaignId), location?.travel);
    if (!cell || !location.currentPlaceId) return;
    const position = { ...cell, placeId: location.currentPlaceId };
    positionByCampaign.set(campaignId, position);
    snapshotCacheByCampaign.delete(campaignId);
    await ctx.table.write('position', position);
}

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
// Empty grid cells are provisional destinations; they become fixed points only on commit.

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
            worldProfile: worldProfile(raw.worldProfile).id,
            climateGradient: Math.max(0, Math.min(1, raw.climateGradient)),
            layers: normaliseLayerSettings(raw.layers ?? DEFAULT_LAYERS),
        };
    }
    const settings = {
        worldSeed: createWorldSeed(ctx.data.campaignId ?? ''),
        worldProfile: 'fantasy',
        climateGradient: DEFAULT_CLIMATE_GRADIENT,
        layers: { ...DEFAULT_LAYERS },
    };
    await ctx.table.write('settings', settings);
    return settings;
}

function persistLayerSettings(ctx, campaignId, patch) {
    const current = reportsByCampaign.get(campaignId);
    if (!current) return;
    const layers = { ...normaliseLayerSettings(current.settings.layers), ...patch };
    const settings = { ...current.settings, layers };
    reportsByCampaign.set(campaignId, { ...current, settings });
    snapshotCacheByCampaign.delete(campaignId);
    for (const listener of mapPaintListeners) listener(campaignId);
    settingsWriteQueue = settingsWriteQueue
        .then(async () => {
            const fresh = await freshCampaignContext(ctx);
            if (!fresh || fresh.data.campaignId !== campaignId) return;
            const raw = await fresh.table.read('settings');
            await fresh.table.write('settings', {
                ...(validSettings(raw) ? raw : settings),
                layers,
            });
        })
        .catch(error => ctx?.log?.('[worldmap] layer settings write failed', error));
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
export function straightLineRoute(from, to) {
    // Bresenham on integer cells, with the same cumulative octile cost
    // contract as A*. Checkpoints consume cell.cost, not just route.cost.
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    const sx = from.x < to.x ? 1 : -1;
    const sy = from.y < to.y ? 1 : -1;
    let x = from.x, y = from.y, error = dx - dy, cost = 0;
    const cells = [{ x, y, cost }];
    while (x !== to.x || y !== to.y) {
        const previousX = x, previousY = y;
        const doubled = 2 * error;
        if (doubled > -dy) { error -= dy; x += sx; }
        if (doubled < dx) { error += dx; y += sy; }
        cost += x !== previousX && y !== previousY ? Math.SQRT2 : 1;
        cells.push({ x, y, cost });
    }
    return { cells, cost, days: Math.max(1, Math.ceil(cost / 20)) };
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
 * exact anchor cell, or proposes a fixed exploration point if none exists.
 * Routes from the occupied coordinate to the selected
 * anchor via the pathfinder (single hop if directly connected, multi-hop
 * through the ledger graph otherwise). Each hop is terrain-priced.
 *
 * Returns a preview object shaped for the renderer's `getRoutePreview`:
 *   { cells, cost, days, mode, blocked?, fromAnchor, toAnchor, cellCount, hops }
 * `hops` is the per-hop breakdown for the host's `composeDeparture`/intent.
 */
export function computeRoutePreview(ctx, campaignId, toX, toY, mode, preference = routePreferenceByCampaign.get(campaignId) ?? 'fastest', compare = true, targetId = null) {
    const result = reportsByCampaign.get(campaignId);
    if (!result) return { blocked: true, reason: 'no-solve', label: 'No map solve yet' };
    const ledger = ctx.data?.location?.ledger ?? [];
    const anchors = fixedSiteAnchors(result, discoveriesByCampaign.get(campaignId)?.sites.values() ?? [], ledger);

    // AT MOST ONE ROUTE IS ACTIVE AT A TIME.
    //
    // The renderer's draw order carried a comment claiming the committed
    // journey and the route preview were "mutually exclusive in practice".
    // Nothing enforced it. Clicking the map mid-journey opened a second
    // preview, so two polylines and two independent sets of numbered camps
    // drew over each other and the player could not tell which road they
    // were on.
    //
    // The second line was also nonsense on its own terms: mid-journey the
    // current place is the TRANSIT NODE, whose anchor is a single derived
    // dot at the midpoint of the road. So the preview measured from a place
    // the party is not, and reported a shorter journey than the one they
    // were already walking.
    //
    // This is the one funnel every entry point goes through (the map click,
    // the map's TRAVEL HERE, the mode re-route, and the WO 6.3 connect-and-
    // travel path), so the cap lives here rather than at four call sites.
    // The refusal is a normal blocked preview: it carries no cells, so it
    // draws nothing, and the panel says why and offers Dismiss.
    const activeTravel = ctx.data?.location?.travel ?? null;
    if (activeTravel) {
        const destination = ledger.find(l => l.id === activeTravel.toId)?.name
            ?? 'your destination';
        return {
            blocked: true,
            reason: 'journey-active',
            label: 'Already on the road to ' + destination
                + ' — abandon the journey to plan a new route',
        };
    }

    const fromId = ctx.data?.location?.currentPlaceId ?? null;
    if (!fromId) return { blocked: true, reason: 'no-current-place', label: 'No current place — set one in the Places panel' };

    const originCell = stoppedCell(positionByCampaign.get(campaignId), ctx.data?.location);
    const baseFromAnchor = anchors.find(a => a.locationId === fromId);
    const fromAnchor = baseFromAnchor && { ...baseFromAnchor, ...originCell };
    if (!fromAnchor || !Number.isFinite(fromAnchor.x) || !Number.isFinite(fromAnchor.y)) {
        return { blocked: true, reason: 'no-current-anchor', label: 'Current place has no map anchor' };
    }

    // Exact-cell selection: adjacent wilderness must remain independently reachable.
    if (!validCell({ x: toX, y: toY })) return { blocked: true, reason: 'outside-world', label: 'Choose a cell inside the map' };
    if (fromAnchor.x === toX && fromAnchor.y === toY) return { blocked: true, reason: 'same-place', label: 'Already here' };
    let destinationSite = null;
    let toAnchor = targetId ? anchors.find(anchor => anchor.locationId === targetId) : nearestAnchor(anchors.filter(anchor => !ledger.some(entry => entry.id === anchor.locationId && entry.kind === 'transit')), toX, toY, 0);
    if (!toAnchor && !targetId) {
        destinationSite = [...(discoveriesByCampaign.get(campaignId)?.sites.values() ?? [])].find(site => site.x === toX && site.y === toY)
            ?? explorationPoint(result.settings.worldSeed, toX, toY);
        toAnchor = { locationId: destinationSite.id, x: toX, y: toY, name: siteLabel(destinationSite) };
        anchors.push(toAnchor);
    }
    if (!toAnchor) return { blocked: true, reason: 'missing-place', label: 'Destination is no longer available' };
    if (toAnchor.locationId === fromId) {
        return { blocked: true, reason: 'same-place', label: 'Already here' };
    }

    const settings = result.settings;
    const controls = buildWarpField(result.transects || []);
    const hardened = hardenedByCampaign.get(campaignId) ?? new Map();
    const chunkStore = ensureChunkStore(campaignId, settings, controls, hardened);

    // Find the ledger path (A→B→C). Single-hop if directly connected.
    const isSiteRoute = Boolean(destinationSite) || discoveriesByCampaign.get(campaignId)?.sites.has(toAnchor.locationId)
        || discoveriesByCampaign.get(campaignId)?.sites.has(fromId);
    const ledgerPath = isSiteRoute ? [fromId, toAnchor.locationId] : findLedgerPath(roadConnectedLedger(ledger, roadsByCampaign.get(campaignId) ?? []), fromId, toAnchor.locationId);
    if (!ledgerPath || ledgerPath.length < 2) {
        // No ledger path — the destination is not reachable through known
        // connections. This is a blocked result, not an error: the player
        // clicked a place they have no road to.
        //
        // WO 6.3 §1 — the refusal is an offer, not a dead end. Carry the
        // anchors and a default band (from the straight-line grid distance)
        // so the renderer can show a band selector + "Create and travel".
        // The player commits the connection; the map only proposes it.
        const fromName = ledger.find(l => l.id === fromId)?.name ?? fromId;
        const toName = ledger.find(l => l.id === toAnchor.locationId)?.name ?? toAnchor.name ?? toAnchor.locationId;
        const defaultBand = bandFromGridDistance(fromAnchor, toAnchor);
        return {
            blocked: true,
            reason: 'no-ledger-path',
            label: `No road to ${toName}`,
            fromAnchor: { locationId: fromAnchor.locationId, name: fromName },
            toAnchor: { locationId: toAnchor.locationId, name: toName },
            defaultBand,
        };
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
        const hopFromAnchor = i === 0 ? fromAnchor : anchors.find(a => a.locationId === hopFromId);
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
                { trails: surfacesFor(campaignId), preference },
            );
        }
        if (isSiteRoute && route.snapped) route = { blocked: true, reason: 'endpoint-impassable' };
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
        const toName = ledger.find(l => l.id === toAnchor.locationId)?.name ?? toAnchor.name ?? toAnchor.locationId;
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

    const toName = ledger.find(l => l.id === toAnchor.locationId)?.name ?? toAnchor.name ?? toAnchor.locationId;
    const fromName = ledger.find(l => l.id === fromId)?.name ?? fromId;
    // `hops` is the per-hop breakdown for the host's intent. Only the hops
    // after the first leg matter to the host (the first hop is the depart);
    // but the host needs all hops to create transit nodes per hop.
    const hops = hopResults.map(h => ({ fromId: h.fromId, toId: h.toId, transitId: '', legs: h.legs }));
    const alternative = compare && pfMode !== null
        ? computeRoutePreview(ctx, campaignId, toX, toY, mode, preference === 'fastest' ? 'shortest' : 'fastest', false, targetId)
        : null;
    const hasRouteChoice = alternative && !alternative.blocked
        && Math.abs(alternative.cost - totalCost) > 0.001;

    return {
        destinationSite,
        cells: allCells,
        cost: totalCost,
        days: totalDays,
        mode,
        fromAnchor: { locationId: fromAnchor.locationId, name: fromName },
        toAnchor: { locationId: toAnchor.locationId, name: toName },
        cellCount: Math.max(0, allCells.length - 1),
        preference,
        hasRouteChoice: Boolean(hasRouteChoice),
        checkpoints: buildCheckpoints(
            hopResults,
            gridsPerDayForMode(mode),
            pfMode !== null ? pathfinderMultiplier(pfMode) : 1,
            [...(discoveriesByCampaign.get(campaignId)?.sites.values() ?? [])],
        ),
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

/**
 * WO 6.3 §1 — the band whose grid range best matches the straight-line
 * distance between two anchors. The map knows how far apart the places are
 * (the anchors are on the field), so the player should not have to guess.
 * Mirrors `bandFromLegs` from `travelState.ts` for the direct-distance case
 * (one leg ≈ one day ≈ `gridsPerDayFor('foot')` grids, so the grid estimate
 * is the straight-line cell distance). `adjacent` is never returned — a
 * connection always covers ground.
 */
function bandFromGridDistance(fromAnchor, toAnchor) {
    if (!fromAnchor || !toAnchor) return 'regional';
    const dx = (toAnchor.x ?? 0) - (fromAnchor.x ?? 0);
    const dy = (toAnchor.y ?? 0) - (fromAnchor.y ?? 0);
    const grids = Math.max(1, Math.round(Math.sqrt(dx * dx + dy * dy)));
    for (const band of DISTANCE_BANDS_FOR_OFFER) {
        if (band.id === 'adjacent') continue;
        if (grids >= band.minGrids && grids <= band.maxGrids) return band.id;
    }
    return 'farthest';
}

// Exported for direct unit testing (WO 6.3 §5 gate test: the default band
// matches the straight-line anchor distance).
export function _bandFromGridDistanceForTest(fromAnchor, toAnchor) {
    return bandFromGridDistance(fromAnchor, toAnchor);
}

// Mirror of `solver.js`'s `DISTANCE_BANDS` for the offer's default-band
// computation. Kept local so the mod's index.js does not need to import the
// solver's frozen array (and stays free of solver-internal dependencies).
const DISTANCE_BANDS_FOR_OFFER = Object.freeze([
    Object.freeze({ id: 'adjacent', minGrids: 0, maxGrids: 0 }),
    Object.freeze({ id: 'nearby', minGrids: 1, maxGrids: 2 }),
    Object.freeze({ id: 'local', minGrids: 3, maxGrids: 6 }),
    Object.freeze({ id: 'regional', minGrids: 7, maxGrids: 15 }),
    Object.freeze({ id: 'far', minGrids: 16, maxGrids: 30 }),
    Object.freeze({ id: 'distant', minGrids: 31, maxGrids: 60 }),
    Object.freeze({ id: 'remote', minGrids: 61, maxGrids: 120 }),
    Object.freeze({ id: 'farthest', minGrids: 121, maxGrids: Infinity }),
]);

/** The pathfinder's per-mode multiplier, mirrored from `pathfinder.js:56`. */
function pathfinderMultiplier(pfMode) {
    if (pfMode === 'foot') return 1.0;
    if (pfMode === 'mount') return 0.7;
    if (pfMode === 'cart') return 0.6;
    if (pfMode === 'boat') return 1.0;
    return 1.0;
}

/**
 * Where each day of the journey ends.
 *
 * "6-10 days" is a number; a line of camps along the road is a journey. The
 * marks fall on real terrain cost, not on evenly-spaced cells, so a day
 * through mountains visibly covers less ground than a day on the flat.
 *
 * Day boundaries are computed PER HOP because the day count is: each hop's
 * legs are rounded up independently, so a global division would disagree with
 * the number shown in the readout. Arriving at an intermediate place is
 * itself a checkpoint — that is a night under a roof, not a night in a tent.
 * The final arrival is not a checkpoint; it is the destination.
 */
export function buildCheckpoints(hopResults, gridsPerDay, multiplier, sites = []) {
    const costPerDay = Math.max(1e-6, gridsPerDay * multiplier);
    const checkpoints = [];
    let dayOffset = 0;
    for (let index = 0; index < hopResults.length; index += 1) {
        const hop = hopResults[index];
        const cells = Array.isArray(hop.cells) ? hop.cells : [];
        const firstCheckpoint = checkpoints.length;
        let nextDay = 1;
        for (const cell of cells) {
            if (!Number.isFinite(cell.cost)) break;
            while (nextDay < hop.legs && cell.cost >= nextDay * costPerDay) {
                checkpoints.push({ x: cell.x, y: cell.y, day: dayOffset + nextDay, kind: 'camp' });
                nextDay += 1;
            }
        }
        if (sites.length) {
            const local = checkpoints.splice(firstCheckpoint);
            checkpoints.push(...preferSiteStops(local, cells, sites, costPerDay));
        }
        dayOffset += hop.legs;
        if (index < hopResults.length - 1 && cells.length > 0) {
            const last = cells[cells.length - 1];
            checkpoints.push({ x: last.x, y: last.y, day: dayOffset, kind: 'place' });
        }
    }
    return checkpoints;
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

// ── WO 6.2 — committed-journey persistence ────────────────────────────────
//
// The journey record is the committed route geometry the map draws while the
// party is walking. The host owns the journey's STATE (leg, totalLegs,
// worldDay, and when it ends — see `travelState.ts`); the mod owns the
// journey's GEOMETRY (which cells, which checkpoints, on which terrain). This
// is the same boundary the plan set draws for coordinates (core keeps
// `worldDay` and bands; the mod owns every `(x, y)`), and it is the reason
// this work order needs no change to `travelState.ts`.
//
// The record is `null` when no journey is in progress (mirroring `settings`).
// It is written at commit — BEFORE the `travelRequest` emit, so the record and
// the departure cannot disagree (§1) — and cleared when `context.travel` goes
// null (§4: arrive, halt, and campaign switch all manifest as `travel`
// becoming null, so watch the state, not the transition).
//
// Shape (§1):
//   { fromId, toId, mode, cells: [{x,y,cost}, ...],
//     checkpoints: [{x,y,day,kind}, ...], totalLegs, startedOnDay }
// `cells` is the committed route as walked (the pathfinder's per-hop cells,
// concatenated); `checkpoints` is `buildCheckpoints`'s output; `totalLegs` is
// the committed leg count, for the sanity check in §2.

async function readJourney(ctx) {
    const fresh = await freshCampaignContext(ctx);
    if (!fresh) return null;
    const raw = await fresh.table.read('journey');
    return validJourney(raw) ? raw : null;
}

/**
 * Exported for direct unit testing — hydrates the in-memory journey cache
 * from the table, the same way `mountMap`'s initial mount does. A test that
 * exercises `mapSnapshot` (which reads from the cache, not the table) must
 * hydrate the cache first so the snapshot sees the journey. Returns the
 * journey record (or `null` when none is on disk).
 */
export async function _hydrateJourneyForTest(ctx) {
    const fresh = await freshCampaignContext(ctx);
    if (!fresh) return null;
    const campaignId = fresh.data.campaignId;
    const record = await readJourney(fresh);
    journeyByCampaign.set(campaignId, record);
    return record;
}

export async function writeJourney(ctx, journey) {
    const fresh = await freshCampaignContext(ctx);
    if (!fresh) return false;
    const campaignId = fresh.data.campaignId;
    await fresh.table.write('journey', journey);
    journeyByCampaign.set(campaignId, journey);
    bumpWorldVersion(campaignId);
    for (const listener of mapPaintListeners) listener(campaignId);
    return true;
}

/**
 * Clear the journey record — write an empty object to the table and drop the
 * in-memory cache. Called when `context.travel` goes null (§4: arrive, halt,
 * campaign switch). Exported for direct unit testing of the §4 clear path.
 */
export async function clearJourney(ctx) {
    const fresh = await freshCampaignContext(ctx);
    if (!fresh) return false;
    const campaignId = fresh.data.campaignId;
    await fresh.table.write('journey', {}); // HTTP JSON parser accepts objects; validJourney treats this as inactive.
    journeyByCampaign.delete(campaignId);
    bumpWorldVersion(campaignId);
    for (const listener of mapPaintListeners) listener(campaignId);
    return true;
}

/**
 * A journey record is valid when it has the §1 fields and they are the right
 * shapes. Defensive: the table is single-object, so a stale or corrupt read
 * must degrade to "no journey" (the transit-anchor fallback in §2), never to
 * a crash. `null` is a valid value (no journey in progress).
 *
 * Exported for direct unit testing (WO 6.2 §5: a journey record whose `toId`
 * disagrees with `context.travel` is ignored).
 */
export function validJourney(value) {
    if (value === null) return true;
    if (!value || typeof value !== 'object') return false;
    if (typeof value.fromId !== 'string' || typeof value.toId !== 'string') return false;
    if (typeof value.mode !== 'string') return false;
    if (!Array.isArray(value.cells) || !value.cells.every(c =>
        Number.isFinite(c?.x) && Number.isFinite(c?.y))) return false;
    if (!Array.isArray(value.checkpoints) || !value.checkpoints.every(c =>
        Number.isFinite(c?.x) && Number.isFinite(c?.y) && Number.isFinite(c?.day)
        && (c.kind === 'camp' || c.kind === 'place'))) return false;
    if (!Number.isFinite(value.totalLegs)) return false;
    return true;
}

/**
 * WO 6.5 §1 — the cell the party actually occupies during a journey.
 *
 * WO 6.5 changes the model: one press = one day = one checkpoint. `depart()`
 * now advances the day and lands the party on camp 1 immediately (leg 1 =
 * checkpoint 0, the first camp). There is no "origin" leg — the party leaves
 * the origin on the first press.
 *
 * The mapping, verified against `travelState.ts` (WO 6.5):
 *   - `depart()` sets `leg: 1` and advances the day. Leg 1 is checkpoint 0
 *     (the first camp), NOT the origin. `buildCheckpoints` emits
 *     `totalDays - 1` camps, days 1…N-1.
 *   - Each `advance()` adds one leg and one day. Leg L is checkpoint `L - 1`
 *     in the zero-indexed list.
 *   - `arrive()` clears `travel`, and the party is at the destination anchor
 *     by the normal rule.
 *
 * Clamp, never index blindly. Two leg counts exist and they are not always
 * the same number: `depart()` derives `totalLegs` from the BAND (`legsFor`),
 * while the mod's checkpoints come from terrain-real hop legs. `departMultiHop`
 * uses the mod's hops so they agree for map-initiated travel — but a departure
 * composed from the Places panel or the composer TRAVEL button has NO route
 * geometry at all. Required behaviour:
 *   - no `journey` record, or `fromId`/`toId` do not match `context.travel`
 *     → fall back to the transit anchor. Degrade, never break.
 *   - `leg - 1` outside the checkpoint list → clamp to the last checkpoint.
 * Exported for direct unit testing. Returns `{ x, y } | null`.
 */
export function partyCellForJourney(journey, travel) {
    if (!journey || !travel) return null;
    // The record must agree with the active journey. A stale record (e.g. the
    // GM halted the journey and started a new one from a different place)
    // must not draw the party on the old route.
    if (journey.fromId !== travel.fromId || journey.toId !== travel.toId) return null;
    const leg = travel.leg;
    const checkpoints = journey.checkpoints || [];
    // Leg L (L ≥ 1) is checkpoint `L - 1` in the zero-indexed list. The first
    // press lands the party on camp 1 (checkpoint 0), not the origin.
    const index = leg - 1;
    if (index < 0) return null;
    if (index < checkpoints.length) {
        const cp = checkpoints[index];
        return { x: cp.x, y: cp.y };
    }
    // Out of range — clamp to the last checkpoint. An out-of-range leg is a
    // mismatch (the host and the mod disagree on totalLegs), not a crash.
    if (checkpoints.length > 0) {
        const last = checkpoints[checkpoints.length - 1];
        return { x: last.x, y: last.y };
    }
    // No checkpoints at all (a single-day journey) — fall back to the last
    // cell of the route, which is the destination. The party is effectively
    // there.
    const lastCell = journey.cells[journey.cells.length - 1];
    return lastCell ? { x: lastCell.x, y: lastCell.y } : null;
}

/**
 * WO 6.2 §1 — build the journey record from a committed route preview. The
 * preview carries `cells` (the pathfinder's per-hop cells, concatenated),
 * `checkpoints` (`buildCheckpoints`'s output), and `hops` (per-hop leg
 * counts). `totalLegs` is the sum of the hops' legs — the terrain-real leg
 * count the host will use when `departMultiHop` runs. `startedOnDay` is the
 * host's current `worldDay` (or 1 if unset), so a re-loaded campaign can show
 * how many days the journey has taken so far.
 *
 * Returns `null` when the preview is missing the geometry (e.g. a blocked
 * preview, or a single-hop preview that somehow lost its cells). A `null`
 * result means the commit must NOT emit `travelRequest` — the record and the
 * departure cannot disagree (§1), so no record means no departure.
 */
function buildJourneyFromPreview(preview, worldDay) {
    if (!preview || preview.blocked) return null;
    const cells = Array.isArray(preview.cells) ? preview.cells : [];
    const checkpoints = Array.isArray(preview.checkpoints) ? preview.checkpoints : [];
    const hops = Array.isArray(preview.hops) ? preview.hops : [];
    if (cells.length === 0) return null;
    const fromId = preview.fromAnchor?.locationId;
    const toId = preview.toAnchor?.locationId;
    if (!fromId || !toId) return null;
    const totalLegs = hops.reduce((sum, h) => sum + (Number.isFinite(h?.legs) ? h.legs : 0), 0);
    return {
        id: globalThis.crypto?.randomUUID?.() ?? `${fromId}:${toId}:${worldDay}:${Date.now()}`,
        fromId,
        toId,
        mode: preview.mode,
        cells: cells.map(c => ({ x: c.x, y: c.y, cost: c.cost })),
        checkpoints: checkpoints.map(c => ({ x: c.x, y: c.y, day: c.day, kind: c.kind, ...(c.siteId ? { siteId: c.siteId, siteName: c.siteName } : {}) })),
        totalLegs,
        startedOnDay: Number.isFinite(worldDay) ? worldDay : 1,
    };
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
    const anchor = partyCellForJourney(journeyByCampaign.get(campaignId), fresh.data.location?.travel)
        ?? stoppedCell(positionByCampaign.get(campaignId), fresh.data.location)
        ?? (reportsByCampaign.get(campaignId)?.anchors ?? [])
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
    // WO 4.4 — the anchors table is a pure output cache; the ledger and the
    // lore are the only inputs. No `existingAnchors` is read or passed.
    const sites = discoveriesByCampaign.get(campaignId)?.sites ?? new Map();
    const sourceLedger = fresh.data.location?.ledger ?? [];
    const excluded = new Set([...sites.keys(), ...sourceLedger.filter(entry => entry.kind === 'transit'
        && entry.connections.some(edge => sites.has(edge.toId))).map(entry => entry.id)]);
    const result = solveWorldMap({
        locations: sourceLedger.filter(entry => !excluded.has(entry.id))
            .map(entry => ({ ...entry, connections: entry.connections.filter(edge => !excluded.has(edge.toId)) })),
        loreChunks: fresh.data.loreChunks ?? [],
        worldSeed: settings.worldSeed,
        hardenedCells: hardened,
        chunkStore: terrainChunkStore,
    });

    // A campaign can change while table I/O is in flight. Confirm the lease
    // before writing so an old campaign's solve never lands in the new file.
    const confirm = await freshCampaignContext(fresh);
    if (!confirm || confirm.data.campaignId !== campaignId) return null;
    result.anchors = fixedSiteAnchors(result, sites.values(), sourceLedger);
    await confirm.table.write('anchors', result.anchors);
    publishResult(campaignId, result, settings);
    return result;
}

/**
 * Serialise one task onto the solve queue.
 *
 * The queue is a single promise chain. A task MUST NOT call `enqueue` (or
 * `queueSolve`) from inside itself: doing so reassigns `solveQueue` to a
 * promise derived from the very chain the running task is being awaited by,
 * and the two adopt each other. The chain then stays pending forever and
 * every later solve — every re-solve and route — silently never runs.
 *
 * A queued task therefore calls `solveAndPersist` directly. `enqueue` is the
 * only writer of `solveQueue`.
 */
function enqueue(ctx, task) {
    solveQueue = solveQueue
        .then(task)
        .catch(error => ctx?.log?.('[worldmap] queued task failed', error));
    return solveQueue;
}

function queueSolve(ctx) {
    return enqueue(ctx, () => solveAndPersist(ctx));
}


/**
 * WO 6.3 §1 — write a symmetric direct connection between `fromId` and
 * `toId` at `band`, re-solve so the field bends to the new edge, then
 * re-route. If the re-route succeeds, emit `travelRequest` so the host's
 * `composeDeparture` produces the byte-identical departure sentence the
 * other two entry points produce. The connection is symmetric and uses the
 * existing `setLocationLedger` write — there is no second connection
 * implementation.
 *
 * Returns the preview the renderer should show next: a successful route
 * after the re-route, or the original blocked preview if the re-route still
 * cannot resolve (e.g. the pathfinder refused on terrain grounds — the
 * connection was authored, but the party still cannot walk there today).
 */
export async function createConnectionAndRoute(ctx, campaignId, fromId, toId, band, mode, clickCell) {
    const fresh = await freshCampaignContext(ctx);
    if (!fresh || fresh.data.campaignId !== campaignId) return null;
    const ledger = Array.isArray(fresh.data.location?.ledger) ? fresh.data.location.ledger : [];
    const updated = applySymmetricConnection(ledger, fromId, toId, band);
    if (!updated) return null;
    if (fresh.write?.setLocationLedger) {
        fresh.write.setLocationLedger(updated);
    } else {
        ctx?.log?.('[worldmap] createConnection: no setLocationLedger write on ctx');
        return null;
    }
    // Re-solve so the field bends to the new edge, then re-route. Both
    // queue through `solveQueue` so the solve lands before the re-route
    // reads the report.
    await queueSolve(fresh);
    // Re-read the context before re-routing. `fresh.data` is a SNAPSHOT taken
    // at entry, before the `setLocationLedger` above — so re-routing through
    // it walks a ledger with no connection in it and reports "No road to X"
    // for the road just authored. The Places panel showed the connection and
    // the map denied it existed.
    const afterWrite = await freshCampaignContext(fresh) ?? fresh;
    const reRouted = computeRoutePreview(afterWrite, campaignId, clickCell.x, clickCell.y, mode);
    reRouted._clickCell = clickCell;
    routePreviewByCampaign.set(campaignId, reRouted);
    for (const listener of mapPaintListeners) listener(campaignId);
    if (reRouted.blocked) return reRouted;
    const fromIdResolved = reRouted.fromAnchor?.locationId ?? fromId;
    const toIdResolved = reRouted.toAnchor?.locationId ?? toId;
    // WO 6.2 §1 — persist the committed route before emitting, same as the
    // other two commit paths. Bail out of the emit if the write fails (the
    // record and the departure cannot disagree).
    const worldDay = afterWrite.data?.location?.worldDay;
    const journey = buildJourneyFromPreview(reRouted, worldDay);
    if (journey) {
        const wrote = await writeJourney(afterWrite, journey);
        if (!wrote) return reRouted;
    }
    ctx.events?.emit('travelRequest', {
        fromId: fromIdResolved,
        toId: toIdResolved,
        mode,
        hops: reRouted.hops || [],
    });
    // The travelRequest arms the departure; clear the preview so the next
    // click is a fresh preview, not a commit of the just-authorised route.
    routePreviewByCampaign.delete(campaignId);
    for (const listener of mapPaintListeners) listener(campaignId);
    return reRouted;
}

/**
 * Mirror of `ensureDirectConnection` from `travelState.ts` — write a
 * symmetric connection at `band` on both entries. Pure: returns a new
 * ledger array (or `null` when either endpoint is missing). The connection
 * is added when absent; when a connection already exists, its band is left
 * untouched (the existing band wins, exactly like the host's
 * `ensureConnection`). `adjacent` is normalised away for a NEW connection —
 * a connection always covers ground, so a stale `adjacent` is treated as
 * `local` (the nearest non-zero band).
 *
 * Exported for direct unit testing — the contract test (WO 6.3 §5) asserts
 * the `LocationConnection` produced here is identical to the one the host's
 * `ensureConnection` (`departureComposer.ts`) produces for the same pair
 * and band.
 */
export function applySymmetricConnection(ledger, fromId, toId, band) {
    const from = ledger.find(l => l.id === fromId);
    const to = ledger.find(l => l.id === toId);
    if (!from || !to) return null;
    const effectiveBand = band === 'adjacent' ? 'local' : band;
    let changed = false;
    const next = ledger.map(entry => {
        if (entry.id === fromId) {
            const existing = entry.connections.find(c => c.toId === toId);
            if (existing) return entry; // existing band wins — write nothing
            changed = true;
            return { ...entry, connections: [...entry.connections, { toId, band: effectiveBand }] };
        }
        if (entry.id === toId) {
            const existing = entry.connections.find(c => c.toId === fromId);
            if (existing) return entry; // existing band wins — write nothing
            changed = true;
            return { ...entry, connections: [...entry.connections, { toId: fromId, band: effectiveBand }] };
        }
        return entry;
    });
    return changed ? next : ledger;
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

// WO 4.4 — refusals are text only. The actionable Unpin affordances and the
// `appendActionableRefusal` helper were removed with the player pin; a
// refusal naming a `Coords:` conflict is rendered verbatim. A refusal must
// never describe an action the player cannot take, and the only action a
// `Coords:` conflict admits is editing the lore — which the report says.

// WO 4.3 — exported for the report's pin-recovery tests so the Unpin/Reset
// affordances and the actionable refusal rendering can be asserted against
// the real paint path, not a simulation of it. Mirrors the `mapSnapshot`
// export contract above.
export function paintReport(node, ctx, campaignId = ctx.data.campaignId) {
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

    const buttonRow = makeElement('div', undefined, {
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px',
        marginBottom: '14px',
    });
    buttonRow.append(button);
    node.append(buttonRow);
    const cleanups = [() => button.removeEventListener('click', onClick)];

    if (!result) return () => { for (const fn of cleanups) fn(); };

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

    // WO 4.4 — refusals are text only. A `Coords:` conflict names the action
    // the player can take (remove one Coords value) in its message.
    const refusals = Array.isArray(result.report.refusals) ? result.report.refusals : [];
    if (refusals.length > 0) {
        const refusalsBlock = makeElement('div', undefined, {
            margin: '0 0 18px',
            padding: '12px',
            border: '1px solid var(--border-primary, currentColor)',
            borderRadius: '7px',
            background: 'var(--background-secondary, transparent)',
            fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
            fontSize: '12px',
            lineHeight: '1.55',
        });
        for (const refusal of refusals) {
            const line = makeElement('div', undefined, {
                display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px',
                marginBottom: '6px',
            });
            line.append(makeElement('span', '✗', { color: 'var(--color-danger, #d33)', fontWeight: 'bold' }));
            line.append(makeElement('span', refusal.message ?? '', { whiteSpace: 'pre-wrap' }));
            refusalsBlock.append(line);
        }
        node.append(refusalsBlock);
    }

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

    return () => { for (const fn of cleanups) fn(); };
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
/**
 * The part of the travel state a map snapshot depends on. `null` travel and a
 * changed leg must both produce a different key, because both change what the
 * snapshot contains (`party`, `journeyLeg`, and whether the route draws).
 */
function travelSnapshotKey(travel) {
    if (!travel) return 'none';
    return `${travel.fromId}>${travel.toId}@${travel.leg}/${travel.totalLegs}`;
}

export function mapSnapshot(ctx) {
    const campaignId = ctx.data?.campaignId;
    const result = campaignId ? reportsByCampaign.get(campaignId) : null;
    if (!result) return null;
    const version = worldVersion(campaignId);
    // The cache key has to cover EVERYTHING the snapshot is built from.
    //
    // It used to be `worldVersion` alone — a counter bumped by solves and
    // hardened-cell writes. A travel press bumps neither, so once a snapshot
    // had been cached the map kept handing the renderer a pre-journey copy
    // (`party: null`, `journey: null`) for the rest of the session: the
    // party never moved, the route never drew, and every layer below this
    // was correct the whole time.
    //
    // The leg is part of what the snapshot depends on, so it is part of the
    // key. Deleting the cache from the one subscription that noticed would
    // have fixed this call site and left the trap armed for the next field.
    const travelKey = `${ctx.data?.location?.currentPlaceId ?? ""}:${travelSnapshotKey(ctx.data?.location?.travel ?? null)}`;
    const cached = snapshotCacheByCampaign.get(campaignId);
    if (cached && cached.worldVersion === version && cached.travelKey === travelKey) {
        return cached.snapshot;
    }

    const hardened = hardenedByCampaign.get(campaignId) ?? new Map();
    const ledger = ctx.data?.location?.ledger ?? [];
    const ledgerById = new Map(ledger.map(entry => [entry.id, entry]));
    const anchors = fixedSiteAnchors(result, discoveriesByCampaign.get(campaignId)?.sites.values() ?? [], ledger).map(anchor => {
        const location = ledgerById.get(anchor.locationId);
        return { ...anchor, hidden: isTemporaryPlace(location), name: location?.name ?? anchor.locationId, ...(location?.kind === 'transit' ? { kind: 'transit' } : {}) };
    });
    const controls = buildWarpField(result.transects || []);
    const chunkStore = ensureChunkStore(campaignId, result.settings, controls, hardened);

    // WO 6.2 — the party cell and the committed journey. The host owns
    // `travel.leg` (the seam: `data.location.travel`); the mod owns the
    // route geometry (`journeyByCampaign`). `party` is the cell the party
    // actually occupies during a journey — NOT the current place's anchor
    // (which during a journey is the transit node, one fixed dot per road).
    // `null` `party` means "fall back to the current place's anchor" (§2's
    // degrade path: no journey record, or a mismatch, or no travel state).
    const travel = ctx.data?.location?.travel ?? null;
    const journey = journeyByCampaign.get(campaignId) ?? null;
    const party = partyCellForJourney(journey, travel)
        ?? (!travel ? stoppedCell(positionByCampaign.get(campaignId), ctx.data?.location) : null);
    // `journeyLeg` is the host's current leg, passed to the renderer so it
    // can split the route into walked vs remaining and fill the passed
    // checkpoints. `null` when no journey is active.
    const journeyLeg = (journey && travel) ? travel.leg : null;
    // The panel's journey state renders from the HOST's numbers, resolved to
    // a name here because the renderer has no ledger. `journey.totalLegs`
    // and `travel.totalLegs` both count days, including arrival; the host owns the
    // journey's state, so the host's number is the one the player sees.
    const travelSummary = travel
        ? {
            toId: travel.toId,
            toName: ledgerById.get(travel.toId)?.name ?? travel.toId,
            leg: travel.leg,
            totalLegs: travel.totalLegs,
        }
        : null;

    const encounterCell = party ?? anchors.find(anchor => anchor.locationId === ctx.data?.location?.currentPlaceId);
    const encounterRecords = encountersByCampaign.get(campaignId) ?? new Map();
    const encounter = encounterCell ? encounterRecords.get(checkpointKey({ ...encounterCell, worldDay: ctx.data?.location?.worldDay })) ?? null : null;
    const snapshot = {
        roads: roadsByCampaign.get(campaignId) ?? [],
        roadEdges: [...roadEdges(roadsByCampaign.get(campaignId) ?? []).values()],
        roadEditor: roadEditorsByCampaign.get(campaignId) ?? { mode: 'idle', points: [], routes: [] },
        explored: explorationByCampaign.get(campaignId) ?? new Set(),
        generated: generatedByCampaign.get(campaignId) ?? new Set(),
        visible: visibleCells(encounterCell),
        encounter,
        encounterJournal: [...encounterRecords.values()].filter(row => row.archivedOnDay == null && (!row.quiet || row.note || row.pinned || row.unresolved)).reverse(),
        encounterArchive: [...encounterRecords.values()].filter(row => row.archivedOnDay != null).reverse(),
        anchors,
        transects: result.transects || [],
        connections: result.connections || [],
        trails: serializeTrails(trailsByCampaign.get(campaignId) ?? readTrails(null)).edges,
        discoveries: [...(discoveriesByCampaign.get(campaignId)?.sites.values() ?? [])].map(site => site.type === 'wilderness' && isTemporaryPlace(ledgerById.get(site.id) ?? { ...site, recordKind: 'position' }) ? { ...site, hidden: true } : site),
        nearbyDiscoveries: nearbyDiscoveries(discoveriesByCampaign.get(campaignId) ?? readDiscoveries(null),
            party ?? anchors.find(anchor => anchor.locationId === ctx.data?.location?.currentPlaceId)),
        waypoints: result.waypoints || [],
        settings: result.settings,
        hardened,
        locationId: ctx.data?.location?.currentPlaceId ?? null,
        worldVersion: version,
        travel: travelSummary,
        worldDay: ctx.data?.location?.worldDay ?? null,
        chunkStore,
        controls,
        // WO 6.2 — the journey on screen. The renderer draws the walked leg
        // dimmer than the remaining leg, fills passed checkpoints, and sits
        // the party marker on `party`. `journey` survives a repaint (it is
        // backed by the `journey` table, not the ephemeral preview) — a
        // solve, a ledger change or a tab switch leaves it on screen (§3).
        party,
        journey: journey && travel ? journey : null,
        journeyLeg,
    };
    snapshotCacheByCampaign.set(campaignId, { snapshot, worldVersion: version, travelKey });
    return snapshot;
}

function mountMap(node, ctx) {
    let cleanupRenderer = null;
    // Survives the renderer remounts that every repaint performs. Null until
    // the first mount, which is the only time the camera frames itself.
    let lastView = null;
    // See the note in `mountReport`: `ctx.data` is a snapshot from activate-time
    // cold start. `liveCtx` is swapped for a freshly-read context on mount, which
    // is what makes place names and the current place resolve at all.
    let liveCtx = ctx;
    let currentCampaignId = ctx.data.campaignId;
    // WO 6.2 §3 — the camera rule: "a repaint must not move the camera, but the
    // party actually advancing a leg should recentre." A repaint restores
    // `lastView` (the camera is panel state, not renderer state); a leg advance
    // sets `recentreOnNextMount` so the next mount calls `centreOnParty()` on
    // the new party cell instead of restoring `lastView`. `prevLeg` tracks the
    // last-seen leg so a mere repaint (same leg) does not recentre.
    //
    // WO 5.5 §3 — the travel-follow rule: "when the current place *changes* —
    // the party actually travelled — recentre on the new place. That is the
    // auto-move the player wants, and the only one." `prevPlaceId` tracks the
    // last-seen current place so a mere repaint (same place) does not recentre,
    // but a change (the party arrived) does. A null→null transition (a ledger
    // edit with no travel) does not recentre.
    let prevLeg = null;
    let prevPlaceId = null;
    let recentreOnNextMount = false;

    // WO 6.1 — the route preview is re-rendered on every paint via
    // `getRoutePreview`. The renderer reads it from the per-campaign map. A
    // paint listener fires when the preview changes so the renderer repaints.
    function refreshPreview() {
        for (const listener of mapPaintListeners) listener(currentCampaignId);
    }

    function showRoadEditor(editor) {
        roadEditorsByCampaign.set(currentCampaignId, editor);
        snapshotCacheByCampaign.delete(currentCampaignId);
        refreshPreview();
    }
    function rebuildRoadDraft(editor) {
        const snapshot = mapSnapshot(liveCtx);
        const result = planRoad(snapshot.chunkStore, editor.points, editor.kind, surfacesFor(currentCampaignId));
        const anchors = snapshot.anchors;
        const from = anchors.find(a => a.x === editor.points[0]?.x && a.y === editor.points[0]?.y && a.kind !== 'transit');
        const last = editor.points.at(-1);
        const to = anchors.find(a => a.x === last?.x && a.y === last?.y && a.kind !== 'transit');
        showRoadEditor({ ...editor, worldVersion: snapshot.worldVersion, routes: result.blocked ? [] : [{ ...result,
            id: `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`, source: 'manual', fromId: from?.locationId, toId: to?.locationId }],
            message: result.blocked ? result.reason : `${result.cells.length - 1} cells · ready to save` });
    }
    async function handleRoadAction(action, payload) {
        const campaignId = currentCampaignId;
        const fresh = await freshCampaignContext(ctx);
        if (!fresh || fresh.data.campaignId !== campaignId) return;
        liveCtx = fresh;
        const snapshot = mapSnapshot(fresh);
        const editor = roadEditorsByCampaign.get(campaignId) ?? { mode: 'idle', points: [], routes: [] };
        if (editor.busy && action !== 'roadCancel') return;
        if (action === 'roadCancel') { showRoadEditor({ mode: 'idle', points: [], routes: [] }); return; }
        if (action === 'roadStart') {
            routePreviewByCampaign.delete(campaignId);
            showRoadEditor({ mode: 'manual', points: [], routes: [], kind: 'path', message: 'Click waypoint cells on the map.' }); return;
        }
        if (action === 'roadUndo' || action === 'roadKind') {
            if (editor.mode !== 'manual') return;
            rebuildRoadDraft({ ...editor, points: action === 'roadUndo' ? editor.points.slice(0, -1) : editor.points,
                kind: action === 'roadKind' && payload === 'road' ? 'road' : action === 'roadKind' ? 'path' : editor.kind }); return;
        }
        if (action === 'roadGenerate') {
            routePreviewByCampaign.delete(campaignId);
            const pending = { mode: 'generated', points: [], routes: [], busy: true, message: 'Finding passable road connections…', worldVersion: snapshot.worldVersion };
            showRoadEditor(pending);
            const pairs = roadCandidates(snapshot.anchors, fresh.data.location.ledger ?? [], snapshot.discoveries, roadsByCampaign.get(campaignId) ?? []);
            const routes = []; let blocked = 0;
            for (const [a, b] of pairs) {
                await new Promise(resolve => setTimeout(resolve, 0));
                if (roadEditorsByCampaign.get(campaignId) !== pending) return;
                const result = planRoad(snapshot.chunkStore, [a, b], 'road', surfacesFor(campaignId));
                if (result.blocked) { blocked++; continue; }
                routes.push({ ...result, id: `generated-${[a.locationId, b.locationId].sort().join('--')}`,
                    name: `${a.name || siteLabel(a)} — ${b.name || siteLabel(b)}`.slice(0, 80), fromId: a.locationId, toId: b.locationId, source: 'generated' });
            }
            const latest = await freshCampaignContext(ctx);
            if (!latest || latest.data.campaignId !== campaignId || roadEditorsByCampaign.get(campaignId) !== pending) return;
            showRoadEditor({ ...pending, busy: false, routes, message: `${routes.length} new roads proposed · ${blocked} blocked connections skipped` }); return;
        }
        if (action === 'roadSave' || action === 'roadDelete') {
            if (action === 'roadSave' && (!editor.routes.length || editor.worldVersion !== snapshot.worldVersion)) {
                showRoadEditor({ ...editor, message: 'Preview again before saving; the map may have changed.' }); return;
            }
            const existing = roadsByCampaign.get(campaignId) ?? [];
            let next;
            if (action === 'roadDelete') { routePreviewByCampaign.delete(campaignId); next = existing.filter(route => route.id !== payload?.id); }
            else {
                const added = editor.routes.map(route => ({ ...route, name: editor.mode === 'manual'
                    ? String(payload?.name || 'Unnamed path').trim().slice(0, 80) : route.name }));
                next = [...existing.filter(route => !added.some(item => item.id === route.id)), ...added];
            }
            showRoadEditor({ ...editor, busy: true, message: 'Saving…' });
            await fresh.table.write('roads', serializeRoads(next));
            roadsByCampaign.set(campaignId, next);
            if (currentCampaignId !== campaignId) return;
            const confirmed = await freshCampaignContext(ctx);
            if (!confirmed || confirmed.data.campaignId !== campaignId) return;
            showRoadEditor({ mode: 'idle', points: [], routes: [], message: action === 'roadDelete' ? 'Removed.' : 'Saved. Travel now accounts for these surfaces.' });
        }
    }

    let commitBusy = false;
    async function commitPreview(preview) {
        if (commitBusy || !preview || preview.blocked) return;
        commitBusy = true;
        const campaignId = currentCampaignId;
        try {
            const fresh = await freshCampaignContext(ctx);
            if (!fresh || fresh.data.campaignId !== campaignId || fresh.data.location.travel
                || fresh.data.location.currentPlaceId !== preview.fromAnchor?.locationId) return;
            const site = preview.destinationSite;
            if (site) {
                const state = readDiscoveries(serializeDiscoveries(discoveriesByCampaign.get(campaignId) ?? readDiscoveries(null)));
                if (!state.sites.has(site.id)) state.sites.set(site.id, { ...site, biome: mapSnapshot(fresh).chunkStore.getCell(site.x, site.y).biome });
                await fresh.table.write('discoveries', serializeDiscoveries(state));
                discoveriesByCampaign.set(campaignId, state);
                snapshotCacheByCampaign.delete(campaignId);
                const ledger = fresh.data.location.ledger ?? [];
                await fresh.write?.setLocationLedger?.(promoteSite(site, ledger, fresh.data.location.currentPlaceId));
            }
            const latest = await freshCampaignContext(ctx);
            if (!latest || latest.data.campaignId !== campaignId || latest.data.location.travel
                || latest.data.location.currentPlaceId !== preview.fromAnchor?.locationId) return;
            const journey = buildJourneyFromPreview(preview, latest.data.location.worldDay);
            if (!journey || !await writeJourney(latest, journey)) return;
            const confirmed = await freshCampaignContext(ctx);
            if (!confirmed || confirmed.data.campaignId !== campaignId) return;
            confirmed.events?.emit('travelRequest', { fromId: preview.fromAnchor.locationId,
                toId: preview.toAnchor.locationId, mode: preview.mode, hops: preview.hops || [] });
            routePreviewByCampaign.delete(campaignId);
            refreshPreview();
        } catch (error) { ctx.log?.('[worldmap] departure failed', error); }
        finally { commitBusy = false; }
    }

    const handleRouteAction = (action, payload) => {
        if (action.startsWith('road')) {
            void handleRoadAction(action, payload).catch(error => {
                showRoadEditor({ ...(roadEditorsByCampaign.get(currentCampaignId) ?? {}), busy: false, message: 'Could not save or build the path. Please try again.' });
                ctx.log?.('[worldmap] road action failed', error);
            }); return;
        }
        if (action === 'setWorldProfile') {
            const campaignId = currentCampaignId;
            const profile = worldProfile(payload);
            settingsWriteQueue = settingsWriteQueue.then(async () => {
                const fresh = await freshCampaignContext(ctx);
                if (!fresh || fresh.data.campaignId !== campaignId) return;
                const raw = await fresh.table.read('settings');
                if (!validSettings(raw)) return;
                await fresh.table.write('settings', { ...raw, worldProfile: profile.id });
                const current = reportsByCampaign.get(campaignId);
                if (!current) return;
                reportsByCampaign.set(campaignId, { ...current, settings: { ...current.settings, worldProfile: profile.id } });
                snapshotCacheByCampaign.delete(campaignId);
                await updateDiscoveries(fresh);
                refreshPreview();
            }).catch(error => ctx.log?.('[worldmap] world setting save failed', error));
            return;
        }
        if (action === 'roleplayEncounter') {
            const campaignId = currentCampaignId;
            void (async () => {
                const fresh = await freshCampaignContext(ctx);
                if (!fresh || fresh.data.campaignId !== campaignId) return;
                await updateDiscoveries(fresh);
                const latest = await freshCampaignContext(ctx);
                if (!latest || latest.data.campaignId !== campaignId) return;
                const record = mapSnapshot(latest)?.encounter;
                if (!record || record.key !== payload?.key) return;
                if (payload.kind === 'reply') {
                    const task = encounterQueue.then(async () => {
                        const records = setEncounterFlags(encountersByCampaign.get(campaignId) ?? new Map(), record.key, { unresolved: true }, latest.data.location.worldDay);
                        await latest.table.write('encounters', serializeEncounters(records));
                        encountersByCampaign.set(campaignId, records); snapshotCacheByCampaign.delete(campaignId);
                    });
                    encounterQueue = task.catch(error => ctx.log?.('[worldmap] interaction save failed', error));
                    await task;
                }
                latest.events?.emit('roleplayRequest', { campaignId, key: record.key,
                    placeId: latest.data.location.currentPlaceId, worldDay: record.worldDay,
                    leg: latest.data.location.travel?.leg ?? null, text: payload.text, kind: payload.kind });
            })().catch(error => ctx.log?.('[worldmap] roleplay handoff failed', error));
            return;
        }
        if (action === 'handleEncounter' || action === 'noteEncounter' || action === 'flagEncounter') {
            const campaignId = currentCampaignId;
            const task = encounterQueue.then(async () => {
                const fresh = await freshCampaignContext(ctx);
                if (!fresh || fresh.data.campaignId !== campaignId) return;
                const previous = encountersByCampaign.get(campaignId) ?? new Map();
                const day = fresh.data.location.worldDay;
                const next = action === 'flagEncounter' ? setEncounterFlags(previous, payload?.key, payload?.flags, day)
                    : action === 'noteEncounter' ? noteEncounter(previous, payload?.key, payload?.note, day) : handleEncounter(previous, payload?.key, day);
                if (next === previous) return;
                await fresh.table.write('encounters', serializeEncounters(next));
                encountersByCampaign.set(campaignId, next);
                snapshotCacheByCampaign.delete(campaignId);
            });
            encounterQueue = task.catch(error => ctx.log?.('[worldmap] encounter save failed', error));
            void task.then(async () => {
                const fresh = await freshCampaignContext(ctx);
                if (fresh?.data.campaignId === campaignId) { await updateDiscoveries(fresh); refreshPreview(); }
            }).catch(error => ctx.log?.('[worldmap] encounter update failed', error));
            return;
        }
        if (action === 'visitDiscovery') {
            void (async () => {
                const fresh = await freshCampaignContext(ctx);
                const site = discoveriesByCampaign.get(currentCampaignId)?.sites.get(payload?.id);
                if (!fresh || !site || fresh.data.campaignId !== currentCampaignId || fresh.data.location?.travel) return;
                const ledger = fresh.data.location?.ledger ?? [];
                const anchors = mapSnapshot(fresh)?.anchors ?? [];
                const next = promoteSite(site, ledger, fresh.data.location?.currentPlaceId, id =>
                    bandFromGridDistance(anchors.find(anchor => anchor.locationId === id), site));
                if (next !== ledger) fresh.write?.setLocationLedger?.(next);
                await queueSolve(ctx);
                const latest = await freshCampaignContext(ctx);
                if (!latest || latest.data.campaignId !== currentCampaignId) return;
                const snapshot = mapSnapshot(latest);
                const party = snapshot?.party ?? snapshot?.anchors.find(anchor => anchor.locationId === latest.data.location?.currentPlaceId);
                if (party?.x === site.x && party?.y === site.y) {
                    latest.write?.updateContext?.({ currentPlaceId: site.id, currentFeature: null });
                    return;
                }
                const preview = computeRoutePreview(latest, currentCampaignId, site.x, site.y, currentTravelMode, undefined, true, site.id);
                preview._clickCell = { x: site.x, y: site.y, targetId: site.id };
                routePreviewByCampaign.set(currentCampaignId, preview);
                refreshPreview();
            })();
            return;
        }
        if (action === 'nameDiscovery') {
            const state = discoveriesByCampaign.get(currentCampaignId);
            if (!state || !nameDiscovery(state, payload?.id, payload?.name, payload?.description)) return;
            void (async () => {
                const fresh = await freshCampaignContext(ctx);
                if (!fresh || fresh.data.campaignId !== currentCampaignId) return;
                await fresh.table.write('discoveries', serializeDiscoveries(state));
                const ledger = fresh.data.location?.ledger ?? [];
                if (ledger.some(entry => entry.id === payload.id) && fresh.write?.setLocationLedger) {
                    fresh.write.setLocationLedger(ledger.map(entry => entry.id === payload.id
                        ? { ...entry, name: state.sites.get(payload.id).name || siteLabel(state.sites.get(payload.id)), description: state.sites.get(payload.id).description } : entry));
                }
                snapshotCacheByCampaign.delete(currentCampaignId);
                const updated = await freshCampaignContext(ctx);
                if (updated?.data.campaignId === currentCampaignId) await updateDiscoveries(updated);
                refreshPreview();
            })();
            return;
        }
        if (action === 'cancel') {
            routePreviewByCampaign.delete(currentCampaignId);
            refreshPreview();
            return;
        }
        if (action === 'setMode' || action === 'setPreference') {
            if (action === 'setMode') currentTravelMode = String(payload || 'foot');
            else routePreferenceByCampaign.set(currentCampaignId, payload === 'shortest' ? 'shortest' : 'fastest');
            // Re-route with the new mode if there's a pending click target.
            const preview = routePreviewByCampaign.get(currentCampaignId);
            if (preview && preview._clickCell) {
                const recomputed = computeRoutePreview(liveCtx, currentCampaignId, preview._clickCell.x, preview._clickCell.y, currentTravelMode, undefined, true, preview._clickCell.targetId);
                recomputed._clickCell = preview._clickCell;
                routePreviewByCampaign.set(currentCampaignId, recomputed);
                refreshPreview();
            }
            return;
        }
        if (action === 'commit') { void commitPreview(routePreviewByCampaign.get(currentCampaignId)); return; }
        if (action === 'continue') {
            // WO 6.5 — one press, one day, one camp. The mod owns the route
            // geometry and nothing else, so advancing is a request to the
            // host, exactly like `travelRequest`. The host runs the same
            // `pressTravelAdvance` the composer button runs, so the two
            // controls cannot drift into meaning different things.
            ctx.events?.emit('travelAdvance', {});
            return;
        }
        if (action === 'abandon') {
            ctx.events?.emit('travelAbandon', {});
            return;
        }
        if (action === 'createConnection') {
            // WO 6.3 §1 — accept the offer. Write a symmetric direct connection
            // at the chosen band, re-solve so the field bends to the new edge,
            // then re-route. If the re-route succeeds, emit `travelRequest`
            // exactly like a normal commit, so the host's departure sentence
            // and intent are byte-identical to the other two entry points.
            // Never silent: the player clicked "Create and travel".
            const preview = routePreviewByCampaign.get(currentCampaignId);
            if (!preview || !preview.blocked || preview.reason !== 'no-ledger-path') return;
            const fromId = preview.fromAnchor?.locationId ?? null;
            const toId = preview.toAnchor?.locationId ?? null;
            if (!fromId || !toId || fromId === toId) return;
            const band = String(payload?.band || preview.defaultBand || 'regional');
            void createConnectionAndRoute(ctx, currentCampaignId, fromId, toId, band, currentTravelMode, preview._clickCell);
            return;
        }
    };

    const handleClickCell = (x, y) => {
        const editor = roadEditorsByCampaign.get(currentCampaignId);
        if (editor?.mode === 'manual') {
            if (editor.busy || !validCell({ x, y }) || editor.points.length >= 12) return;
            rebuildRoadDraft({ ...editor, points: [...editor.points, { x, y }] }); return;
        }
        if (editor?.busy) return;
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

    const handleContextAction = (action, payload = {}) => {
        const locationId = payload.locationId ?? null;
        if (action === 'travel') {
            // Context-menu travel previews first, just like a left click.
            handleClickCell(payload.x, payload.y);
            return;
        }
        if (action === 'current' && locationId) {
            if (liveCtx.write?.updateContext) {
                liveCtx.write.updateContext({ currentPlaceId: locationId, currentFeature: null });
            } else {
                ctx.events?.emit('setCurrentPlace', { locationId });
            }
            return;
        }
        if (action === 'details' && locationId) {
            ctx.events?.emit('placeDetails', { locationId });
            return;
        }
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
        // WO 6.2 §3 — detect a leg advance to recentre the camera. The camera
        // rule: "a repaint must not move the camera, but the party actually
        // advancing a leg should recentre." A leg advance is the ONE auto-move
        // the player wants — it is the map following them down the road. A mere
        // repaint (same leg) restores `lastView` and does not recentre.
        //
        // WO 5.5 §3 — the travel-follow rule: the other auto-move the player
        // wants is "the party actually travelled" — the current place changed.
        // Recentre on the new place. A null→null transition (a ledger edit with
        // no travel) does not recentre. This is the ONE exception to "never
        // auto-recentre on repaint" (§3): the party travelled, so the map
        // follows. A mere repaint (same place) restores `lastView`.
        const currentLeg = liveCtx.data?.location?.travel?.leg ?? null;
        const currentPlaceId = liveCtx.data?.location?.currentPlaceId ?? null;
        const legAdvanced = prevLeg !== null && currentLeg !== null && currentLeg !== prevLeg;
        const placeChanged = prevPlaceId !== null && currentPlaceId !== null && currentPlaceId !== prevPlaceId;
        const shouldRecentre = recentreOnNextMount || legAdvanced || placeChanged;
        prevLeg = currentLeg;
        prevPlaceId = currentPlaceId;
        // Consume the flag — it is a one-shot, set by the leg-advance
        // detection above or by an explicit `centreOnParty` key press that
        // wants the next mount to recentre.
        recentreOnNextMount = false;
        // Sync the selector's mode from the host context on (re)mount.
        const ctxMode = liveCtx.data?.location?.travelMode;
        if (ctxMode && typeof ctxMode === 'string') currentTravelMode = ctxMode;
        cleanupRenderer = mountMapRenderer(node, {
            getSnapshot: snapshot,
            // Every repaint tears the renderer down and mounts a new one, and
            // a fresh mount frames the camera. So a solve, a table write or a
            // ledger change used to yank the view out from under the player
            // mid-pan. The camera is panel state, not renderer state: the
            // renderer restores it on mount and reports it as it changes.
            //
            // WO 6.2 §3 — when the leg advanced, return `null` for this one
            // mount so the renderer calls `centreOnParty()` (on the new party
            // cell) instead of restoring `lastView`. The flag is consumed
            // above so the NEXT repaint restores `lastView` as usual.
            getInitialView: () => shouldRecentre ? null : lastView,
            onViewChange: view => { lastView = view; },
            onClickCell: handleClickCell,
            onRouteAction: handleRouteAction,
            onLayerChange: patch => persistLayerSettings(liveCtx, currentCampaignId, patch),
            onContextAction: handleContextAction,
            getRoutePreview,
            getTravelMode,
            travelModes: MAP_TRAVEL_MODES,
            log: (...args) => ctx?.log?.('[worldmap:map]', ...args),
        });
    };
    let disposed = false;
    // WO 6.2 §4 — tracks the previous `travel` state so a null→null
    // transition (a normal ledger edit with no journey) does not write
    // `null` to the table on every edit. Declared here (before the
    // campaign/location subscribers) so the campaign-switch handler can
    // reset it when the campaign changes.
    let prevTravelWasActive = false;
    const repaint = campaignId => {
        if (campaignId !== currentCampaignId) return;
        render();
    };
    mapPaintListeners.add(repaint);
    const unsubscribeCampaign = ctx.subscribe('campaignId', async campaignId => {
        currentCampaignId = campaignId;
        // WO 6.2 §4 — campaign switch: clear from memory (the record is
        // per-campaign on disk), reset the travel-watch flag, and hydrate
        // the new campaign's journey record. The old campaign's record
        // stays on disk for when the player switches back.
        // WO 5.5 §3 — reset the place tracker so the new campaign's first
        // mount does not recentre on a place change that was actually a
        // campaign switch.
        prevTravelWasActive = false;
        prevPlaceId = null;
        prevLeg = null;
        const fresh = await freshCampaignContext(ctx);
        if (!disposed && fresh && fresh.data.campaignId === campaignId) {
            await hydratePosition(fresh);
            journeyByCampaign.set(campaignId, await readJourney(fresh));
            prevTravelWasActive = Boolean(fresh.data?.location?.travel ?? null);
            prevPlaceId = fresh.data?.location?.currentPlaceId ?? null;
            prevLeg = fresh.data?.location?.travel?.leg ?? null;
        }
        render();
    });
    // The map is a VIEW of the ledger, so it has to follow the ledger.
    // `liveCtx` was resolved once at mount and never again, so every ledger
    // change made after the map opened — a new place, a new connection, a
    // change of current place — left the map reading a snapshot from mount
    // time while the Places panel showed the truth. Same fact, two answers.
    //
    // WO 6.2 §4 — this is also the journey-exit watcher. The three exits
    // (arrive, halt, campaign switch) all manifest as `context.travel`
    // becoming null, so watch the STATE, not the transition. A stale record
    // would leave a ghost route drawn across the map with a marker parked on
    // a camp the party abandoned. Clear the `journey` record when `travel`
    // goes null while a record is in memory.
    const unsubscribeLocation = ctx.subscribe('location', async () => {
        const fresh = await freshCampaignContext(ctx);
        if (disposed || !fresh || fresh.data.campaignId !== currentCampaignId) return;
        liveCtx = fresh;
        // WO 6.2 §4 — clear the journey record when `travel` goes null. The
        // trigger is the state, not the transition: `arrive()` (last leg
        // done), `halt()` (fiction named an off-route place), and a campaign
        // switch (the record is per-campaign on disk) all show up here as
        // `travel` becoming null. Watch that, not a specific event.
        const travelNow = fresh.data?.location?.travel ?? null;
        const travelActive = Boolean(travelNow);
        if (prevTravelWasActive && !travelActive) {
            await clearJourney(fresh);
        }
        // The other half of the one-route cap. `computeRoutePreview` refuses
        // to open a preview while travelling, but a preview opened just
        // BEFORE departure would otherwise sit on screen next to the journey
        // it became — the Places panel and the composer TRAVEL button depart
        // without going anywhere near the map’s own commit path, which is
        // the one that clears the preview. Clear on the transition INTO
        // travel, not on the state, or the journey-active refusal itself
        // would be wiped before the player could read it.
        if (!prevTravelWasActive && travelActive) {
            routePreviewByCampaign.delete(currentCampaignId);
        }
        prevTravelWasActive = travelActive;
        render();
    });
    const unsubscribeAnchors = ctx.table.subscribe('anchors', () => repaint(currentCampaignId));
    const unsubscribeVisited = ctx.table.subscribe('visited', async () => {
        hardenedByCampaign.set(currentCampaignId, await readHardened(ctx));
        repaint(currentCampaignId);
    });
    const unsubscribeSettings = ctx.table.subscribe('settings', async () => {
        const fresh = await freshCampaignContext(ctx);
        if (!fresh || fresh.data.campaignId !== currentCampaignId) return;
        const raw = await fresh.table.read('settings');
        const current = reportsByCampaign.get(currentCampaignId);
        if (!current || !validSettings(raw)) return;
        reportsByCampaign.set(currentCampaignId, {
            ...current,
            settings: {
                ...current.settings,
                ...raw,
                layers: normaliseLayerSettings(raw.layers ?? DEFAULT_LAYERS),
            },
        });
        snapshotCacheByCampaign.delete(currentCampaignId);
        repaint(currentCampaignId);
    });
    // WO 6.2 — keep the in-memory journey cache in sync with the table. The
    // table is written by this mod's commit path, but a table subscription
    // is the canonical way to stay in sync (the host's table adapter
    // notifies on every write, including this mod's own).
    const unsubscribeJourney = ctx.table.subscribe('journey', async () => {
        const fresh = await freshCampaignContext(ctx);
        if (!fresh || fresh.data.campaignId !== currentCampaignId) return;
        journeyByCampaign.set(currentCampaignId, await readJourney(fresh));
        snapshotCacheByCampaign.delete(currentCampaignId);
        repaint(currentCampaignId);
    });
    freshCampaignContext(ctx).then(async fresh => {
        if (disposed || !fresh) return;
        liveCtx = fresh;
        currentCampaignId = fresh.data.campaignId;
        hardenedByCampaign.set(currentCampaignId, await readHardened(fresh));
        // WO 6.2 — hydrate the journey record from disk so a reloaded
        // campaign shows the in-progress journey. Also seed the
        // `prevTravelWasActive` flag so a journey active at mount time is
        // not immediately cleared by the first `subscribe('location')`
        // notification. The guard clears only on active→inactive
        // (prev true, now false); an active journey at mount sets prev
        // true, so the first notification sees prev=true and (if travel
        // is still active) now=true → no clear.
        journeyByCampaign.set(currentCampaignId, await readJourney(fresh));
        prevTravelWasActive = Boolean(fresh.data?.location?.travel ?? null);
        if (!disposed) render();
    });
    return () => {
        disposed = true;
        if (cleanupRenderer) { cleanupRenderer(); cleanupRenderer = null; }
        mapPaintListeners.delete(repaint);
        unsubscribeCampaign();
        unsubscribeLocation();
        unsubscribeAnchors();
        unsubscribeVisited();
        unsubscribeSettings();
        unsubscribeJourney();
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
    ctx.events?.on('mod.worldmap.storyRoute', async payload => {
        const reply = hops => ctx.events?.emit('storyRouteResult', { requestId: payload?.requestId, hops });
        const valid = fresh => fresh && fresh.data.campaignId === payload?.campaignId
            && fresh.data.location.currentPlaceId === payload.fromId && !fresh.data.location.travel
            && fresh.data.location.worldDay === payload.worldDay && Date.now() < payload.expiresAt;
        try {
            let fresh = await freshCampaignContext(ctx);
            if (!valid(fresh)) { reply(null); return; }
            await queueSolve(fresh);
            fresh = await freshCampaignContext(ctx);
            if (!valid(fresh)) { reply(null); return; }
            const anchor = reportsByCampaign.get(payload.campaignId)?.anchors.find(a => a.locationId === payload.toId);
            if (!anchor) { reply(null); return; }
            const preview = computeRoutePreview(fresh, payload.campaignId, anchor.x, anchor.y, payload.mode, undefined, false, payload.toId);
            if (preview.blocked) { reply(null); return; }
            const journey = buildJourneyFromPreview(preview, fresh.data.location.worldDay);
            if (!journey || !valid(await freshCampaignContext(ctx)) || !await writeJourney(fresh, journey)) { reply(null); return; }
            reply(valid(await freshCampaignContext(ctx)) ? preview.hops : null);
        } catch (error) { ctx.log?.('[worldmap] story route failed', error); reply(null); }
    });
    ctx.events?.on('mod.worldmap.planTravel', async payload => {
        const fresh = await freshCampaignContext(ctx);
        if (!fresh) return;
        await queueSolve(fresh);
        const campaignId = fresh.data.campaignId;
        const anchor = reportsByCampaign.get(campaignId)?.anchors.find(a => a.locationId === payload.toId);
        currentTravelMode = MAP_TRAVEL_MODES.some(mode => mode.id === payload.mode) ? payload.mode : 'foot';
        const preview = anchor
            ? computeRoutePreview(fresh, campaignId, anchor.x, anchor.y, currentTravelMode, undefined, true, payload.toId)
            : { blocked: true, reason: 'no-anchor', label: 'Destination has no map anchor yet' };
        if (anchor) preview._clickCell = { x: anchor.x, y: anchor.y, targetId: payload.toId };
        routePreviewByCampaign.set(campaignId, preview);
        mapWindow.open();
        for (const listener of mapPaintListeners) listener(campaignId);
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
    let stopLocation = () => {};
    let stopLore = () => {};
    function bindCampaignSubscriptions(campaignCtx) {
        // Host reactive subscriptions are campaign-scoped and are revoked on open/switch.
        // The activation context may have been created on the campaign selection screen.
        stopLocation(); stopLore();
        stopLocation = campaignCtx.subscribe('location', () => {
            // The native host context is a snapshot; refresh it on each movement.
            // This listener also runs while the map window is closed.
            // Capture the refreshed state and geometry before a window listener
            // clears the completed journey. Serialize writes across rapid presses.
            const captured = freshCampaignContext(campaignCtx).then(fresh => fresh && fresh.data.campaignId === campaignCtx.data.campaignId && ({
                fresh: { ...fresh, data: fresh.data }, journey: journeyByCampaign.get(fresh.data.campaignId),
            }));
            movementQueue = movementQueue.then(async () => {
                const event = await captured;
                if (!event) return;
                await rememberJourneyPosition(event.fresh);
                await rememberTrails(event.fresh, event.journey);
                await updateDiscoveries(event.fresh);
                if (!event.fresh.data.location?.travel && event.journey
                    && journeyByCampaign.get(event.fresh.data.campaignId) === event.journey) {
                    await clearJourney(event.fresh);
                }
            }).catch(error => ctx.log?.('[worldmap] movement save failed', error));
            queueSolve(campaignCtx).then(() => hardenCurrentCell(campaignCtx));
        });
        stopLore = campaignCtx.subscribe('loreChunks', () => queueSolve(campaignCtx));
    }
    ctx.events?.on('campaign.opened', async () => {
        const fresh = await freshCampaignContext(ctx);
        if (fresh) {
            await hydratePosition(fresh);
            journeyByCampaign.set(fresh.data.campaignId, await readJourney(fresh));
            hardenedByCampaign.set(fresh.data.campaignId, await readHardened(fresh));
            bindCampaignSubscriptions(fresh);
            await queueSolve(fresh);
            // Repair the known prefix of an interrupted journey, never its future cells.
            movementQueue = movementQueue.then(async () => {
                const live = await freshCampaignContext(fresh);
                if (!live || live.data.campaignId !== fresh.data.campaignId) return;
                const journey = journeyByCampaign.get(live.data.campaignId);
                await rememberJourneyPosition(live);
                await rememberTrails(live, journey);
                await updateDiscoveries(live);
                if (!live.data.location?.travel && journey) await clearJourney(live);
            }).catch(error => ctx.log?.('[worldmap] campaign reveal recovery failed', error));
            await movementQueue;
        }
    });
    const positionContext = await freshCampaignContext(ctx);
    if (positionContext) {
        await hydratePosition(positionContext);
        journeyByCampaign.set(positionContext.data.campaignId, await readJourney(positionContext));
        await rememberJourneyPosition(positionContext);
    }
    await queueSolve(ctx);
    const initial = await freshCampaignContext(ctx);
    if (initial) {
        bindCampaignSubscriptions(initial);
        hardenedByCampaign.set(initial.data.campaignId, await readHardened(initial));
        await hardenCurrentCell(initial);
        await rememberTrails(initial, journeyByCampaign.get(initial.data.campaignId));
        await updateDiscoveries(initial);
    }
}

