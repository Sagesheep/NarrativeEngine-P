import { describe, it, expect } from 'vitest';
import {
    applyPersona,
    applyStar,
    autoStarIndex,
    canSeed,
    findDuplicateGroups,
    personaNameCollides,
    rosterFromTiles,
    type ShelfTile,
} from '../shelf';
import type { STCard } from '../stCardTypes';

function card(over: Partial<STCard> = {}): STCard {
    return {
        name: 'Aria',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        alternate_greetings: [],
        system_prompt: '',
        post_history_instructions: '',
        tags: [],
        creator: '',
        creator_notes: '',
        spec: 'v2',
        ...over,
    };
}

function tile(id: string, over: Partial<ShelfTile> = {}): ShelfTile {
    return { id, fileName: `${id}.png`, card: card({ name: id }), star: false, persona: false, ...over };
}

/** A file that failed to parse — dim warning tile, blocks nothing (§9.5). */
function badTile(id: string): ShelfTile {
    return { id, fileName: `${id}.png`, card: null, failure: 'no-card-payload', star: false, persona: false };
}

const seedable = (id: string, over: Partial<ShelfTile> = {}): ShelfTile =>
    tile(id, { card: card({ name: id, scenario: `${id} lives in a tower.` }), ...over });

describe('canSeed', () => {
    it('needs a scenario or an opening message', () => {
        expect(canSeed(card({ scenario: 'A tower.' }))).toBe(true);
        expect(canSeed(card({ first_mes: 'Hello there.' }))).toBe(true);
        expect(canSeed(card({ scenario: '   ' }))).toBe(false);
        expect(canSeed(card())).toBe(false);
        expect(canSeed(null)).toBe(false);
    });
});

describe('autoStarIndex (WO-C §6.8)', () => {
    it('picks the first card that can seed, skipping unparsed and scenario-less tiles', () => {
        const tiles = [badTile('broken'), tile('flat'), seedable('world'), seedable('later')];
        expect(autoStarIndex(tiles)).toBe(2);
    });

    it('returns null when no dropped card qualifies', () => {
        expect(autoStarIndex([badTile('broken'), tile('flat')])).toBeNull();
        expect(autoStarIndex([])).toBeNull();
    });
});

describe('applyStar — radio semantics', () => {
    it('stars one tile and unstars the previous', () => {
        const tiles = [seedable('a', { star: true }), seedable('b')];
        const after = applyStar(tiles, 1);
        expect(after.map(t => t.star)).toEqual([false, true]);
    });

    it('refuses a tile that cannot seed', () => {
        const tiles = [seedable('a', { star: true }), tile('flat'), badTile('broken')];
        expect(applyStar(tiles, 1)).toBe(tiles);
        expect(applyStar(tiles, 2)).toBe(tiles);
        expect(applyStar(tiles, 9)).toBe(tiles);
    });

    it('refuses the persona tile — the two markers are mutually exclusive', () => {
        const tiles = [seedable('a', { star: true }), seedable('me', { persona: true })];
        const after = applyStar(tiles, 1);
        expect(after).toBe(tiles);
        expect(after[1].star).toBe(false);
    });
});

describe('applyPersona', () => {
    it('marks at most one persona', () => {
        const tiles = [tile('a', { persona: true }), tile('b'), tile('c')];
        const after = applyPersona(tiles, 2);
        expect(after.map(t => t.persona)).toEqual([false, false, true]);
    });

    it('clears the marker on null', () => {
        const tiles = [tile('a', { persona: true }), tile('b')];
        expect(applyPersona(tiles, null).map(t => t.persona)).toEqual([false, false]);
    });

    it('refuses the starred tile — the two markers are mutually exclusive', () => {
        const tiles = [seedable('seed', { star: true }), tile('b')];
        const after = applyPersona(tiles, 0);
        expect(after).toBe(tiles);
        expect(after[0].persona).toBe(false);
    });

    it('refuses an unparsed tile and an out-of-range index', () => {
        const tiles = [badTile('broken'), tile('b')];
        expect(applyPersona(tiles, 0)).toBe(tiles);
        expect(applyPersona(tiles, 7)).toBe(tiles);
    });
});

describe('findDuplicateGroups', () => {
    it('groups parsed cards that share a normalized name, in first-appearance order', () => {
        const tiles = [
            tile('x', { card: card({ name: 'Aria' }) }),
            badTile('broken'),
            tile('y', { card: card({ name: 'Bram' }) }),
            tile('z', { card: card({ name: '  aria  ' }) }),
            tile('w', { card: card({ name: 'ARIA' }) }),
        ];
        const groups = findDuplicateGroups(tiles);
        expect(groups).toHaveLength(1);
        expect(groups[0].name).toBe('Aria');       // first member's display casing
        expect(groups[0].indexes).toEqual([0, 3, 4]);
    });

    it('returns nothing when every name is unique', () => {
        expect(findDuplicateGroups([tile('a'), tile('b'), badTile('broken')])).toEqual([]);
    });
});

describe('personaNameCollides', () => {
    const tiles = [tile('a', { card: card({ name: 'Aria' }) }), tile('me', { card: card({ name: 'Kai' }), persona: true })];

    it('flags a non-persona card sharing the player name', () => {
        expect(personaNameCollides(tiles, ' aria ')).toBe(true);
        expect(personaNameCollides(tiles, 'ARIA')).toBe(true);
    });

    it('ignores the persona tile itself and empty names', () => {
        expect(personaNameCollides(tiles, 'Kai')).toBe(false);
        expect(personaNameCollides(tiles, '   ')).toBe(false);
        expect(personaNameCollides(tiles, 'Nobody')).toBe(false);
    });
});

describe('rosterFromTiles', () => {
    it('drops unparsed and persona tiles and puts the ★ seed first', () => {
        const tiles = [
            tile('a'),
            badTile('broken'),
            tile('me', { persona: true }),
            seedable('seed', { star: true }),
            tile('b'),
        ];
        expect(rosterFromTiles(tiles).map(t => t.id)).toEqual(['seed', 'a', 'b']);
    });

    it('keeps drop order when nothing is starred', () => {
        expect(rosterFromTiles([tile('a'), tile('b')]).map(t => t.id)).toEqual(['a', 'b']);
    });

    it('is empty when every tile is unparsed or the persona', () => {
        expect(rosterFromTiles([badTile('broken'), tile('me', { persona: true })])).toEqual([]);
    });
});
