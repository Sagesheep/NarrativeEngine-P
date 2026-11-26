import { describe, it, expect } from 'vitest';
import {
    normalizeKitLabel,
    labelsDescribeSameThing,
    inventoryMatchesForKitEntry,
    kitMatchesForItem,
    isItemInSignatureKit,
} from '../signatureKitMatch';
import type { InventoryItem } from '../../types';

function item(name: string): InventoryItem {
    return {
        id: name, name, qty: 1, category: 'misc', keywords: [],
        equipped: false, lastUsedScene: '', importance: 5, notes: '',
    };
}

describe('signatureKitMatch — Signature Kit <-> Inventory overlap (display only)', () => {
    it('strips parentheticals and punctuation', () => {
        expect(normalizeKitLabel('Excalibur (holy longsword)')).toBe('excalibur');
        expect(normalizeKitLabel("Mom's  Locket!")).toBe('mom s locket');
        expect(normalizeKitLabel('')).toBe('');
    });

    it('matches a kit entry to the plain inventory name', () => {
        expect(labelsDescribeSameThing('Excalibur (holy longsword)', 'Excalibur')).toBe(true);
        expect(labelsDescribeSameThing('iron dagger', 'Iron Dagger')).toBe(true);
    });

    it('matches in both directions', () => {
        expect(labelsDescribeSameThing('longsword', 'battered longsword of the north')).toBe(true);
        expect(labelsDescribeSameThing('battered longsword of the north', 'longsword')).toBe(true);
    });

    it('does not match on partial words', () => {
        // "ration" must not match inside "rations" via naive substring
        expect(labelsDescribeSameThing('ration', 'iron rations')).toBe(false);
        expect(labelsDescribeSameThing('axe', 'waxed cloak')).toBe(false);
    });

    it('refuses to match on very short or empty labels', () => {
        expect(labelsDescribeSameThing('of', 'of')).toBe(false);
        expect(labelsDescribeSameThing('', 'sword')).toBe(false);
    });

    it('finds the inventory rows behind a kit entry', () => {
        const items = [item('Excalibur'), item('Torch'), item('Rope')];
        const hits = inventoryMatchesForKitEntry('Excalibur (holy longsword)', items);
        expect(hits.map(i => i.name)).toEqual(['Excalibur']);
        expect(inventoryMatchesForKitEntry('   ', items)).toEqual([]);
    });

    it('finds the kit entries behind an inventory row', () => {
        const kit = { equipment: ['Excalibur (holy longsword)', 'oak shield'], abilities: ['fire magic'] };
        expect(kitMatchesForItem(item('Excalibur'), kit)).toEqual(['Excalibur (holy longsword)']);
        expect(isItemInSignatureKit(item('Excalibur'), kit)).toBe(true);
        expect(isItemInSignatureKit(item('Torch'), kit)).toBe(false);
    });

    it('never matches abilities against inventory rows', () => {
        const kit = { equipment: [], abilities: ['fire magic'] };
        expect(isItemInSignatureKit(item('fire magic'), kit)).toBe(false);
    });

    it('is safe with no kit at all', () => {
        expect(isItemInSignatureKit(item('Torch'), null)).toBe(false);
        expect(isItemInSignatureKit(item('Torch'), undefined)).toBe(false);
        expect(kitMatchesForItem(item('Torch'), { equipment: [], abilities: [] })).toEqual([]);
    });
});
