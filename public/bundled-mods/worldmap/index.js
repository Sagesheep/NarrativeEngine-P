import { solveWorldMap } from './solver.js';
import { mountMapRenderer } from './renderer.js';
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
        button.disabled = true;
        button.textContent = 'Solving…';
        await queueSolve(ctx);
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

