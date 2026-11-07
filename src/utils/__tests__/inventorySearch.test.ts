import { describe, it, expect } from 'vitest';
import { searchInventory } from '../inventorySearch';
import type { InventoryItem } from '../../types';

function item(name: string, patch: Partial<InventoryItem> = {}): InventoryItem {
    return {
        id: name,
        name,
        qty: 1,
        category: 'misc',
        keywords: [],
        equipped: false,
        lastUsedScene: '000',
        importance: 5,
        notes: '',
        locationTag: 'inventory',
        ...patch,
    };
}

const items = [
    item('**Copper Token (Spire Symbol)** — From handler body', { category: 'currency', keywords: ['alloy'] }),
    item('**Canopy Bracket Fragment**', { notes: 'Surrendered to Duskbane' }),
    item('Silver Spire pin', { equipped: true }),
    item('Key Investigation — Vesser Kalt', { category: 'key', locationTag: 'player base' }),
    item('Spire Guide', { category: 'key' }),
];

const find = (query: string) => searchInventory(items, query).map((it) => it.name);
const names = (...fragments: string[]) => fragments.map((f) => items.find((it) => it.name.includes(f))!.name);

describe('searchInventory', () => {
    it('returns everything A-Z for a blank query', () => {
        expect(find('   ')).toEqual(items.map((it) => it.name).sort((a, b) => a.localeCompare(b)));
    });

    it('needs every word, in any order, and sees through markdown', () => {
        expect(find('token copper')).toEqual(names('Copper'));
        expect(find('copper silver')).toEqual([]);
    });

    it('ranks a name match ahead of a weaker one', () => {
        expect(find('spire')[0]).toBe(names('Spire Guide')[0]);
        expect(find('spire')).toHaveLength(3);
    });

    it('searches keywords, notes and location', () => {
        expect(find('alloy')).toEqual(names('Copper'));
        expect(find('duskbane')).toEqual(names('Canopy'));
        expect(find('base')).toEqual(names('Vesser'));
    });

    it('forgives typos in longer words only', () => {
        expect(find('coper')).toEqual(names('Copper'));
        expect(find('fragmnet')).toEqual(names('Canopy'));
        expect(find('kez')).toEqual([]);
    });

    it('does not forgive a different first letter', () => {
        expect(find('zopper')).toEqual([]);
    });

    it('matches quoted phrases exactly', () => {
        expect(find('"silver spire"')).toEqual(names('Silver'));
        expect(find('"spire silver"')).toEqual([]);
    });

    it('excludes negated terms', () => {
        expect(find('spire -silver -copper')).toEqual(names('Spire Guide'));
        expect(find('spire -cat:key').sort()).toEqual(names('Copper', 'Silver').sort());
    });

    it('supports field filters', () => {
        expect(find('cat:currency')).toEqual(names('Copper'));
        expect(find('cat:cur')).toEqual(names('Copper'));
        expect(find('spire cat:key')).toEqual(names('Spire Guide'));
        expect(find('loc:"player base"')).toEqual(names('Vesser'));
        expect(find('is:equipped')).toEqual(names('Silver'));
    });

    it('treats a bare category or "equipped" as a search word', () => {
        expect(find('currency')).toEqual(names('Copper'));
        expect(find('equipped')).toEqual(names('Silver'));
    });

    it('treats an unknown prefix as plain text', () => {
        expect(searchInventory([item('Note: spire')], 'note:').map((it) => it.name)).toEqual(['Note: spire']);
    });

    it('copes with half-typed input', () => {
        expect(find('"silver sp')).toEqual(names('Silver'));
        expect(find('-')).toHaveLength(items.length);
        expect(find('cat:')).toHaveLength(items.length);
    });
});
