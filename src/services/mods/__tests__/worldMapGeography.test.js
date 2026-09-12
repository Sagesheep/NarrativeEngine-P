import { describe, it, expect } from 'vitest';
import { BIOME_IDS, sampleField, sampleRawField, seedSalts, classifyBiome, ChunkStore, serializeHardened, deserializeHardened, buildWarpField } from '../../../../public/bundled-mods/worldmap/field.js';
import { TERRAIN_VOCABULARY, parseNeighborClause } from '../../../../public/bundled-mods/worldmap/solver.js';
import { BIOME_BASE_COST, TRAVEL_MODES, cellCost } from '../../../../public/bundled-mods/worldmap/pathfinder.js';
import { PIXEL_PALETTE, paintPixelCell } from '../../../../public/bundled-mods/worldmap/pixelArt.js';
import { eligibleLocalEvents, localScene } from '../../../../public/bundled-mods/worldmap/encounterScenes.js';
import { rollEncounter, weatherAt } from '../../../../public/bundled-mods/worldmap/encounters.js';
import { featureAtBlock, terrainDescription } from '../../../../public/bundled-mods/worldmap/discoveries.js';
const expanded = ['snow', 'volcanic', 'deadzone', 'sand', 'swamp'];
describe('G3 geography', () => {
    it('generates every biome as coherent seeded regions with cold poles and a warm equator', () => {
        const salts = seedSalts('g3-regions'), counts = new Map(); let neighbours = 0, same = 0;
        for (let y = 0; y < 1000; y += 8) for (let x = 0; x < 1000; x += 8) {
            const cell = sampleField(x, y, 'g3-regions', .65, [], salts);
            counts.set(cell.biome, (counts.get(cell.biome) ?? 0) + 1);
            const next = sampleField(x + 1, y, 'g3-regions', .65, [], salts);
            neighbours++; if (next.biome === cell.biome) same++;
            if (cell.biome === 'swamp') { expect(cell.elev).toBeLessThan(.18); expect(cell.moist).toBeGreaterThan(.25); }
            if (cell.biome === 'snow') expect(cell.temp).toBeLessThan(-.25);
            if (cell.elev < 0) expect(cell.biome).toBe('ocean');
        }
        expect([...counts.keys()].sort()).toEqual([...BIOME_IDS].sort());
        expect(same / neighbours).toBeGreaterThan(.88);
        for (const y of [0, 999]) {
            const average = Array.from({ length: 30 }, (_, x) => sampleRawField(x * 30, y, 'g3-regions', .65, salts).temp).reduce((a,b) => a+b)/30;
            expect(average).toBeLessThan(-.4);
        }
        expect(sampleRawField(500,500,'g3-regions',.65,salts).temp).toBeGreaterThan(.3);
        expect(sampleField(200,300,'g3-regions',.65)).toEqual(sampleField(200,300,'g3-regions',.65));
    });
    it.each(expanded)('%s has usable lore controls, saved terrain, unique pixel colours and physical scene content', biome => {
        const name = { deadzone: 'dead zone', sand: 'dry sand' }[biome] ?? biome;
        const clause = parseNeighborClause(`N: ${name} close`).clause;
        expect(clause).not.toBeNull();
        const target = clause.controlPoints[0].target;
        expect(target).toMatchObject(TERRAIN_VOCABULARY[biome]);
        expect(classifyBiome(target)).toBe(biome);
        const controls = buildWarpField([{ noiseResumeDistance: 10, controlPoints: [{ kind: 'terrain', x: 500, y: 500, target }] }]);
        expect(sampleField(500,500,'g3',.65,controls).biome).toBe(biome);
        const saved = deserializeHardened(serializeHardened(new Map([['500␟500', biome], ['501␟500', 'forest']])));
        const store = new ChunkStore('different-seed', .1, [], saved);
        expect(store.getCell(500,500).biome).toBe(biome); expect(store.getCell(501,500).biome).toBe('forest');
        expect(BIOME_BASE_COST[biome]).toBeGreaterThan(BIOME_BASE_COST.plains);
        expect(cellCost(store,500,500,TRAVEL_MODES.boat)).toBe(Infinity);
        expect(Number.isFinite(cellCost(store,500,500,TRAVEL_MODES.foot))).toBe(true);
        const colours = []; const ctx = { fillStyle: '', fillRect() { colours.push(this.fillStyle); } };
        paintPixelCell(ctx, { getCell: () => ({ biome }) }, 500,500,0,0,32);
        expect(colours[0]).toBe(PIXEL_PALETTE[biome]); expect(new Set(colours).size).toBeGreaterThan(2);
        expect(terrainDescription(biome, 'ruin')).not.toBe('');
        for (const worldProfile of ['fantasy','historical','modern','cyberpunk','scifi','postapoc']) {
            const input = { seed:'g3', x:500,y:500,worldDay:3,biome,worldProfile,onRoad:false,weather:'clear' };
            expect(eligibleLocalEvents(input).length).toBeGreaterThan(0);
            expect(eligibleLocalEvents(input).some(row => row.id === 'forest-bear')).toBe(false);
            expect(localScene(input)).toBeTruthy();
            const record = rollEncounter(input, () => 0);
            expect(record.events.length).toBeGreaterThan(0); expect(record.biome).toBe(biome);
        }
    });
    it('keeps carts out of deep snow, volcanic ground and swamps even when there is a road', () => {
        for (const biome of ['snow','volcanic','swamp']) expect(cellCost({ getCell:()=>({biome}) },0,0,TRAVEL_MODES.cart)).toBe(Infinity);
        for (const biome of ['sand','deadzone']) expect(Number.isFinite(cellCost({ getCell:()=>({biome}) },0,0,TRAVEL_MODES.cart))).toBe(true);
    });
    it('does not generate unsupported settlements in hostile terrain and uses snow precipitation', () => {
        for (const biome of expanded) for (let y=0;y<20;y++) for(let x=0;x<20;x++) {
            const site = featureAtBlock('g3',x,y,{getCell:()=>({biome})});
            expect(site?.type).not.toBe('settlement');
        }
        const weather = Array.from({length:100},(_,day)=>weatherAt('g3',500,500,day,'snow'));
        expect(weather).toContain('snow'); expect(weather).not.toContain('rain');
    });
});
