import type { LoreChunk } from '../types';
import { countTokens } from './tokenizer';

const ALWAYS_INCLUDE_PREFIXES = [
    'wl-meta', 'wl-econ', 'wl-power'
];

const GENERIC_OBVIOUS_RULES = [
    'economy', 'currency', 'power level', 'global rules', 'mechanics'
];

// Common stop words to exclude from auto-extracted keywords
const STOP_WORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'her',
    'was', 'one', 'our', 'out', 'his', 'had', 'may', 'who', 'been', 'some',
    'them', 'than', 'its', 'into', 'only', 'with', 'from', 'this', 'that',
    'they', 'will', 'each', 'make', 'like', 'been', 'have', 'many', 'most',
    'also', 'made', 'after', 'being', 'their', 'much', 'very', 'when', 'what',
    'which', 'more', 'other', 'about', 'such', 'over', 'just', 'does', 'then',
    'could', 'would', 'should', 'where', 'there', 'those', 'these', 'still',
    'well', 'back', 'even', 'here', 'every', 'both', 'through', 'between',
    'before', 'after', 'during', 'without', 'again', 'because', 'under',
    'real', 'name', 'alias', 'note', 'key', 'class', 'status', 'location',
    'currently', 'known', 'anyone', 'power', 'none', 'variable',
]);



function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function shouldAlwaysInclude(header: string): boolean {
    const headerLower = header.toLowerCase();
    if (ALWAYS_INCLUDE_PREFIXES.some((prefix) => headerLower.includes(prefix))) return true;
    return GENERIC_OBVIOUS_RULES.some((kw) => headerLower.includes(kw));
}

/**
 * Auto-extract trigger keywords from a chunk's header and content.
 * Extracts: proper nouns, unique terms, dollar amounts, organization names.
 * Returns lowercase keywords, deduplicated, max 15.
 */
function extractTriggerKeywords(header: string, content: string): string[] {
    const keywords = new Set<string>();
    const text = header + '\n' + content;

    // 1. Proper nouns (capitalized words, 3+ chars)
    const properNouns = text.match(/[A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})*/g);
    if (properNouns) {
        for (const noun of properNouns) {
            const lower = noun.toLowerCase();
            if (!STOP_WORDS.has(lower) && lower.length > 2) {
                keywords.add(lower);
            }
        }
    }

    // 2. Values after known field labels (e.g., "Location: Wakanda")
    const fieldPatterns = [
        /(?:Real Name|Alias|Affiliation|Location|Slogan)[:\s]+([A-Z][A-Za-z\s]+)/g,
    ];
    for (const pattern of fieldPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const val = match[1].trim().toLowerCase();
            if (val.length > 2 && !STOP_WORDS.has(val)) {
                keywords.add(val);
                // Also add individual words if multi-word
                val.split(/\s+/).forEach(w => {
                    if (w.length > 2 && !STOP_WORDS.has(w)) keywords.add(w);
                });
            }
        }
    }

    // 3. Header keywords (split header into meaningful terms)
    const headerWords = header
        .replace(/\[CHUNK:\s*[A-Z_-]+\]\s*/i, '') // strip [CHUNK: X] prefix
        .split(/[\s/—–]+/)
        .map(w => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
    headerWords.forEach(w => keywords.add(w));

    // 4. Dollar amounts → add "money", "cost", "buy" context triggers
    if (/\$[\d,]+/.test(text)) {
        keywords.add('money');
        keywords.add('cost');
        keywords.add('buy');
        keywords.add('gear');
    }

    // Cap at 15 keywords to prevent overly broad matching
    return Array.from(keywords).slice(0, 15);
}

/**
 * Splits a markdown lore file into chunks by ### headers.
 * Falls back to ## if no ### found.
 * Each chunk gets auto-extracted trigger keywords.
 */
export function chunkLoreFile(markdown: string): LoreChunk[] {
    const normalizedMarkdown = markdown.replace(/\\(#{2,3})\s*/g, '\n$1 ');
    const lines = normalizedMarkdown.split(/\r?\n/);
    const chunks: LoreChunk[] = [];

    const headerRegex = /^\s*(?:#{2,3})\s+(.+)/;

    let currentHeader = '';
    let currentLines: string[] = [];
    let preambleLines: string[] = [];

    for (const line of lines) {
        const match = line.match(headerRegex);
        if (match) {
            if (currentHeader) {
                const content = currentLines.join('\n').trim();
                if (content) {
                    chunks.push({
                        id: slugify(currentHeader),
                        header: currentHeader,
                        content,
                        tokens: countTokens(currentHeader + '\n' + content),
                        alwaysInclude: shouldAlwaysInclude(currentHeader),
                        triggerKeywords: extractTriggerKeywords(currentHeader, content),
                        scanDepth: 2,
                    });
                }
            } else if (currentLines.length > 0) {
                preambleLines = [...currentLines];
            }
            currentHeader = match[1].trim();
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }

    // Last chunk
    if (currentHeader) {
        const content = currentLines.join('\n').trim();
        if (content) {
            chunks.push({
                id: slugify(currentHeader),
                header: currentHeader,
                content,
                tokens: countTokens(currentHeader + '\n' + content),
                alwaysInclude: shouldAlwaysInclude(currentHeader),
                triggerKeywords: extractTriggerKeywords(currentHeader, content),
                scanDepth: 3,
            });
        }
    }

    // Preamble chunk
    const preamble = preambleLines.join('\n').trim();
    if (preamble && countTokens(preamble) > 20) {
        chunks.unshift({
            id: 'preamble',
            header: 'World Overview',
            content: preamble,
            tokens: countTokens('World Overview\n' + preamble),
            alwaysInclude: true,
            triggerKeywords: extractTriggerKeywords('World Overview', preamble),
            scanDepth: 3,
        });
    }

    return chunks;
}
