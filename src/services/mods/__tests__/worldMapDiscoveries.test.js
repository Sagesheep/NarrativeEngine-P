import { describe, it, expect } from 'vitest';
import { SITE_TYPES, minimumSiteDistance, featureAtBlock, readDiscoveries, serializeDiscoveries, surveyDiscoveries, nameDiscovery } from '../../../../public/bundled-mods/worldmap/discoveries.js';
const plains = { getCell: () => ({ biome: 'plains' }) };
function sites(seed, store = plains, road = () => false) {
    const result = [];
    for (let y = 1; y < 18; y++) for (let x = 1; x < 18; x++) {
        const site = featureAtBlock(seed, x, y, store, road);
        if (site) result.push(site);
    }
    return result;
}
describe('seeded discoveries', () => {
    it('is deterministic with per-type minimum spacing', () => {
        const all = sites('discovery-test');
        expect(all.length).toBeGreaterThan(30);
        expect(all).toEqual(sites('discovery-test'));
        for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
            expect(Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y)).toBeGreaterThanOrEqual(minimumSiteDistance(all[i], all[j]));
            if (all[i].type === all[j].type) expect(Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y)).toBeGreaterThanOrEqual(SITE_TYPES[all[i].type].spacing);
        }
        expect(sites('other-seed')).not.toEqual(all);
    });
    it('respects terrain and favours road-oriented sites without moving candidates', () => {
        expect(sites('discovery-test', { getCell: () => ({ biome: 'ocean' }) })).toEqual([]);
        const ordinary = sites('discovery-test');
        const roadside = sites('discovery-test', plains, () => true);
        expect(roadside.length).toBeGreaterThan(ordinary.length);
        for (const site of ordinary) expect(roadside.find(other => other.id === site.id)).toEqual(site);
    });
    it('revisits preserve identity, coordinates and surveyed absences after terrain/road changes', () => {
        const target = sites('discovery-test')[0];
        let state = readDiscoveries(null);
        expect(surveyDiscoveries(state, 'discovery-test', plains, target, null, 1)).toBe(true);
        expect(state.sites.has(target.id)).toBe(true);
        expect(nameDiscovery(state, target.id, 'The Quiet Bell', 'A cracked bell hangs above the doorway.')).toBe(true);
        state = readDiscoveries(JSON.parse(JSON.stringify(serializeDiscoveries(state))));
        const before = serializeDiscoveries(state);
        expect(surveyDiscoveries(state, 'discovery-test', { getCell: () => ({ biome: 'ocean' }) }, target, null, 20)).toBe(false);
        expect(serializeDiscoveries(state)).toEqual(before);
        expect(state.sites.get(target.id).name).toBe('The Quiet Bell');
    });
    it('exploration order produces the same sites', () => {
        const targets = sites('discovery-test').slice(0, 20);
        const first = readDiscoveries(null), second = readDiscoveries(null);
        for (const target of targets) surveyDiscoveries(first, 'discovery-test', plains, target, null, 1);
        for (const target of targets.reverse()) surveyDiscoveries(second, 'discovery-test', plains, target, null, 1);
        const sorted = state => [...state.sites.values()].sort((a, b) => a.id.localeCompare(b.id));
        expect(sorted(first)).toEqual(sorted(second));
    });
});
