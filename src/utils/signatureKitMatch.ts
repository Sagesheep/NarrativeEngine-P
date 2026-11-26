import type { InventoryItem, NPCSignatureKit } from '../types';

/**
 * Signature Kit <-> Inventory overlap (display only).
 *
 * The Character Ledger shows the same character's gear in two places on purpose:
 *
 *   Sheet > Signature Kit   bounded, durable labels injected into EVERY turn so
 *                           the GM never forgets what defines the character.
 *   Inventory               the unbounded pack; the recommender surfaces rows
 *                           when they are relevant to the turn.
 *
 * They are different mechanisms with different prompt paths, so they are NOT
 * merged and nothing here writes to either store. This module only *reports*
 * where the two lists happen to describe the same object, so the UI can say so
 * instead of looking like two broken copies of one list.
 */

// Below this length a token is too generic to match on ("axe" is fine, "of" is not).
const MIN_MATCH_LEN = 3;

/**
 * Lowercase, drop parentheticals, squash punctuation:
 *   "Excalibur (holy longsword)" -> "excalibur"
 *   "Healing Potion x3"          -> "healing potion x3"
 */
export function normalizeKitLabel(raw: string): string {
    return (raw || '')
        .toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** True when `needle`'s words appear as a consecutive run inside `hay`'s words. */
function containsWordRun(hay: string, needle: string): boolean {
    const h = hay.split(' ');
    const n = needle.split(' ');
    if (n.length === 0 || n.length > h.length) return false;
    for (let i = 0; i <= h.length - n.length; i++) {
        let ok = true;
        for (let j = 0; j < n.length; j++) {
            if (h[i + j] !== n[j]) { ok = false; break; }
        }
        if (ok) return true;
    }
    return false;
}

/**
 * Loose two-way match. Kit entries carry descriptive tails the inventory row
 * will not have ("Excalibur (holy longsword)" vs "Excalibur"), and inventory
 * rows carry counts the kit will not ("Torch" vs "torches"), so containment in
 * either direction counts -- but only on whole words, so "ration" never
 * matches "iron rations holder" by accident of substring.
 */
export function labelsDescribeSameThing(a: string, b: string): boolean {
    const na = normalizeKitLabel(a);
    const nb = normalizeKitLabel(b);
    if (na.length < MIN_MATCH_LEN || nb.length < MIN_MATCH_LEN) return false;
    if (na === nb) return true;
    return containsWordRun(na, nb) || containsWordRun(nb, na);
}

/** Inventory rows that look like they are the same object as this kit entry. */
export function inventoryMatchesForKitEntry(kitEntry: string, items: InventoryItem[]): InventoryItem[] {
    if (!kitEntry.trim()) return [];
    return (items || []).filter(it => labelsDescribeSameThing(kitEntry, it.name));
}

/** Kit equipment entries that look like they are the same object as this row. */
export function kitMatchesForItem(item: InventoryItem, kit?: NPCSignatureKit | null): string[] {
    if (!kit || !kit.equipment || kit.equipment.length === 0) return [];
    return kit.equipment.filter(entry => labelsDescribeSameThing(entry, item.name));
}

/** Convenience predicate for the "SIG" badge on an inventory row. */
export function isItemInSignatureKit(item: InventoryItem, kit?: NPCSignatureKit | null): boolean {
    return kitMatchesForItem(item, kit).length > 0;
}
