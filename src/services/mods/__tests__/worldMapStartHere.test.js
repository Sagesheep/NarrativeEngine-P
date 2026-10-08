import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Stub only the paint entry point (jsdom has no 2D canvas); keep the rest of
// the renderer module, which `index.js` also imports from.
vi.mock('../../../../public/bundled-mods/worldmap/renderer.js', async importOriginal => ({
    ...(await importOriginal()),
    mountMapRenderer: vi.fn((node, options) => {
        rendererOptions = options;
        return () => undefined;
    }),
}));

let rendererOptions = null;

const { onActivate, mapSnapshot, solveAndPersist, movablePlaces } = await import('../../../../public/bundled-mods/worldmap/index.js');
const { fixedSiteAnchors, placeAtCell } = await import('../../../../public/bundled-mods/worldmap/siteTravel.js');

/**
 * A party with no spot on the map could not do anything with it: every click
 * was refused with "No current place" or "Current place has no map anchor",
 * and nothing on the map offered a way out. These tests drive the REAL
 * `mountMap` through the callbacks the renderer would call, and assert what
 * lands in the ledger, the context and the mod tables.
 */
const FIXED_SETTINGS = { worldSeed: 'start-here-fixed-seed', climateGradient: 0.5 };
let campaignCounter = 0;

function place(id, name, extra = {}) {
    return { id, name, aliases: '', broadLocation: '', features: [], description: '', firstSeenScene: '1',
        lastSeenScene: '1', source: 'manual', connections: [], ...extra };
}

// Two places pinned well apart so the cells used below are known to be empty.
function pinnedLedger() {
    return [
        place('a', 'Alder', { coordinates: { x: 400, y: 400 }, connections: [{ toId: 'b', band: 'regional' }] }),
        place('b', 'Birch', { coordinates: { x: 420, y: 400 }, connections: [{ toId: 'a', band: 'regional' }] }),
    ];
}

function makeContext({ ledger = pinnedLedger(), currentPlaceId = null, travel = null, tables: seed = {} } = {}) {
    const tables = { settings: { ...FIXED_SETTINGS }, anchors: [], visited: [], journey: null, ...seed };
    const windowMounts = [];
    const windowHandle = { open: vi.fn(), close: vi.fn(), focus: vi.fn(), update: vi.fn(), remove: vi.fn() };
    const subscribers = {};
    const ctx = {
        data: {
            campaignId: `campaign-start-here-${++campaignCounter}`,
            loreChunks: [],
            context: {},
            location: { currentPlaceId, currentFeature: null, worldDay: 5, travel, travelMode: 'flying', ledger },
        },
        table: {
            read: vi.fn(async name => tables[name] ?? null),
            write: vi.fn(async (name, value) => { tables[name] = value; }),
            subscribe: vi.fn(() => () => undefined),
        },
        mounts: {
            window: vi.fn(options => { windowMounts.push(options); return windowHandle; }),
            header: vi.fn(() => ({ update: vi.fn(), remove: vi.fn() })),
        },
        events: { on: vi.fn(() => () => undefined), emit: vi.fn() },
        subscribe: vi.fn((key, fn) => { (subscribers[key] ??= []).push(fn); return () => undefined; }),
        // The host replaces the ledger and context wholesale, as the store does.
        write: {
            setLocationLedger: vi.fn(next => { ctx.data.location = { ...ctx.data.location, ledger: next }; }),
            updateContext: vi.fn(patch => { ctx.data.location = { ...ctx.data.location, ...patch }; }),
        },
        refresh: vi.fn(async () => ctx),
        log: vi.fn(),
    };
    return { ctx, tables, windowMounts, subscribers };
}

async function mountMapPanel(fixture) {
    const options = fixture.windowMounts.find(mount => mount.id === 'map-canvas');
    const node = document.createElement('div');
    document.body.append(node);
    const cleanup = options.mount(node, fixture.ctx);
    await new Promise(resolve => setTimeout(resolve, 0));
    return cleanup;
}

const ledgerOf = fixture => fixture.ctx.data.location.ledger;
const entry = (fixture, id) => ledgerOf(fixture).find(row => row.id === id);
const writesTo = (fixture, name) => fixture.ctx.table.write.mock.calls.filter(([table]) => table === name);
const emitted = fixture => fixture.ctx.events.emit.mock.calls.map(([name]) => name);
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('world map — Start here when the party has no spot', () => {
    let fixture;
    let cleanup;

    async function boot(options) {
        rendererOptions = null;
        fixture = makeContext(options);
        await onActivate(fixture.ctx);
        cleanup = await mountMapPanel(fixture);
    }

    afterEach(() => {
        cleanup?.();
        cleanup = null;
        document.body.replaceChildren();
    });

    it('no current place: the refusal asks where the party is and carries the clicked cell', async () => {
        await boot();
        rendererOptions.onClickCell(410, 410);
        expect(rendererOptions.getRoutePreview()).toMatchObject({
            blocked: true, reason: 'no-current-place',
            label: 'Where is the party? Choose a cell and press Start here.',
            startCell: { x: 410, y: 410 },
        });
    });

    it('Start here on an empty cell creates a position record there without travelling', async () => {
        await boot();
        const before = ledgerOf(fixture);
        rendererOptions.onClickCell(410, 410);
        rendererOptions.onRouteAction('startHere');
        await vi.waitFor(() => expect(fixture.ctx.data.location.currentPlaceId).toMatch(/^point-/));

        const id = fixture.ctx.data.location.currentPlaceId;
        expect(entry(fixture, id)).toMatchObject({
            name: 'Exploration point (410, 410)', recordKind: 'position',
            coordinates: { x: 410, y: 410 }, connections: [],
        });
        // Nobody travelled here, so no road was added to either place.
        expect(entry(fixture, 'a').connections).toEqual(before[0].connections);
        expect(entry(fixture, 'b').connections).toEqual(before[1].connections);
        expect(fixture.tables.discoveries.sites).toContainEqual(expect.objectContaining({ id, x: 410, y: 410, type: 'wilderness' }));
        expect(fixture.ctx.data.location.travel).toBeNull();
        expect(fixture.ctx.data.location.worldDay).toBe(5);
        expect(fixture.ctx.write.updateContext).toHaveBeenCalledWith({ currentPlaceId: id, currentFeature: null, travel: null });
        expect(emitted(fixture)).not.toContain('travelRequest');
        expect(writesTo(fixture, 'journey')).toHaveLength(0);
        expect(rendererOptions.getRoutePreview()).toBeNull();
        // The map now has the party there, and an ordinary click routes from it.
        expect(mapSnapshot(fixture.ctx).anchors.find(anchor => anchor.locationId === id)).toMatchObject({ x: 410, y: 410 });
        rendererOptions.onClickCell(400, 400);
        expect(rendererOptions.getRoutePreview()).toMatchObject({ toAnchor: { locationId: 'a' } });
        expect(rendererOptions.getRoutePreview().blocked).toBeFalsy();
    });

    it('Start here works outside Edit world and reuses the same record for the same cell', async () => {
        await boot();
        rendererOptions.onClickCell(410, 410);
        rendererOptions.onRouteAction('startHere');
        await vi.waitFor(() => expect(fixture.ctx.data.location.currentPlaceId).toMatch(/^point-/));
        const id = fixture.ctx.data.location.currentPlaceId;
        fixture.ctx.write.updateContext({ currentPlaceId: null });
        rendererOptions.onClickCell(410, 410);
        rendererOptions.onRouteAction('startHere');
        await vi.waitFor(() => expect(fixture.ctx.data.location.currentPlaceId).toBe(id));
        expect(ledgerOf(fixture).filter(row => row.id === id)).toHaveLength(1);
    });

    it('Start here on a place’s exact cell makes that place current without adding records', async () => {
        await boot();
        const before = ledgerOf(fixture);
        rendererOptions.onClickCell(420, 400);
        expect(rendererOptions.getRoutePreview().reason).toBe('no-current-place');
        rendererOptions.onRouteAction('startHere');
        await vi.waitFor(() => expect(fixture.ctx.data.location.currentPlaceId).toBe('b'));
        expect(ledgerOf(fixture)).toBe(before);
        expect(fixture.tables.discoveries ?? null).toBeNull();
        expect(fixture.ctx.data.location.worldDay).toBe(5);
        expect(fixture.ctx.data.location.travel).toBeNull();
    });

    it('a current place with no map position is given the chosen cell (shared contract)', async () => {
        const pending = place('c', 'Cedar Hall', {
            knowledge: 'known', placement: { preferredBiomes: ['forest'], reason: 'from the story' },
            placementPendingUntil: Date.now() + 600_000, placementIssue: 'No compatible site', terrainBiome: 'forest', terrainRadius: 6,
        });
        await boot({ ledger: [...pinnedLedger(), pending], currentPlaceId: 'c' });
        rendererOptions.onClickCell(430, 430);
        expect(rendererOptions.getRoutePreview()).toMatchObject({
            reason: 'no-current-anchor',
            label: 'Your current place has no map position yet. Choose a cell and press Start here.',
            startCell: { x: 430, y: 430 },
        });
        const count = ledgerOf(fixture).length;
        const before = entry(fixture, 'c');
        rendererOptions.onRouteAction('startHere');
        await vi.waitFor(() => expect(entry(fixture, 'c').coordinates).toEqual({ x: 430, y: 430 }));

        const c = entry(fixture, 'c');
        for (const field of ['placementPendingUntil', 'placementIssue', 'terrainBiome', 'terrainRadius']) expect(c).not.toHaveProperty(field);
        expect(c).toMatchObject({ knowledge: before.knowledge, placement: pending.placement, name: 'Cedar Hall' });
        expect(c.knowledge).toBeTruthy();
        expect(ledgerOf(fixture)).toHaveLength(count);
        await vi.waitFor(() => expect(fixture.ctx.write.updateContext).toHaveBeenCalledWith({ currentPlaceId: 'c', currentFeature: null, travel: null }));
        expect(fixture.ctx.data.location.worldDay).toBe(5);
        await solveAndPersist(fixture.ctx);
        expect(mapSnapshot(fixture.ctx).anchors.find(anchor => anchor.locationId === 'c')).toMatchObject({ x: 430, y: 430 });
    });

    it('Start here is not offered once the party has a place', async () => {
        await boot({ currentPlaceId: 'a' });
        rendererOptions.onClickCell(410, 410);
        expect(rendererOptions.getRoutePreview().startCell).toBeUndefined();
        rendererOptions.onRouteAction('startHere');
        await settle();
        expect(fixture.ctx.data.location.currentPlaceId).toBe('a');
        expect(fixture.ctx.write.updateContext.mock.calls.some(([patch]) => 'currentPlaceId' in patch)).toBe(false);
    });
});

describe('world map — Correct player position and Move a place here (Edit world)', () => {
    let fixture;
    let cleanup;

    async function boot(options) {
        rendererOptions = null;
        fixture = makeContext(options);
        await onActivate(fixture.ctx);
        cleanup = await mountMapPanel(fixture);
    }

    afterEach(() => {
        cleanup?.();
        cleanup = null;
        document.body.replaceChildren();
    });

    it('Correct player position on an empty cell puts the party on that exact cell', async () => {
        await boot({ currentPlaceId: 'a' });
        rendererOptions.onContextAction('current', { x: 450, y: 450, locationId: null });
        await settle();
        expect(fixture.ctx.data.location.currentPlaceId).toBe('a');

        rendererOptions.onRouteAction('worldEditing', true);
        rendererOptions.onContextAction('current', { x: 450, y: 450, locationId: null });
        await vi.waitFor(() => expect(fixture.ctx.data.location.currentPlaceId).toMatch(/^point-/));
        const id = fixture.ctx.data.location.currentPlaceId;
        expect(entry(fixture, id)).toMatchObject({ coordinates: { x: 450, y: 450 }, recordKind: 'position', connections: [] });
        expect(fixture.ctx.data.location.travel).toBeNull();
        expect(fixture.ctx.data.location.worldDay).toBe(5);
        expect(mapSnapshot(fixture.ctx).anchors.find(anchor => anchor.locationId === id)).toMatchObject({ x: 450, y: 450 });
    });

    it('cells outside the world are refused with a message and no write', async () => {
        await boot({ currentPlaceId: 'a' });
        rendererOptions.onRouteAction('worldEditing', true);
        const writes = fixture.ctx.write.setLocationLedger.mock.calls.length;
        rendererOptions.onContextAction('current', { x: -1, y: 5, locationId: null });
        await vi.waitFor(() => expect(rendererOptions.getRoutePreview()).toMatchObject({ blocked: true, reason: 'outside-world', label: 'Choose a cell inside the map' }));
        rendererOptions.onRouteAction('cancel');
        rendererOptions.onContextAction('move', { x: 1000, y: 5, placeId: 'b' });
        await vi.waitFor(() => expect(rendererOptions.getRoutePreview()).toMatchObject({ reason: 'outside-world' }));
        expect(fixture.ctx.write.setLocationLedger.mock.calls.length).toBe(writes);
        expect(fixture.ctx.data.location.currentPlaceId).toBe('a');
    });

    it('Correct player position near a place keeps choosing that place', async () => {
        await boot({ currentPlaceId: 'a' });
        rendererOptions.onRouteAction('worldEditing', true);
        rendererOptions.onContextAction('current', { x: 421, y: 401, locationId: 'b' });
        expect(fixture.ctx.data.location.currentPlaceId).toBe('b');
        expect(ledgerOf(fixture)).toHaveLength(2);
    });

    it('lists only authored places, by name, as movable', () => {
        const rows = [place('z', 'Zephyr'), place('m', 'Mill'), place('t', 'Road between Mill and Zephyr', { kind: 'transit' }),
            place('p', 'Exploration point (1, 2)', { recordKind: 'position' }), place('r', 'Kingsway', { recordKind: 'route' })];
        expect(movablePlaces(rows)).toEqual([{ id: 'm', name: 'Mill' }, { id: 'z', name: 'Zephyr' }]);
    });

    it('Move a place here writes the shared contract and the map follows at once', async () => {
        const ledger = pinnedLedger();
        ledger[1] = { ...ledger[1], knowledge: 'known', placement: { distanceBand: 'local' }, placementIssue: 'old issue',
            terrainBiome: 'forest', terrainRadius: 6, status: 'busy market' };
        await boot({ ledger, currentPlaceId: 'a' });
        const alder = entry(fixture, 'a');
        rendererOptions.onContextAction('move', { x: 440, y: 440, placeId: 'b' });
        await settle();
        expect(entry(fixture, 'b').coordinates).toEqual({ x: 420, y: 400 });

        rendererOptions.onRouteAction('worldEditing', true);
        rendererOptions.onContextAction('move', { x: 440, y: 440, placeId: 'b' });
        await vi.waitFor(() => expect(entry(fixture, 'b').coordinates).toEqual({ x: 440, y: 440 }));
        const b = entry(fixture, 'b');
        for (const field of ['placementPendingUntil', 'placementIssue', 'terrainBiome', 'terrainRadius']) expect(b).not.toHaveProperty(field);
        expect(b).toMatchObject({ knowledge: 'known', placement: { distanceBand: 'local' }, status: 'busy market', connections: ledger[1].connections });
        expect(entry(fixture, 'a')).toBe(alder);
        expect(fixture.ctx.data.location.currentPlaceId).toBe('a');
        expect(fixture.ctx.data.location.worldDay).toBe(5);
        // The snapshot is rebuilt from the new ledger before any re-solve lands.
        expect(mapSnapshot(fixture.ctx).anchors.find(anchor => anchor.locationId === 'b')).toMatchObject({ x: 440, y: 440 });
        await solveAndPersist(fixture.ctx);
        expect(entry(fixture, 'b').coordinates).toEqual({ x: 440, y: 440 });
        expect(mapSnapshot(fixture.ctx).anchors.find(anchor => anchor.locationId === 'b')).toMatchObject({ x: 440, y: 440 });
    });

    it('Move a place here refuses a cell another place occupies, with a message and no write', async () => {
        await boot({ currentPlaceId: 'a' });
        rendererOptions.onRouteAction('worldEditing', true);
        const writes = fixture.ctx.write.setLocationLedger.mock.calls.length;
        rendererOptions.onContextAction('move', { x: 400, y: 400, placeId: 'b' });
        await vi.waitFor(() => expect(rendererOptions.getRoutePreview()).toMatchObject({
            blocked: true, notice: true, reason: 'move-occupied', label: 'Alder is already at 400, 400. Choose another cell.',
        }));
        expect(fixture.ctx.write.setLocationLedger.mock.calls.length).toBe(writes);
        expect(entry(fixture, 'b').coordinates).toEqual({ x: 420, y: 400 });
    });

    it('Move a place here refuses mid-journey', async () => {
        await boot({ currentPlaceId: 'a' });
        rendererOptions.onRouteAction('worldEditing', true);
        fixture.ctx.data.location = { ...fixture.ctx.data.location, currentPlaceId: 'transit-a-b',
            travel: { fromId: 'a', toId: 'b', transitId: 'transit-a-b', mode: 'foot', leg: 1, totalLegs: 3, agency: 'free' } };
        const writes = fixture.ctx.write.setLocationLedger.mock.calls.length;
        rendererOptions.onContextAction('move', { x: 440, y: 440, placeId: 'b' });
        await vi.waitFor(() => expect(rendererOptions.getRoutePreview()).toMatchObject({
            blocked: true, reason: 'move-journey', label: 'Abandon the journey before moving places',
        }));
        expect(fixture.ctx.write.setLocationLedger.mock.calls.length).toBe(writes);
        expect(entry(fixture, 'b').coordinates).toEqual({ x: 420, y: 400 });
    });

    it('moving a promoted discovery site moves its discovery cell too', async () => {
        const site = { id: 'site-arch', x: 405, y: 405, type: 'ruin', name: 'Old Arch', description: '', biome: 'plains' };
        const ledger = [...pinnedLedger(), place('site-arch', 'Old Arch', { coordinates: { x: 405, y: 405 }, recordKind: 'place' })];
        await boot({ ledger, currentPlaceId: 'a', tables: { discoveries: { sites: [site], surveyed: [] } } });
        rendererOptions.onRouteAction('worldEditing', true);
        rendererOptions.onContextAction('move', { x: 445, y: 445, placeId: 'site-arch' });
        await vi.waitFor(() => expect(entry(fixture, 'site-arch').coordinates).toEqual({ x: 445, y: 445 }));
        expect(fixture.tables.discoveries.sites.find(row => row.id === 'site-arch')).toMatchObject({ x: 445, y: 445, name: 'Old Arch' });
        expect(mapSnapshot(fixture.ctx).anchors.find(anchor => anchor.locationId === 'site-arch')).toMatchObject({ x: 445, y: 445 });
    });

    it('moving the current place drops the camp it left behind so the party follows it', async () => {
        await boot({ currentPlaceId: 'a', tables: { position: { x: 402, y: 401, placeId: 'a' } } });
        expect(mapSnapshot(fixture.ctx).party).toEqual({ x: 402, y: 401 });
        rendererOptions.onRouteAction('worldEditing', true);
        rendererOptions.onContextAction('move', { x: 460, y: 460, placeId: 'a' });
        await vi.waitFor(() => expect(entry(fixture, 'a').coordinates).toEqual({ x: 460, y: 460 }));
        expect(fixture.tables.position).toEqual({});
        expect(mapSnapshot(fixture.ctx).party).toBeNull();
        expect(mapSnapshot(fixture.ctx).anchors.find(anchor => anchor.locationId === 'a')).toMatchObject({ x: 460, y: 460 });
    });
});

describe('world map — ledger coordinates are authoritative for promoted sites', () => {
    beforeEach(() => { rendererOptions = null; });

    it('fixedSiteAnchors prefers a promoted site’s ledger coordinates over its discovery cell', () => {
        const site = { id: 's', x: 4, y: 4, type: 'shrine' };
        const moved = fixedSiteAnchors({ anchors: [] }, [site], [{ id: 's', name: 'Shrine', connections: [], coordinates: { x: 9, y: 2 } }]);
        expect(moved.find(anchor => anchor.locationId === 's')).toMatchObject({ x: 9, y: 2, source: 'discovery', name: 'Shrine' });
        const unplaced = fixedSiteAnchors({ anchors: [] }, [site], [{ id: 's', name: 'Shrine', connections: [] }]);
        expect(unplaced.find(anchor => anchor.locationId === 's')).toMatchObject({ x: 4, y: 4 });
    });

    it('placeAtCell sets coordinates, drops placement state and keeps everything else', () => {
        const before = place('p', 'Pier', { knowledge: 'rumoured', placement: { direction: 'n' }, placementPendingUntil: 1,
            placementIssue: 'x', terrainBiome: 'marsh', terrainRadius: 4, coordinates: { x: 1, y: 1 } });
        const after = placeAtCell(before, { x: 7, y: 8 });
        expect(after).toEqual({ ...place('p', 'Pier', { knowledge: 'rumoured', placement: { direction: 'n' } }), coordinates: { x: 7, y: 8 } });
        expect(before.coordinates).toEqual({ x: 1, y: 1 });
    });

    it('a solve syncs a site moved in the Places panel into the discoveries table, once', async () => {
        const site = { id: 'site-arch', x: 405, y: 405, type: 'ruin', name: 'Old Arch', description: '', biome: 'plains' };
        const fixture = makeContext({ ledger: [...pinnedLedger(), place('site-arch', 'Old Arch', { coordinates: { x: 405, y: 405 }, recordKind: 'place' })],
            currentPlaceId: 'a', tables: { discoveries: { sites: [site], surveyed: [] } } });
        await onActivate(fixture.ctx);
        // The Places panel writes coordinates and nothing else of the map's.
        fixture.ctx.write.setLocationLedger(ledgerOf(fixture).map(row => row.id === 'site-arch' ? placeAtCell(row, { x: 470, y: 470 }) : row));
        fixture.ctx.table.write.mockClear();
        await solveAndPersist(fixture.ctx);
        expect(writesTo(fixture, 'discoveries')).toHaveLength(1);
        expect(fixture.tables.discoveries.sites.find(row => row.id === 'site-arch')).toMatchObject({ x: 470, y: 470, name: 'Old Arch' });
        expect(mapSnapshot(fixture.ctx).anchors.find(anchor => anchor.locationId === 'site-arch')).toMatchObject({ x: 470, y: 470 });
        fixture.ctx.table.write.mockClear();
        await solveAndPersist(fixture.ctx);
        expect(writesTo(fixture, 'discoveries')).toHaveLength(0);
    });
});
