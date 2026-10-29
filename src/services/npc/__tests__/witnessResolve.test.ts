import { describe, it, expect } from 'vitest';
import type { NPCEntry } from '../../../types';
import { createWitnessResolver, witnessIds, witnessNames } from '../witnessResolve';

function mkNpc(id: string, name: string, aliases = ''): NPCEntry {
    return { id, name, aliases, archived: false, affinity: 50 } as unknown as NPCEntry;
}

const rin = mkNpc('npc_rin', 'Rin Holmes', 'Partner of Grey Holmes, Sovereign of the Hive');
const grey = mkNpc('npc_grey', 'Grey Holmes', 'The Investigator, Mr. Holmes');
const helena = mkNpc('npc_helena', 'Helena Broadmarsh', 'Commander Broadmarsh');
const vren = mkNpc('npc_vren', 'Captain Ilsa Vren', 'Ilsa Vren');
const vrenDup = mkNpc('npc_vren2', 'Ilsa Vren');
const ledger = [rin, grey, helena, vren, vrenDup];

const ids = (npcs: readonly NPCEntry[]) => npcs.map(n => n.id);

describe('createWitnessResolver', () => {
    const resolve = createWitnessResolver(ledger);

    it('resolves an exact name, case- and space-insensitively', () => {
        expect(ids(resolve('Helena Broadmarsh'))).toEqual(['npc_helena']);
        expect(ids(resolve('  helena   BROADMARSH '))).toEqual(['npc_helena']);
    });

    it('resolves an alias', () => {
        expect(ids(resolve('Commander Broadmarsh'))).toEqual(['npc_helena']);
        expect(ids(resolve('The Investigator'))).toEqual(['npc_grey']);
    });

    it('resolves a ledger id (legacy and test data)', () => {
        expect(ids(resolve('npc_rin'))).toEqual(['npc_rin']);
    });

    it('resolves a unique first or last word of a name', () => {
        expect(ids(resolve('Rin'))).toEqual(['npc_rin']);
        expect(ids(resolve('Grey'))).toEqual(['npc_grey']);
        expect(ids(resolve('Broadmarsh'))).toEqual(['npc_helena']);
    });

    it('an ambiguous short name resolves to nobody', () => {
        expect(resolve('Holmes')).toEqual([]);
    });

    it('an unknown name resolves to nobody', () => {
        expect(resolve('The Voice')).toEqual([]);
        expect(resolve('Essenhall')).toEqual([]);
        expect(resolve('')).toEqual([]);
    });

    it('an exact name shared by duplicate ledger entries resolves to both', () => {
        expect(ids(resolve('Ilsa Vren'))).toEqual(['npc_vren', 'npc_vren2']);
    });

    it('skips nameless ledger entries', () => {
        const r = createWitnessResolver([{ id: 'x', aliases: 'Ghost' } as unknown as NPCEntry, rin]);
        expect(ids(r('Rin'))).toEqual(['npc_rin']);
        expect(r('Ghost')).toEqual([]);
    });
});

describe('witnessIds / witnessNames', () => {
    const resolve = createWitnessResolver(ledger);

    it('witnessIds collects the ids of every resolvable witness', () => {
        expect([...witnessIds(['Rin', 'Holmes', 'Grey', 'The Voice'], resolve)]).toEqual(['npc_rin', 'npc_grey']);
        expect(witnessIds(undefined, resolve).size).toBe(0);
    });

    it('witnessNames gives ledger names, de-duplicated, in witness order', () => {
        expect(witnessNames(['Grey', 'Rin', 'Rin Holmes', 'Essenhall'], resolve)).toEqual(['Grey Holmes', 'Rin Holmes']);
        expect(witnessNames([], resolve)).toEqual([]);
    });
});
