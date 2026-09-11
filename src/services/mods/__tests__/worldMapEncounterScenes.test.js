import { it, expect } from 'vitest';
import { eligibleLocalEvents, localEvent, localScene } from '../../../../public/bundled-mods/worldmap/encounterScenes.js';

it('only selects road travellers where a physical worn trail exists', () => {
    for (const biome of ['forest', 'plains', 'marsh', 'desert']) {
        expect(eligibleLocalEvents({ biome, onRoad: false }).some(row => row.road)).toBe(false);
        expect(eligibleLocalEvents({ biome, onRoad: true }).some(row => row.id === 'road-merchant')).toBe(true);
    }
    for (const biome of ['ocean', 'glacier']) expect(eligibleLocalEvents({ biome, onRoad: true }).some(row => row.road)).toBe(false);
});
it('restricts bears to forest and taiga while providing other biome-specific scenes', () => {
    for (const biome of ['forest', 'taiga']) expect(eligibleLocalEvents({ biome }).some(row => row.id === 'forest-bear')).toBe(true);
    for (const biome of ['ocean', 'desert', 'marsh', 'glacier', 'farmland', 'mountain']) {
        const eligible = eligibleLocalEvents({ biome });
        expect(eligible.length).toBeGreaterThan(0);
        expect(eligible.some(row => row.id === 'forest-bear')).toBe(false);
    }
});
it('varies eligible scenes while keeping identities stable for the same saved encounter', () => {
    const input = { seed: 'world', x: 10, y: 8, worldDay: 4, biome: 'forest', onRoad: true };
    const variants = new Set(Array.from({ length: 20 }, (_, i) => localEvent(input, () => i / 20).id));
    expect(variants.size).toBeGreaterThan(3);
    expect(localEvent(input, () => 0)).toEqual(localEvent(input, () => 0));
    expect(localScene(input)).toEqual(localScene({ ...input, worldDay: 20 }));
    expect(localScene(input)).toContain('worn trail');
});


it('filters technology by world setting and excludes Earth wildlife from science-fiction rolls', () => {
    const input = { biome: 'forest', onRoad: true };
    const ids = profile => eligibleLocalEvents({ ...input, worldProfile: profile }).map(row => row.id);
    expect(ids('fantasy')).toContain('road-merchant');
    expect(ids('historical')).not.toContain('cyberpunk-drone');
    expect(ids('modern')).toContain('modern-ranger');
    expect(ids('modern')).not.toContain('road-merchant');
    expect(ids('cyberpunk')).toContain('cyberpunk-vendor');
    expect(ids('cyberpunk')).toContain('cyberpunk-courier');
    expect(ids('cyberpunk')).not.toContain('road-merchant');
    expect(ids('scifi')).toContain('scifi-technician');
    expect(ids('scifi')).not.toContain('forest-bear');
    expect(ids('postapoc')).toContain('postapoc-trader');
    expect(ids('postapoc')).not.toContain('cyberpunk-drone');
});
it('retains several eligible cyberpunk encounters away from roads without inventing a road vendor', () => {
    const rows = eligibleLocalEvents({ worldProfile: 'cyberpunk', biome: 'desert', onRoad: false });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.some(row => row.road)).toBe(false);
});
