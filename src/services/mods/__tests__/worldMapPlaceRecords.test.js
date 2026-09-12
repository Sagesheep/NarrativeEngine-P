import { solveWorldMap } from '../../../../public/bundled-mods/worldmap/solver.js';
import { it, expect } from 'vitest';
import { isTemporaryPlace, reconcilePlaceRecords } from '../../../../public/bundled-mods/worldmap/placeRecords.js';
import { isTemporaryLocation } from '../../../utils/locationRecords';
import { fixedSiteAnchors, promoteSite } from '../../../../public/bundled-mods/worldmap/siteTravel.js';
const route = { id: 'road', name: 'Road between A and B', kind: 'transit', features: [], description: '', connections: [{ toId:'a' }, { toId:'b' }] };
it('hides only plain travel records while preserving meaningful routes and pinned places', () => {
    const position = { id:'point', name:'Exploration point (5, 7)', recordKind:'position', coordinates:{x:5,y:7} };
    const rows = [[route,true],[position,true],[{...route,features:['Old inn']},false],
        [{...route,description:'A toll bridge guarded by Mara.'},false],[{...route,name:'Kingsway'},false],
        [{...position,name:'North lookout'},false],[{...position,pinned:true},false],
        [{id:'authored',name:'Road between A and B'},false]];
    for (const [row, expected] of rows) { expect(isTemporaryPlace(row)).toBe(expected); expect(isTemporaryLocation(row)).toBe(expected); }
});
it('migrates coordinates without deleting IDs, links, features or overwriting established coordinates', () => {
    const ledger = [route,{id:'a',name:'A',connections:[{toId:'road'}]}, {id:'b',name:'B',coordinates:{x:40,y:40}},
        {id:'point',name:'Exploration point (5, 7)',description:''}];
    const anchors = [{locationId:'a',x:10,y:10},{locationId:'b',x:99,y:99}];
    const sites = [{id:'point',x:5,y:7,type:'wilderness'}];
    const migrated = reconcilePlaceRecords(ledger,anchors,sites);
    expect(migrated.map(row=>row.id)).toEqual(ledger.map(row=>row.id));
    expect(migrated[0].connections).toEqual(route.connections);
    expect(migrated[1].coordinates).toEqual({x:10,y:10}); expect(migrated[2].coordinates).toEqual({x:40,y:40});
    expect(migrated[3]).toMatchObject({recordKind:'position',coordinates:{x:5,y:7}});
    expect(reconcilePlaceRecords(migrated,anchors,sites)).toBe(migrated);
    const loaded = JSON.parse(JSON.stringify(migrated));
    expect(fixedSiteAnchors({anchors:[{locationId:'a',x:80,y:80}]},sites,loaded).find(a=>a.locationId==='a')).toMatchObject({x:10,y:10});
});
it('new empty destinations are coordinate records while landmarks are places', () => {
    const ledger = [{id:'a',connections:[]}];
    expect(promoteSite({id:'p',x:5,y:7,type:'wilderness',name:'Exploration point (5, 7)'},ledger,'a').at(-1)).toMatchObject({recordKind:'position',coordinates:{x:5,y:7}});
    expect(promoteSite({id:'l',x:9,y:9,type:'landmark'},ledger,'a').at(-1).recordKind).toBe('place');
});

it('uses saved coordinates as solver constraints when new places and conflicting lore arrive', () => {
    const result = solveWorldMap({ worldSeed:'saved-places', locations:[
        {id:'a',name:'A',coordinates:{x:100,y:200},connections:[{toId:'b',band:'local'}]},
        {id:'b',name:'B',connections:[{toId:'a',band:'local'}]},
    ], loreChunks:[{id:'lore',header:'LOCATION -- A',content:'**Coords:** 400,400',category:'location'}] });
    const a = result.anchors.find(row=>row.locationId==='a');
    const b = result.anchors.find(row=>row.locationId==='b');
    expect(a).toMatchObject({x:100,y:200,source:'saved'});
    expect(Math.hypot(a.x-b.x,a.y-b.y)).toBeLessThan(8);
    expect(result.report.refusals.some(row=>row.kind==='hard-conflict')).toBe(true);
});
