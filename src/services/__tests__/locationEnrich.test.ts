import { describe, it, expect } from 'vitest';
import { sanitizeEnrichPatch } from '../locationEnrich';
import type { LocationEntry } from '../../types';

function entry(partial: Partial<LocationEntry> & { id: string; name: string }): LocationEntry {
    return {
        aliases: '',
        broadLocation: '',
        features: [],
        connections: [],
        description: '',
        firstSeenScene: '1',
        lastSeenScene: '1',
        source: 'manual',
        ...partial,
    };
}

const shell = entry({ id: 'loc_new', name: "MC's House" });
const street = entry({ id: 'loc_street', name: 'Sakurajima Street' });
const academy = entry({ id: 'loc_academy', name: 'Ninja Academy', aliases: 'the academy' });
const LEDGER = [shell, street, academy];

describe('sanitizeEnrichPatch', () => {
    it('fills empty fields from a well-formed response', () => {
        const patch = sanitizeEnrichPatch({
            description: 'A modest two-story house.  ',
            broadLocation: 'Konoha',
            aliases: 'home, the house',
            features: ['kitchen', 'balcony'],
            connections: ['Sakurajima Street'],
        }, shell, LEDGER);
        expect(patch.description).toBe('A modest two-story house.');
        expect(patch.broadLocation).toBe('Konoha');
        expect(patch.aliases).toBe('home, the house');
        expect(patch.features).toEqual(['kitchen', 'balcony']);
        expect(patch.connections).toEqual([{ toId: 'loc_street', band: 'local' }]);
    });

    it('never overwrites fields the player already filled', () => {
        const edited = entry({ id: 'loc_new', name: "MC's House", description: 'My own words.', broadLocation: 'Suna' });
        const patch = sanitizeEnrichPatch({ description: 'AI words', broadLocation: 'Konoha' }, edited, LEDGER);
        expect(patch.description).toBeUndefined();
        expect(patch.broadLocation).toBeUndefined();
    });

    it('merges features without duplicates and respects the cap', () => {
        const withFeatures = entry({ id: 'loc_new', name: 'House', features: ['Kitchen'] });
        const patch = sanitizeEnrichPatch({ features: ['kitchen', 'Balcony'] }, withFeatures, LEDGER);
        expect(patch.features).toEqual(['Kitchen', 'Balcony']);

        const full = entry({ id: 'loc_full', name: 'Big', features: Array.from({ length: 20 }, (_, i) => `f${i}`) });
        expect(sanitizeEnrichPatch({ features: ['extra'] }, full, LEDGER).features).toBeUndefined();
    });

    it('resolves connections by alias, drops unknown/self, no duplicates', () => {
        const patch = sanitizeEnrichPatch({
            connections: ['the academy', "MC's House", 'Atlantis', 'the academy'],
        }, shell, LEDGER);
        expect(patch.connections).toEqual([{ toId: 'loc_academy', band: 'local' }]);
    });

    it('tolerates garbage shapes without throwing', () => {
        const patch = sanitizeEnrichPatch({
            description: 42, broadLocation: null, aliases: { a: 1 }, features: 'kitchen', connections: 7,
        } as never, shell, LEDGER);
        expect(patch).toEqual({});
    });

    it('accepts aliases delivered as an array', () => {
        const patch = sanitizeEnrichPatch({ aliases: ['home', 'the house'] }, shell, LEDGER);
        expect(patch.aliases).toBe('home, the house');
    });

    it('drops an alias that just repeats the name', () => {
        const patch = sanitizeEnrichPatch({ aliases: "mc's house" }, shell, LEDGER);
        expect(patch.aliases).toBeUndefined();
    });

    it('caps description length', () => {
        const patch = sanitizeEnrichPatch({ description: 'x'.repeat(1000) }, shell, LEDGER);
        expect(patch.description!.length).toBe(400);
    });
});
