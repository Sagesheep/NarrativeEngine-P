import type { LoreChunk, LoreCategory } from '../types';
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

function extractTriggerKeywords(header: string, content: string): string[] {
    const keywords = new Set<string>();
    const text = header + '\n' + content;

    const properNouns = text.match(/[A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})*/g);
    if (properNouns) {
        for (const noun of properNouns) {
            const lower = noun.toLowerCase();
            if (!STOP_WORDS.has(lower) && lower.length > 2) {
                keywords.add(lower);
            }
        }
    }

    const fieldPatterns = [
        /(?:Real Name|Alias|Affiliation|Location|Slogan)[:\s]+([A-Z][A-Za-z\s]+)/g,
    ];
    for (const pattern of fieldPatterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const val = match[1].trim().toLowerCase();
            if (val.length > 2 && !STOP_WORDS.has(val)) {
                keywords.add(val);
                val.split(/\s+/).forEach(w => {
                    if (w.length > 2 && !STOP_WORDS.has(w)) keywords.add(w);
                });
            }
        }
    }

    const headerWords = header
        .replace(/\[CHUNK:\s*[A-Z_-]+\]\s*/i, '')
        .split(/[\s/—–]+/)
        .map(w => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
    headerWords.forEach(w => keywords.add(w));

    if (/\$[\d,]+/.test(text)) {
        keywords.add('money');
        keywords.add('cost');
        keywords.add('buy');
        keywords.add('gear');
    }

    return Array.from(keywords).slice(0, 15);
}

function assignPriority(category: LoreCategory, alwaysInclude: boolean): number {
    if (alwaysInclude) return 10;
    switch (category) {
        case 'world_overview': return 10;
        case 'rules': return 9;
        case 'power_system': return 8;
        case 'faction': return 7;
        case 'character': return 7;
        case 'location': return 6;
        case 'event': return 6;
        case 'relationship': return 6;
        case 'economy': return 5;
        case 'culture': return 5;
        default: return 3;
    }
}

function classifyCategory(header: string, content: string, parentHeader?: string): LoreCategory {
    const h = (header || '').toUpperCase();
    const p = (parentHeader || '').toUpperCase();
    const c = (content || '');

    if (h.includes('[CHUNK: HERO') || p.includes('CHARACTER') || h.includes('CHARACTER —')) return 'character';
    if (h.includes('[CHUNK: FACTION') || h.includes('[CHUNK: ORGANIZATION') || p.includes('FACTION')) return 'faction';
    if (h.includes('WORLD OVERVIEW') || h.includes('CORE IDENTITY') || h.includes('WORLD STATE')) return 'world_overview';
    if (h.includes('POWER SYSTEM') || h.includes('MAGIC') || h.includes('MANA') || h.includes('RANK')) return 'power_system';
    if (h.includes('ECONOMY') || h.includes('CURRENCY') || h.includes('COST')) return 'economy';
    if (h.includes('ARC SUMMARY') || h.includes('DEATH FLAG') || h.includes('TIMELINE') || p.includes('EVENT')) return 'event';
    if (h.includes('RELATIONSHIP') || h.includes('ERD') || h.includes('LEVERAGE')) return 'relationship';
    if (h.includes('RULES') || h.includes('GENERATION PROTOCOL') || h.includes('MECHANIC')) return 'rules';
    if (h.includes('LOCATION') || h.includes('CITY') || h.includes('REGION') || p.includes('LOCATION')) return 'location';
    if (h.includes('CULTURE') || h.includes('RELIGION') || h.includes('CUSTOM')) return 'culture';

    // Heuristics
    if (c.includes('**Goals:**') && (c.includes('**Disposition:**') || c.includes('**Status:**'))) return 'character';
    if (c.includes('**Type:**') && (c.includes('Members:**') || c.includes('Stance:**'))) return 'faction';

    return 'misc';
}

function generateSummary(_header: string, content: string): string | undefined {
    const lines = content.split('\n');
    for (const line of lines) {
        if (line.includes('**Entity:**') || line.includes('**Status:**') || line.includes('**Type:**')) {
            return line.trim();
        }
    }
    // Fallback: first non-empty line without bold that has some meat
    const cleanLines = lines.map(l => l.replace(/\*\*/g, '').trim()).filter(l => l.length > 20);
    return cleanLines.length > 0 ? cleanLines[0].substring(0, 100) : undefined;
}

function extractLinkedEntities(chunks: LoreChunk[]) {
    const entityDict = chunks.map(c => {
        let name = c.header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();
        name = name.split(/[—–-]/)[0].trim(); // Take the portion before a dash
        return { name, id: c.id, nameLower: name.toLowerCase() };
    }).filter(e => e.nameLower.length > 3);

    for (const chunk of chunks) {
        const text = chunk.content.toLowerCase();
        const linked = new Set<string>();
        for (const e of entityDict) {
            if (e.id !== chunk.id && text.includes(e.nameLower)) {
                linked.add(e.name);
            }
        }
        chunk.linkedEntities = Array.from(linked);
    }
}

export function chunkLoreFile(markdown: string): LoreChunk[] {
    const normalizedMarkdown = markdown.replace(/\\(#{2,3})\s*/g, '\n$1 ');
    const lines = normalizedMarkdown.split(/\r?\n/);
    const chunks: LoreChunk[] = [];
    const usedIds = new Set<string>();

    function getUniqueId(baseId: string): string {
        let uniqueId = baseId;
        let counter = 1;
        while (usedIds.has(uniqueId)) {
            uniqueId = `${baseId}-${counter}`;
            counter++;
        }
        usedIds.add(uniqueId);
        return uniqueId;
    }

    const headerRegex = /^\s*(#{2,3})\s+(.+)/;

    let currentHeader = '';
    let parentHeader = '';
    let currentLines: string[] = [];
    let preambleLines: string[] = [];

    const flushChunk = () => {
        const content = currentLines.join('\n').trim();
        if (content && currentHeader) {
            const baseId = slugify(currentHeader);
            const id = getUniqueId(baseId);
            const alwaysInclude = shouldAlwaysInclude(currentHeader);
            const category = classifyCategory(currentHeader, content, parentHeader);
            
            // Extract Rag metadata blocks if any overrides exist
            let finalScanDepth = 3;
            if (content.includes('**scan_depth:**')) {
                const match = content.match(/\*\*scan_depth:\*\*\s*(.+)/);
                if (match) finalScanDepth = parseInt(match[1]) || 3;
            }

            chunks.push({
                id,
                header: currentHeader,
                content,
                tokens: countTokens(currentHeader + '\n' + content),
                alwaysInclude,
                triggerKeywords: extractTriggerKeywords(currentHeader, content),
                scanDepth: finalScanDepth,
                category,
                linkedEntities: [], // Populated post-processing
                parentSection: parentHeader || undefined,
                priority: assignPriority(category, alwaysInclude),
                summary: generateSummary(currentHeader, content)
            });
        }
    };

    for (const line of lines) {
        const match = line.match(headerRegex);
        if (match) {
            const level = match[1].length; 
            const title = match[2].trim();

            if (currentHeader) flushChunk();
            else if (currentLines.length > 0) preambleLines = [...currentLines];

            if (level === 2) {
                parentHeader = title;
            }

            currentHeader = title;
            currentLines = [];
        } else {
            currentLines.push(line);
        }
    }

    if (currentHeader) flushChunk();

    // Preamble logic
    const preamble = preambleLines.join('\n').trim();
    if (preamble && countTokens(preamble) > 20) {
        const title = 'World Overview';
        chunks.unshift({
            id: 'preamble',
            header: title,
            content: preamble,
            tokens: countTokens(title + '\n' + preamble),
            alwaysInclude: true,
            triggerKeywords: extractTriggerKeywords(title, preamble),
            scanDepth: 3,
            category: 'world_overview',
            linkedEntities: [],
            priority: 10,
            summary: generateSummary(title, preamble)
        });
    }

    extractLinkedEntities(chunks);

    return chunks;
}

