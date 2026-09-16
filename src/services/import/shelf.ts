/**
 * WO-C §4 Step 1/3/4 + §6.8 — the Card Shelf's rules, extracted as pure functions so
 * they test without mounting the wizard (§10.5).
 *
 * The shelf holds one tile per dropped file, in drop order, including files that
 * failed to parse (they show a dim warning tile and block nothing, §9.5).
 *
 * Two markers live on the tiles and are mutually exclusive on any single tile:
 *   ★  Campaign Seed — its scenario proposes the premise and opening scene.
 *   👤 This is me    — that card becomes the player character instead of an NPC.
 *
 * Every function returns a new array; tiles are never mutated.
 */

import type { STCard, STPngFailure } from './stCardTypes';
import { normalizeName } from './importOverwrite';

export type ShelfTile = {
    id: string;
    fileName: string;
    /** `null` when the file could not be parsed into a card — see `failure`. */
    card: STCard | null;
    failure?: STPngFailure | 'not-json' | 'not-card';
    star: boolean;
    persona: boolean;
};

/** A card can seed a campaign only if it brings a scenario or an opening message. */
export function canSeed(card: STCard | null): boolean {
    if (!card) return false;
    return card.scenario.trim() !== '' || card.first_mes.trim() !== '';
}

/**
 * The tile to star on drop: the first parsed card that can seed. `null` when no
 * dropped card qualifies (the user then has Import as NPCs only).
 * Callers apply this only while nothing is starred yet.
 */
export function autoStarIndex(tiles: ShelfTile[]): number | null {
    const i = tiles.findIndex(t => canSeed(t.card));
    return i === -1 ? null : i;
}

/**
 * Radio semantics: star `index`, unstar every other tile. Refused — returns `tiles`
 * unchanged — when the index is out of range, the tile cannot seed, or the tile is
 * the persona (a card cannot be both the world's anchor NPC and the player).
 */
export function applyStar(tiles: ShelfTile[], index: number): ShelfTile[] {
    const target = tiles[index];
    if (!target || !canSeed(target.card) || target.persona) return tiles;
    return tiles.map((t, i) => (t.star === (i === index) ? t : { ...t, star: i === index }));
}

/**
 * At most one persona tile. `null` clears the marker entirely. Refused — returns
 * `tiles` unchanged — when the index is out of range, the tile has no parsed card
 * (there is nothing to convert into a PC), or the tile is the ★ seed.
 */
export function applyPersona(tiles: ShelfTile[], index: number | null): ShelfTile[] {
    if (index === null) {
        return tiles.some(t => t.persona) ? tiles.map(t => (t.persona ? { ...t, persona: false } : t)) : tiles;
    }
    const target = tiles[index];
    if (!target || !target.card || target.star) return tiles;
    return tiles.map((t, i) => (t.persona === (i === index) ? t : { ...t, persona: i === index }));
}

export type DuplicateGroup = {
    /** The first member's name **as written on its card** — display casing, not the normalized key. */
    name: string;
    /** Indexes into the tile array, ascending; always 2 or more. */
    indexes: number[];
};

/**
 * Cards in one drop that share a name (§9.4: repeated names inside a drop get the same
 * Overwrite treatment as a ledger collision, never a silent keep-the-first).
 * Groups come back in first-appearance order.
 */
export function findDuplicateGroups(tiles: ShelfTile[]): DuplicateGroup[] {
    const byKey = new Map<string, DuplicateGroup>();
    const order: string[] = [];

    tiles.forEach((tile, i) => {
        if (!tile.card) return;
        const key = normalizeName(tile.card.name);
        if (!key) return;
        const group = byKey.get(key);
        if (group) {
            group.indexes.push(i);
        } else {
            byKey.set(key, { name: tile.card.name, indexes: [i] });
            order.push(key);
        }
    });

    return order.map(k => byKey.get(k)).filter((g): g is DuplicateGroup => !!g && g.indexes.length >= 2);
}

/**
 * True when a non-persona card shares the player's name — the Step 4 warning
 * "this card shares your character's name".
 */
export function personaNameCollides(tiles: ShelfTile[], playerName: string): boolean {
    const target = normalizeName(playerName);
    if (!target) return false;
    return tiles.some(t => !t.persona && t.card !== null && normalizeName(t.card.name) === target);
}

/**
 * The NPC roster: parsed, non-persona tiles, with the ★ seed first (it is the central
 * character and leads the Step 4 review list). Everything else keeps drop order.
 */
export function rosterFromTiles(tiles: ShelfTile[]): ShelfTile[] {
    const roster = tiles.filter(t => t.card !== null && !t.persona);
    const seedAt = roster.findIndex(t => t.star);
    if (seedAt <= 0) return roster;
    return [roster[seedAt], ...roster.slice(0, seedAt), ...roster.slice(seedAt + 1)];
}
