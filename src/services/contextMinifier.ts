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
    // Strip markdown from header and content
    const header = stripMarkdown(chunk.header);
    const content = stripMarkdown(chunk.content);

    // Compress each line's field label
    const compressedLines = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .map(compressFieldLine)
        .join(' | ');

    return `[${header}] ${compressedLines}`;
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

    const disposition = npc.disposition || '?';
    const goals = npc.goals || '?';
    const axes = `${npc.nature}/${npc.training}/${npc.emotion}/${npc.social}/${npc.belief}/${npc.ego}`;

    return `[${name}${aliases}] ${status} aff:${aff} | ${appearance} | ${disposition} | ${goals} | ${axes}`;
}

/**
 * Minify the entire NPC context block.
 */
export function minifyNPCBlock(npcs: NPCEntry[]): string {
    const lines = npcs.map(minifyNPC).join('\n');
    return `[NPC_CTX]\n${lines}\n[/NPC_CTX]`;
}
