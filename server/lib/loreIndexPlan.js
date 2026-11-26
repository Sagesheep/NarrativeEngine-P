import { buildLoreText } from './embedder.js';

/**
 * Work out which lore vectors a lore save has to touch.
 *
 * The client saves the whole chunk list on every edit (a keyword click, a mode
 * change, one new entry), so re-embedding all of it each time is wasted work and
 * keeps the lore job "running", which turns semantic lore recall off meanwhile.
 * Only a chunk whose embedded text changed, or that has no current vector, needs
 * embedding; a chunk that left the list needs its vector removed.
 *
 * @param {Array} previous  chunks in the file before this save
 * @param {Array} next      chunks being saved
 * @param {Iterable<string>} embeddedIds  ids that already have a current vector
 * @returns {{ toEmbed: Array, toDelete: string[] }}
 */
export function planLoreIndex(previous, next, embeddedIds) {
    const prevText = new Map();
    for (const c of Array.isArray(previous) ? previous : []) {
        if (c && c.id) prevText.set(c.id, buildLoreText(c));
    }
    const embedded = new Set(embeddedIds);
    const nextIds = new Set();
    const toEmbed = [];
    for (const c of Array.isArray(next) ? next : []) {
        if (!c || !c.id) continue;
        nextIds.add(c.id);
        const unchanged = prevText.get(c.id) === buildLoreText(c);
        if (!(unchanged && embedded.has(c.id))) toEmbed.push(c);
    }
    const toDelete = [...prevText.keys()].filter(id => !nextIds.has(id));
    return { toEmbed, toDelete };
}
