import { expect, it } from 'vitest';
import { discoveryContent } from '../../../../public/bundled-mods/worldmap/discoveryContent.js';
import { featureAtBlock, readDiscoveries, serializeDiscoveries, surveyDiscoveries } from '../../../../public/bundled-mods/worldmap/discoveries.js';
it('offers diverse stable content and keeps technical settings free of pilgrim sites', () => {
    const variants = new Set();
    for (let x = 0; x < 200; x++) {
        const site = { x, y: 20, type: 'shrine', biome: 'plains' };
        const content = discoveryContent('test', site, 'cyberpunk');
        expect(content).toEqual(discoveryContent('test', site, 'cyberpunk'));
        expect(content.description.length).toBeGreaterThan(40);
        expect(content.name).not.toMatch(/Pilgrim|Bell|Standing Stones/);
        variants.add(content.contentVariant);
    }
    expect(variants.size).toBe(3);
});
it('restricts regional landmarks to their own terrain', () => {
    const pool = biome => new Set(Array.from({ length: 200 }, (_, x) => discoveryContent('terrain', { x, y: 10, type: 'landmark', biome }).contentVariant));
    expect(pool('volcanic').has('Ash Vent')).toBe(true);
    expect(pool('plains').has('Ash Vent')).toBe(false);
    expect(pool('sand').has('Wind-carved Spire')).toBe(true);
});
it('persists generated content and does not rewrite it after a setting change', () => {
    const store = { getCell: () => ({ biome: 'plains' }) };
    let site;
    for (let x = 1; x < 100 && !site; x++) site = featureAtBlock('saved', x, 10, store, undefined, 'scifi');
    expect(site.name.length).toBeGreaterThan(3);
    const state = readDiscoveries(null);
    surveyDiscoveries(state, 'saved', store, site, null, 1, [], 'scifi');
    const saved = serializeDiscoveries(state);
    const loaded = readDiscoveries(JSON.parse(JSON.stringify(saved)));
    surveyDiscoveries(loaded, 'saved', store, site, null, 2, [], 'fantasy');
    expect(serializeDiscoveries(loaded)).toEqual(saved);
});
