import { it, expect } from 'vitest';
import { archiveEncounters, recordCheckpoint, setEncounterFlags, handleEncounter, noteEncounter, readEncounters, serializeEncounters } from '../../../../public/bundled-mods/worldmap/encounters.js';
const row = { key:'1:5:7',x:5,y:7,worldDay:1,status:'passed',quiet:false,events:[{title:'Merchant',text:'A trader waits.'}],note:'Bought rope.' };
it('archives after seven in-game days, preserving the full record and outcome through reload', () => {
    const records = new Map([[row.key,row]]);
    expect(archiveEncounters(records,7)).toBe(records);
    const result = archiveEncounters(records,8);
    expect(result.get(row.key)).toMatchObject({...row,archivedOnDay:8});
    expect(readEncounters(JSON.parse(JSON.stringify(serializeEncounters(result))))).toEqual(result);
    expect(row.archivedOnDay).toBeUndefined();
});
it('protects current encounters, pins, unresolved leads and explicit quest references', () => {
    for (const protection of [{pinned:true},{unresolved:true},{questId:'q'},{status:'available'}]) {
        const records = new Map([[row.key,{...row,...protection}]]);
        expect(archiveEncounters(records,100)).toBe(records);
    }
    const records = new Map([[row.key,row]]); expect(archiveEncounters(records,100,row.key)).toBe(records);
});
it('interaction resets the clock; resolved leads can later archive; pinning restores an archive', () => {
    let records = new Map([[row.key,row]]);
    records = setEncounterFlags(records,row.key,{unresolved:true},10);
    records = handleEncounter(records,row.key,20);
    expect(archiveEncounters(records,26)).toBe(records);
    records = archiveEncounters(records,27); expect(records.get(row.key).archivedOnDay).toBe(27);
    records = setEncounterFlags(records,row.key,{pinned:true},30);
    expect(records.get(row.key)).toMatchObject({pinned:true,lastInteractionDay:30,archivedOnDay:undefined});
    const noted = noteEncounter(new Map([[row.key,row]]),row.key,'New information',7);
    expect(archiveEncounters(noted,8)).toBe(noted);
});
it('quiet movement archives old records without rerolling saved events', () => {
    const input = {seed:'retention',x:10,y:10,worldDay:10,biome:'plains',weather:'clear'};
    const first = recordCheckpoint(new Map([[row.key,row]]),input);
    expect(first.records.get(row.key).archivedOnDay).toBe(10);
    expect(recordCheckpoint(first.records,input).record).toEqual(first.record);
});
