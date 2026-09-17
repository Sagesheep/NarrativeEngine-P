import { applyStoryMovement } from '../../src/services/turn/applyStoryMovement';
import { buildMovementContract } from '../../src/services/turn/storyMovement';
import { buildLocationBlock, buildMapEncounterBlock, buildMapDiscoveriesBlock } from '../../src/services/payload/volatile';
import { WindowManager } from '../../src/components/WindowManager';
import { registerWindowDeclaration, openWindow } from '../../src/services/mods/mounts/windowStore';
import { buildHostFacade } from '../../src/services/turn/hostFacade';
import { buildModContext } from '../../src/services/mods/modContext';
import { buildCommitCallbacks, rebuildStateFromLiveStore } from '../../src/services/turn/pendingCommit';
import { openMapTravelPreview } from '../../src/services/turn/mapTravelPreview';
/* eslint-disable @typescript-eslint/no-explicit-any -- browser fixture crosses the untyped runtime mod API. */
// Real mod, canvas, React bridge and Zustand actions; only storage/host mounts
// are replaced. Session storage permits reload tests without touching saves.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { WorldMapTravelBridge } from '../../src/components/WorldMapTravelBridge';
import { useAppStore } from '../../src/store/useAppStore';
import { modEventBus } from '../../src/services/mods/events';
// Runtime asset imports are intentionally outside Vite module transforms.
const { onActivate, mapSnapshot, validJourney } = await (new Function('return import("/bundled-mods/worldmap/index.js")'))();

const stored = JSON.parse(sessionStorage.getItem('worldmap-fixture') || 'null');
const place = (id: string, name: string, other: string) => ({
    id, name, aliases: '', broadLocation: '', features: [], description: '',
    firstSeenScene: '1', lastSeenScene: '1', source: 'manual' as const,
    connections: [{ toId: other, band: 'remote' as const }],
});
useAppStore.setState(stored?.state ?? {
    activeCampaignId: 'worldmap-browser-fixture', messages: [],
    locationLedger: [place('a', 'Alder', 'b'), place('b', 'Birch', 'a')],
    context: { currentPlaceId: 'a', worldDay: 10, travelMode: 'flying', travel: null },
});
const tables: Record<string, any> = stored?.tables ?? {
    settings: { worldSeed: 'milestone-one', climateGradient: 0.65 },
    anchors: [], visited: [], journey: null,
};
const listeners = new Map<string, Set<() => void>>();
const tableListeners = new Map<string, Set<() => void>>();
function subscribe(map: Map<string, Set<() => void>>, key: string, fn: () => void) {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(fn);
    return () => map.get(key)!.delete(fn);
}
function save() {
    const { context, locationLedger, messages, activeCampaignId } = useAppStore.getState();
    sessionStorage.setItem('worldmap-fixture', JSON.stringify({ tables, state: { context, locationLedger, messages, activeCampaignId } }));
}
const windows: any[] = [];
const fixture: any = {
    get data() {
        const s = useAppStore.getState();
        return { campaignId: s.activeCampaignId, context: s.context, loreChunks: [],
            location: { ...s.context, ledger: s.locationLedger } };
    },
    table: {
        read: async (name: string) => tables[name] ?? null,
        write: async (name: string, value: any) => {
            tables[name] = value; save();
            for (const fn of tableListeners.get(name) ?? []) fn();
        },
        subscribe: (key: string, fn: () => void) => subscribe(tableListeners, key, fn),
    },
    mounts: {
        window: (options: any) => { windows.push(options); return { open() {}, close() {}, update() {}, remove() {}, focus() {} }; },
        header: () => ({ update() {}, remove() {} }),
    },
    subscribe: (key: string, fn: () => void) => subscribe(listeners, key, fn),
    refresh: async () => fixture,
    events: {
        on: (key: any, fn: any) => modEventBus.on(key, fn),
        emit: (key: string, value: any) => modEventBus.emit(`mod.worldmap.${key}` as any, value),
    },
    write: {
        updateContext: (patch: any) => useAppStore.getState().updateContext(patch),
        setLocationLedger: (ledger: any) => useAppStore.getState().setLocationLedger(ledger),
    },
    log: console.log,
};
// Exercise production frozen snapshots, refresh and reactive subscriptions.
function makeContext(): any {
    const current = () => rebuildStateFromLiveStore(useAppStore.getState(), '');
    const callbacks = () => buildCommitCallbacks(useAppStore.getState().activeCampaignId!, useAppStore.getState());
    const facade = buildHostFacade(current(), callbacks(), {
        reactiveStore: useAppStore, getState: current, getCallbacks: callbacks,
        table: {
            read: name => fixture.table.read(name.replace('mod.worldmap.', '')),
            write: async (name, value) => {
                await fixture.table.write(name.replace('mod.worldmap.', ''), value);
                useAppStore.setState(state => ({ modTables: { ...state.modTables, [name]: value } }));
            },
        },
    });
    return buildModContext({ mod: { id: 'worldmap', name: 'World Map', version: 'test' }, facade,
        mounts: fixture.mounts, refresh: async () => makeContext(),
        getLocationState: () => ({ ...useAppStore.getState().context, ledger: useAppStore.getState().locationLedger }),
    });
}
const lateCampaign = new URLSearchParams(location.search).has('lateCampaign');
const openingCampaign = useAppStore.getState().activeCampaignId;
if (lateCampaign) useAppStore.setState({ activeCampaignId: null });
const ctx = makeContext();
useAppStore.subscribe(save);
flushSync(() => createRoot(document.getElementById('bridge')!).render(React.createElement(WorldMapTravelBridge)));
await onActivate(ctx);
if (lateCampaign) {
    useAppStore.setState({ activeCampaignId: openingCampaign });
    modEventBus.emit('campaign.opened', { campaignId: openingCampaign! });
}
if (new URLSearchParams(location.search).has('realWindow')) {
    await import('../../src/index.css');
    const campaign = useAppStore.getState().activeCampaignId;
    useAppStore.setState({ activeCampaignId: null });
    const registrationContext = makeContext();
    useAppStore.setState({ activeCampaignId: campaign });
    registerWindowDeclaration('worldmap', 'World Map', windows.find(w => w.id === 'map-canvas'), 0, registrationContext);
    openWindow('mod.worldmap.map-canvas');
    flushSync(() => createRoot(document.getElementById('map')!).render(React.createElement(WindowManager)));
} else windows.find(w => w.id === 'map-canvas').mount(document.getElementById('map'), makeContext());
(window as any).worldmapTest = {
    storyMove: (movement: unknown) => applyStoryMovement(`<!-- MOVEMENT ${JSON.stringify(movement)} -->`, useAppStore.getState().activeCampaignId!),
    sceneContext: () => { const { context, locationLedger } = useAppStore.getState(); return [buildMovementContract(context, locationLedger), buildLocationBlock(context, locationLedger), buildMapEncounterBlock(context), buildMapDiscoveriesBlock(context)].join('\n'); },
    read: async () => { const live = await ctx.refresh(); return ({ ledger: useAppStore.getState().locationLedger, context: useAppStore.getState().context, messages: useAppStore.getState().messages, composerInjection: useAppStore.getState().composerInjection,
        snapshot: { party: mapSnapshot(live)?.party, locationId: mapSnapshot(live)?.locationId, visible: [...(mapSnapshot(live)?.visible ?? [])] }, journey: validJourney(tables.journey) ? tables.journey : null, trails: tables.trails, discoveries: tables.discoveries, encounters: tables.encounters, exploration: tables.exploration, roads: tables.roads }); },
    retentionScene: () => {
        const a = mapSnapshot(makeContext()).anchors.find((row: any) => row.locationId === 'a');
        const old = { x:a.x, y:a.y, worldDay:1, weather:'clear', biome:'plains', status:'passed', quiet:false, scene:'An old checkpoint.' };
        tables.encounters = { records: [
            { ...old, key:`1:${a.x}:${a.y}`, events:[{title:'Old merchant',text:'A trader offered rope.'}], note:'Bought rope.' },
            { ...old, x:a.x+1, key:`1:${a.x+1}:${a.y}`, pinned:true, events:[{title:'Pinned trader',text:'Return here later.'}] },
            { ...old, x:a.x+2, key:`1:${a.x+2}:${a.y}`, unresolved:true, events:[{title:'Missing parcel',text:'The parcel has not been found.'}] },
        ] };
        useAppStore.getState().updateContext({ worldDay:10, currentPlaceId:'a',travel:null }); save();
    },
    encounterScene: async () => {
        const { rollEncounter } = await (new Function('return import("/bundled-mods/worldmap/encounters.js")'))();
        const snapshot = mapSnapshot(makeContext());
        const party = snapshot.party ?? snapshot.anchors.find((row: any) => row.locationId === useAppStore.getState().context.currentPlaceId);
        const record = rollEncounter({ seed: 'milestone-one', x: party.x, y: party.y,
            worldDay: useAppStore.getState().context.worldDay, biome: 'forest', weather: 'clear', onRoad: true }, () => 0);
        tables.encounters = { records: [record] };
        tables.visited = [];
        for (let y = -24; y <= 24; y++) for (let x = -24; x <= 24; x++) tables.visited.push({ x: party.x + x, y: party.y + y, biome: 'forest' });
        tables.trails = { edges: [{ a: party, b: { x: party.x + 1, y: party.y }, passes: 3 }] };
        save();
    },
    biomeScene: () => {
        const anchor = mapSnapshot(makeContext()).anchors.find((row: any) => row.locationId === 'a');
        const biomes = ['snow', 'volcanic', 'deadzone', 'sand', 'swamp'];
        tables.visited = [];
        const cells: string[] = [];
        for (let dy = -24; dy <= 24; dy++) for (let dx = -35; dx <= 35; dx++) {
            const x = anchor.x + dx, y = anchor.y + dy;
            tables.visited.push({ x, y, biome: biomes[Math.min(4, Math.floor((dx + 35) / 14))] });
            cells.push(`${x},${y}`);
        }
        tables.exploration = { version: 2, cells, generatedCells: cells };
        useAppStore.getState().updateContext({ travel: null, travelMode: 'foot', currentPlaceId: 'a' });
        save();
    },
    forgetReveal: () => { tables.exploration = { version: 2, cells: [], generatedCells: [] }; save(); },
    terrain: (x: number, y: number) => mapSnapshot(makeContext()).chunkStore.getCell(x, y),
    artScene: () => {
        const anchor = mapSnapshot(makeContext()).anchors.find((row: any) => row.locationId === 'a');
        tables.visited = [];
        for (let y = -28; y <= 28; y++) for (let x = -28; x <= 28; x++) {
            const river = x >= 4 + Math.floor(y / 9) && x <= 6 + Math.floor(y / 9);
            const biome = river ? 'ocean' : (y < -5 || x < -10) ? 'forest' : y > 8 && x < 0 ? 'mountain' : x < -4 && y < 4 ? 'farmland' : 'plains';
            tables.visited.push({ x: anchor.x + x, y: anchor.y + y, biome });
        }
        tables.discoveries = { surveyed: [], sites: [
            { id: 'art-camp', x: anchor.x + 10, y: anchor.y + 2, biome: 'plains', type: 'camp', name: 'Willow Camp', description: '' },
            { id: 'art-ruin', x: anchor.x - 7, y: anchor.y + 6, biome: 'plains', type: 'ruin', name: 'Old Arch', description: '' },
        ] };
        tables.trails = { edges: Array.from({ length: 10 }, (_, i) => ({ a: { x: anchor.x - i, y: anchor.y }, b: { x: anchor.x - i - 1, y: anchor.y }, passes: 3 })), progress: [] };
        useAppStore.getState().updateContext({ travel: null, travelMode: 'foot', currentPlaceId: 'a' });
        save();
    },
    restoreJourney: (data: any) => {
        tables.journey = data.journey;
        useAppStore.getState().updateContext({ travel: data.travel, currentPlaceId: data.travel.transitId, worldDay: data.worldDay });
        save();
    },
    ground: () => {
        const anchors = mapSnapshot(makeContext()).anchors;
        const xs = anchors.map((a: any) => a.x), ys = anchors.map((a: any) => a.y);
        tables.visited = [];
        for (let x = Math.floor(Math.min(...xs)) - 4; x <= Math.ceil(Math.max(...xs)) + 4; x++) {
            for (let y = Math.floor(Math.min(...ys)) - 4; y <= Math.ceil(Math.max(...ys)) + 4; y++) {
                tables.visited.push({ x, y, biome: 'plains' });
            }
        }
        useAppStore.getState().updateContext({ travelMode: 'foot' });
        save();
    },
    anchors: () => mapSnapshot(makeContext()).anchors,
    plan: () => openMapTravelPreview('b', 'flying'),
    renamePlace: (id: string, name: string) => useAppStore.getState().updateLocation(id, { name }),
};
