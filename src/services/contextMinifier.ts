/**
 * contextMinifier.ts
 * 
 * Strips markdown formatting and compresses lore/NPC data into dense
 * semantic tags for AI consumption. Runs locally at payload-build time —
 * zero LLM tokens spent on compression.
 * 
 * Original lore files stay human-readable; this is transport-only.
 */

import type { LoreChunk, NPCEntry } from '../types';

/**
 * Strip markdown formatting from a block of text.
 * Removes: ### headers, **bold**, --- rules, excessive newlines, HTML comments.
 */
function stripMarkdown(text: string): string {
    return text
        .replace(/<!--[\s\S]*?-->/g, '')           // HTML comments (RAG metadata blocks)
        .replace(/^#{1,6}\s+/gm, '')               // Markdown headers (### Title → Title)
        .replace(/\*\*([^*]+)\*\*/g, '$1')          // **bold** → bold
        .replace(/\*([^*]+)\*/g, '$1')              // *italic* → italic
        .replace(/^---+$/gm, '')                    // Horizontal rules
        .replace(/^\s*\n/gm, '\n')                  // Collapse blank lines
        .replace(/\n{3,}/g, '\n')                   // Max 1 blank line
        .trim();
}

/**
 * Compress a key-value line like "Real Name: Peter Parker" into "rn:Peter Parker"
 * Handles common field labels found in world lore chunks.
 */
const FIELD_ABBREVIATIONS: Record<string, string> = {
    'real name': 'rn',
    'alias': 'a',
    'power class': 'pwr',
    'age': 'age',
    'location': 'loc',
    'affiliation': 'aff',
    'registration stance': 'reg',
    'personality': 'per',
    'key note': 'note',
    'key fact': 'note',
    'status': 'st',
    'base': 'base',
    'type': 'type',
    'profile': 'prof',
    'classification': 'cls',
    'occupation': 'occ',
    'origin': 'orig',
    'unique ability': 'ability',
    'unique abilities': 'abilities',
    'code': 'code',
    'on registration': 'reg',
    'internal culture': 'culture',
    'internal dynamic': 'dynamic',
    'context': 'ctx',
    'function': 'fn',
    'attitude': 'att',
    'role': 'role',
    'history note': 'hist',
    'nominal leader': 'lead',
    'director': 'dir',
    'attitude to new heroes': 'new_heroes',
    'slogan': 'slogan',
    'core argument': 'arg',
    'what they want': 'want',
    'what worries them': 'worry',
    'blind spots': 'blind',
    'key members': 'members',
    'their reality': 'reality',
    'what they need': 'need',
    'who': 'who',
    'their view': 'view',
};

/**
 * Compress a single line by abbreviating known field labels.
 */
function compressFieldLine(line: string): string {
    // Match "Label:" or "Label :" at start of line
    const match = line.match(/^([A-Za-z\s/]+?):\s*(.*)/);
    if (!match) return line;

    const label = match[1].trim().toLowerCase();
    const value = match[2].trim();
    const abbr = FIELD_ABBREVIATIONS[label];

    if (abbr) {
        return `${abbr}:${value}`;
    }
    return line;
}

/**
 * Minify a LoreChunk for AI consumption.
 * Strips markdown, abbreviates field labels, and collapses into compact format.
 * 
 * Before: ~180 tokens (formatted markdown with headers, bold, separators)
 * After:  ~50-70 tokens (dense key-value lines)
 */
export function minifyLoreChunk(chunk: LoreChunk): string {
    const headerRaw = stripMarkdown(chunk.header);
    // Strip the [CHUNK: TYPE] prefix for the minified output to save tokens
    const header = headerRaw.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();
    const content = stripMarkdown(chunk.content);

    if (chunk.category === 'relationship') {
        // Preserve newlines for relationship maps / ERDs
        return `[${header}]\n${content}`;
    }

    const compressedLines = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(compressFieldLine)
        .join(' | ');

    const prefix = chunk.category === 'faction' ? `[FACTION: ${header}]`
                 : chunk.category === 'location' ? `[LOC: ${header}]`
                 : chunk.category === 'character' ? `[NPC: ${header}]`
                 : `[${header}]`;

    return `${prefix} ${compressedLines}`;
}

/**
 * Minify the entire lore block for injection into the AI payload.
 * Returns a compact string replacing the verbose markdown format.
 */
export function minifyLoreBlock(chunks: LoreChunk[]): string {
    const minified = chunks.map(minifyLoreChunk).join('\n');
    return `[WORLD LORE]\n${minified}\n[/LORE]`;
}

/**
 * Minify an NPC entry for AI consumption.
 * Drops verbose labels and compresses into a single dense line.
 * 
 * Before: [ASH HUANG (None)] Alive | Affinity: 50/100 (Neutral) | Asian male... | Goals: ...
 * After:  ASH_HUANG Alive aff:50 | Asian male... | panicked | Gim:... Glr:... | 6/5/10/1/7/6
 */
export function minifyNPC(npc: NPCEntry): string {
    const aliases = npc.aliases ? `(${npc.aliases})` : '';
    const name = npc.name.toUpperCase();
    const status = npc.status || 'Alive';
    const aff = npc.affinity ?? 50;

    // Compact appearance: trim to first 80 chars if very long
    const appearance = (npc.appearance || '?').length > 80
        ? (npc.appearance || '?').substring(0, 80) + '…'
        : (npc.appearance || '?');

    const personality = (npc.personality || npc.disposition || '?').length > 60
        ? (npc.personality || npc.disposition || '?').substring(0, 60) + '…'
        : (npc.personality || npc.disposition || '?');

    const goals = npc.goals || '?';

    return `[${name}${aliases}] ${status} aff:${aff} | ${appearance} | ${personality} | ${goals}`;
}

/**
 * Minify the entire NPC context block.
 */
export function minifyNPCBlock(npcs: NPCEntry[]): string {
    const lines = npcs.map(minifyNPC).join('\n');
    return `[NPC_CTX]\n${lines}\n[/NPC_CTX]`;
}

import type { InventoryItem, InventoryItemCategory, CharacterProfile } from '../types';

const CATEGORY_ORDER: InventoryItemCategory[] = ['equipped', 'weapon', 'armor', 'consumable', 'key', 'currency', 'misc'];

const CATEGORY_LABELS: Record<string, string> = {
    equipped: 'EQP', weapon: 'WPN', armor: 'ARM', consumable: 'CON', key: 'KEY', currency: 'CR', misc: 'MSC',
};

function groupByCategory(items: InventoryItem[]): Map<string, InventoryItem[]> {
    const map = new Map<string, InventoryItem[]>();
    for (const item of items) {
        const cat = item.equipped ? 'equipped' : item.category;
        if (!map.has(cat)) map.set(cat, []);
        map.get(cat)!.push(item);
    }
    return map;
}

export function buildInventoryIndex(items: InventoryItem[]): string {
    if (items.length === 0) return '[INVENTORY INDEX]\nEmpty\n[/INVENTORY]';
    const grouped = groupByCategory(items);
    const lines: string[] = [];
    for (const cat of CATEGORY_ORDER) {
        const group = grouped.get(cat);
        if (!group || group.length === 0) continue;
        const entries = group.map(i => {
            let s = i.qty > 1 ? `${i.name} (x${i.qty})` : i.name;
            if (i.keywords.length > 0) s += ` (${i.keywords.slice(0, 4).join(',')})`;
            return s;
        }).join(', ');
        lines.push(`${cat[0].toUpperCase()}${cat.slice(1)}: ${entries}`);
    }
    return `[INVENTORY INDEX — ${items.length} items]\n${lines.join('\n')}\n[/INVENTORY]`;
}

export function buildProfileIndex(profile: CharacterProfile): string {
    const parts: string[] = [];
    parts.push(`${profile.name || '???'} | ${profile.race || '?'} ${profile.class || '?'} Lv${profile.level}`);
    if (profile.hp) parts.push(`HP:${profile.hp.current}/${profile.hp.max}`);
    if (profile.mp) parts.push(`MP:${profile.mp.current}/${profile.mp.max}`);
    if (Object.keys(profile.stats).length > 0) {
        const stats = Object.entries(profile.stats)
            .filter(([, v]) => typeof v === 'number')
            .map(([k, v]) => `${k.slice(0, 3).toUpperCase()}:${v}`)
            .join(' ');
        parts.push(stats);
    }
    if (profile.skills.length > 0) parts.push(`Skills: ${profile.skills.join(', ')}`);
    if (profile.abilities.length > 0) parts.push(`Abilities: ${profile.abilities.join(', ')}`);
    if (profile.traits.length > 0) parts.push(`Traits: ${profile.traits.join(', ')}`);
    return `[PROFILE INDEX]\n${parts.join(' | ')}\n[/PROFILE]`;
}

export function minifySelectedInventory(
    items: InventoryItem[],
    selectedCategories: (InventoryItemCategory | 'equipped')[]
): string {
    if (items.length === 0) return '';
    const selectedSet = new Set(selectedCategories);
    const grouped = groupByCategory(items);
    const blocks: string[] = [];
    for (const cat of CATEGORY_ORDER) {
        if (!selectedSet.has(cat)) continue;
        const group = grouped.get(cat);
        if (!group || group.length === 0) continue;
        const tag = CATEGORY_LABELS[cat] || cat.toUpperCase().slice(0, 3);
        const entries = group.map(i => {
            if (i.qty > 1) return `${i.name}(x${i.qty})`;
            return i.name;
        }).join(', ');
        blocks.push(`[${tag}] ${entries}`);
    }
    return blocks.join('\n');
}

export function minifySelectedProfile(
    profile: CharacterProfile,
    selectedFields: string[]
): string {
    const parts: string[] = [];
    const want = (k: string) => selectedFields.includes(k);
    if (want('name')) parts.push(profile.name || '???');
    if (want('race')) parts.push(profile.race || '?');
    if (want('class')) parts.push(profile.class || '?');
    if (want('level')) parts.push(`Lv${profile.level}`);
    if (want('hp') && profile.hp) parts.push(`HP:${profile.hp.current}/${profile.hp.max}`);
    if (want('mp') && profile.mp) parts.push(`MP:${profile.mp.current}/${profile.mp.max}`);
    if (want('stats') && Object.keys(profile.stats).length > 0) {
        parts.push(Object.entries(profile.stats).map(([k, v]) => `${k.slice(0, 3).toUpperCase()}:${v}`).join('|'));
    }
    if (want('skills') && profile.skills.length > 0) parts.push(`SK:${profile.skills.join(',')}`);
    if (want('abilities') && profile.abilities.length > 0) parts.push(`AB:${profile.abilities.join(',')}`);
    if (want('traits') && profile.traits.length > 0) parts.push(`TR:${profile.traits.join(',')}`);
    if (want('notes') && profile.notes) parts.push(`NT:${profile.notes.slice(0, 80)}`);
    return parts.join(' | ');
}

export function minifyBookkeepingStub(
    profile: CharacterProfile,
    items: InventoryItem[]
): string {
    const parts: string[] = [];
    parts.push(`CHAR:${profile.name || '???'}|${profile.race || '?'} ${profile.class || '?'}|Lv${profile.level}`);
    if (profile.hp) parts.push(`HP:${profile.hp.current}/${profile.hp.max}`);
    const currency = items
        .filter(i => i.category === 'currency')
        .map(i => `${i.qty}${i.name}`)
        .join(',');
    if (currency) parts.push(`CR:${currency}`);
    const equipped = items
        .filter(i => i.equipped)
        .map(i => `${i.name}${i.qty > 1 ? `x${i.qty}` : ''}`)
        .join(', ');
    if (equipped) parts.push(`EQP:${equipped}`);
    return parts.join(' | ');
}
