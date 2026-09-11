import { FIELD_WORLD_SIZE } from './field.js';
// Seeded slots are independent of view order. Only observed sites are persisted.
export const SITE_TYPES = Object.freeze({
    settlement: { label: 'Settlement', spacing: 8, density: 0.55 },
    ruin: { label: 'Ruins', spacing: 5, density: 0.7 },
    shrine: { label: 'Shrine', spacing: 4, density: 0.65 },
    camp: { label: 'Campsite', spacing: 3, density: 0.8 },
    crossing: { label: 'Crossing', spacing: 4, density: 0.55 },
    landmark: { label: 'Landmark', spacing: 5, density: 0.8 },
});
function hash(text) {
    let value = 2166136261;
    for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
    value ^= value >>> 16; value = Math.imul(value, 2246822507); value ^= value >>> 13;
    return value >>> 0;
}
const types = Object.keys(SITE_TYPES);
export const SETTLEMENT_SPACING = Object.freeze({ village: 8, town: 12, city: 24, capital: 40 });
export function minimumSiteDistance(a, b) {
    if (a.type === 'wilderness' || b.type === 'wilderness') return 0;
    if (a.type === 'settlement' && b.type === 'settlement') return Math.min(SETTLEMENT_SPACING[a.settlementKind] ?? 12, SETTLEMENT_SPACING[b.settlementKind] ?? 12);
    return a.type === b.type ? SITE_TYPES[a.type]?.spacing ?? 2 : 2;
}
export function canPlaceSite(site, existing) {
    return !existing.some(other => other.type !== 'wilderness' && other.id !== site.id && (other.x === site.x && other.y === site.y
        || Math.hypot(other.x - site.x, other.y - site.y) < minimumSiteDistance(site, other)));
}
function candidate(seed, bx, by) {
    const key = `${seed}:${bx}:${by}`;
    const h = hash(key);
    return { x: bx * 4 + h % 4, y: by * 4 + (h >>> 4) % 4,
        type: types[(h >>> 8) % types.length], settlementKind: ['village', 'village', 'village', 'village', 'town', 'town', 'city', 'capital'][(h >>> 16) % 8], priority: hash(`${key}:priority`), roll: hash(`${key}:density`) / 4294967296 };
}
export function featureAtBlock(seed, bx, by, store, nearTrail = () => false) {
    const site = candidate(seed, bx, by);
    if (site.x < 0 || site.y < 0 || site.x >= FIELD_WORLD_SIZE || site.y >= FIELD_WORLD_SIZE) return null;
    const spec = SITE_TYPES[site.type];
    // Compare against raw neighbours, so spacing cannot depend on which
    // region was visited first, on terrain eligibility, or on road wear.
    const reach = site.type === 'settlement' ? 10 : 2;
    for (let y = by - reach; y <= by + reach; y++) for (let x = bx - reach; x <= bx + reach; x++) {
        if (x === bx && y === by) continue;
        const other = candidate(seed, x, y);
        if (Math.hypot(other.x - site.x, other.y - site.y) < minimumSiteDistance(site, other)
            && (other.priority < site.priority || (other.priority === site.priority && `${x},${y}` < `${bx},${by}`))) return null;
    }
    const biome = store.getCell(site.x, site.y).biome;
    if (biome === 'ocean' || biome === 'glacier') return null;
    if (site.type === 'crossing' && !['marsh', 'forest', 'plains', 'farmland'].includes(biome)) return null;
    if (site.type === 'settlement' && ['mountain', 'jungle', 'marsh'].includes(biome)) return null;
    const density = ['plains', 'farmland', 'forest', 'savanna'].includes(biome) ? 1 : 0.45;
    const roadAffinity = ['settlement', 'camp', 'crossing'].includes(site.type) && nearTrail(site.x, site.y) ? 1.35 : 1;
    if (site.roll > spec.density * density * roadAffinity) return null;
    return { id: `site-${hash(seed).toString(16)}-${site.x}-${site.y}`, x: site.x, y: site.y,
        type: site.type, ...(site.type === 'settlement' ? { settlementKind: site.settlementKind } : {}), biome, name: '', description: '' };
}
export function readDiscoveries(raw) {
    const sites = new Map();
    for (const site of Array.isArray(raw?.sites) ? raw.sites : []) {
        if (typeof site?.id !== 'string' || (!SITE_TYPES[site.type] && site.type !== 'wilderness')
            || !Number.isSafeInteger(site.x) || !Number.isSafeInteger(site.y)) continue;
        sites.set(site.id, { ...site, name: String(site.name ?? '').slice(0, 80), description: String(site.description ?? '').slice(0, 600) });
    }
    return { sites, surveyed: new Set((Array.isArray(raw?.surveyed) ? raw.surveyed : []).filter(key => typeof key === 'string')) };
}
export function serializeDiscoveries(state) { return { sites: [...state.sites.values()], surveyed: [...state.surveyed] }; }
export function siteLabel(site) { return site.name || (site.settlementKind ? site.settlementKind.charAt(0).toUpperCase() + site.settlementKind.slice(1) : SITE_TYPES[site.type]?.label) || 'Wilderness'; }
export function surveyDiscoveries(state, seed, store, centre, trails, worldDay, existing = []) {
    let changed = false;
    const nearTrail = (x, y) => [...(trails?.edges.values() ?? [])].some(edge =>
        Math.min(Math.hypot(edge.a.x - x, edge.a.y - y), Math.hypot(edge.b.x - x, edge.b.y - y)) <= 2);
    for (let by = Math.floor((centre.y - 2) / 4); by <= Math.floor((centre.y + 2) / 4); by++) {
        for (let bx = Math.floor((centre.x - 2) / 4); bx <= Math.floor((centre.x + 2) / 4); bx++) {
            const candidateCell = candidate(seed, bx, by);
            if (Math.hypot(candidateCell.x - centre.x, candidateCell.y - centre.y) > 2) continue;
            const key = `${bx},${by}`;
            if (state.surveyed.has(key)) continue;
            state.surveyed.add(key); changed = true;
            const site = featureAtBlock(seed, bx, by, store, nearTrail);
            if (site && !state.sites.has(site.id) && canPlaceSite(site, [...existing, ...state.sites.values()])) state.sites.set(site.id, { ...site, discoveredOnDay: worldDay });
        }
    }
    return changed;
}
export function nearbyDiscoveries(state, centre) {
    if (!centre) return [];
    return [...state.sites.values()].map(site => ({ ...site, distance: Math.hypot(site.x - centre.x, site.y - centre.y) }))
        .filter(site => site.distance <= 2).sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
}
export function nameDiscovery(state, id, name, description) {
    const site = state.sites.get(id);
    if (!site) return false;
    state.sites.set(id, { ...site, name: String(name ?? '').trim().slice(0, 80), description: String(description ?? '').trim().slice(0, 600) });
    return true;
}
