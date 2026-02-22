import type { LoreChunk } from '../types';

const ALWAYS_INCLUDE_PREFIXES = [
    'wl-meta', 'wl-econ', 'wl-power'
];

const GENERIC_OBVIOUS_RULES = [
    'economy', 'currency', 'power level', 'global rules', 'mechanics'
];

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

/**
 * Only searches the *header* for rule-designating keywords to prevent
 * huge swaths of regular lore (like NPCs with 'Rank: B') from being always-included.
 */
function shouldAlwaysInclude(header: string): boolean {
    const headerLower = header.toLowerCase();
    if (ALWAYS_INCLUDE_PREFIXES.some((prefix) => headerLower.includes(prefix))) return true;
    return GENERIC_OBVIOUS_RULES.some((kw) => headerLower.includes(kw));
}

/**
 * Splits a markdown lore file into chunks by ### headers.
 * Falls back to ## if no ### found.
 * Each chunk = { id, header, content, tokens, alwaysInclude }
 */
export function chunkLoreFile(markdown: string): LoreChunk[] {
    // Normalize escaped headers (e.g. \### -> \n### ) that occur from bad copy-pasting
    const normalizedMarkdown = markdown.replace(/\\(#{2,3})\s*/g, '\n$1 ');
    const lines = normalizedMarkdown.split(/\r?\n/);
    const chunks: LoreChunk[] = [];

    // Split on ANY ## or ### header to prevent massive chunks (allow leading whitespace)
    const headerRegex = /^\s*(?:#{2,3})\s+(.+)/;

    let currentHeader = '';
    let currentLines: string[] = [];
    let preambleLines: string[] = [];

    for (const line of lines) {
        const match = line.match(headerRegex);
        if (match) {
            // Save previous chunk
            if (currentHeader) {
                const content = currentLines.join('\n').trim();
                if (content) {
                    chunks.push({
                        id: slugify(currentHeader),
                        header: currentHeader,
                        content,
                        tokens: estimateTokens(currentHeader + '\n' + content),
                        alwaysInclude: shouldAlwaysInclude(currentHeader),
                    });
                }
            } else if (currentLines.length > 0) {
                // Text before first header = preamble
                preambleLines = [...currentLines];
            }
            currentHeader = match[1].trim();
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }

    // Don't forget last chunk
    if (currentHeader) {
        const content = currentLines.join('\n').trim();
        if (content) {
            chunks.push({
                id: slugify(currentHeader),
                header: currentHeader,
                content,
                tokens: estimateTokens(currentHeader + '\n' + content),
                alwaysInclude: shouldAlwaysInclude(currentHeader),
            });
        }
    }

    // If preamble has substantial content, add as first chunk
    const preamble = preambleLines.join('\n').trim();
    if (preamble && estimateTokens(preamble) > 20) {
        chunks.unshift({
            id: 'preamble',
            header: 'World Overview',
            content: preamble,
            tokens: estimateTokens('World Overview\n' + preamble),
            alwaysInclude: true,
        });
    }

    return chunks;
}
