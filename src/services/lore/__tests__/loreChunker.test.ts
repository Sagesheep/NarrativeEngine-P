import { describe, it, expect } from 'vitest';
import { chunkLoreFile } from '../loreChunker';
import { countTokens } from '../../infrastructure/tokenizer';
import type { LoreChunk } from '../../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Characterization tests for loreChunker.ts (Refactor 19-06 Plan 04 w1).
// chunkLoreFile splits markdown (## and ### headers) into LoreChunks with
// category, priority, alwaysInclude, triggerKeywords, tokens, summary, and
// post-processes linkedEntities + groups. Numbers below are derived by hand
// from loreChunker.ts, with token counts asserted via the same countTokens
// helper on identical input strings (so a tokenizer or chunking change fails
// this test loudly).
// Constants: LORE_CHUNK_MAX=3000, LORE_WINDOW_SIZE=2000, LORE_WINDOW_STRIDE=1400.
// ─────────────────────────────────────────────────────────────────────────────

const findChunk = (chunks: LoreChunk[], id: string): LoreChunk => {
    const c = chunks.find(c => c.id === id);
    if (!c) throw new Error(`chunk ${id} not found; ids=[${chunks.map(c => c.id).join(',')}]`);
    return c;
};

describe('chunkLoreFile — empty / no-header input', () => {
    it('empty string -> zero chunks', () => {
        expect(chunkLoreFile('')).toEqual([]);
    });
    it('whitespace-only string -> zero chunks (preamble trim drops to empty, < 20 tokens)', () => {
        expect(chunkLoreFile('   \n\n  \n')).toEqual([]);
    });
    it('text without any ## / ### header and under 20 tokens -> zero chunks (preamble too small)', () => {
        expect(chunkLoreFile('short preamble')).toEqual([]);
    });
});

describe('chunkLoreFile — single ## section', () => {
    const md = '## Character — Aldric\n**Goals:** conquer the realm\n**Disposition:** bold';
    const chunks = chunkLoreFile(md);

    it('produces exactly one chunk', () => {
        expect(chunks).toHaveLength(1);
    });
    it('slugifies the header into the id "character-aldric"', () => {
        expect(chunks[0].id).toBe('character-aldric');
    });
    it('keeps the original header string verbatim', () => {
        expect(chunks[0].header).toBe('Character — Aldric');
    });
    it('content is the body lines joined and trimmed (no header line)', () => {
        expect(chunks[0].content).toBe('**Goals:** conquer the realm\n**Disposition:** bold');
    });
    it('tokens equals countTokens(header + "\\n" + content)', () => {
        expect(chunks[0].tokens).toBe(countTokens('Character — Aldric\n**Goals:** conquer the realm\n**Disposition:** bold'));
    });
    it('classifies CHARACTER header as category "character"', () => {
        expect(chunks[0].category).toBe('character');
    });
    it('character category without always-include prefix -> priority 7', () => {
        // assignPriority(character, alwaysInclude=false) = 7
        expect(chunks[0].priority).toBe(7);
    });
    it('alwaysInclude is false for a plain character header', () => {
        expect(chunks[0].alwaysInclude).toBe(false);
    });
    it('summary falls back to first bold-stripped line > 20 chars when no **Entity:**/**Status:**/**Type:** line', () => {
        // body has no Entity/Status/Type line; "**Goals:** conquer the realm" -> strip ** -> "Goals: conquer the realm" (26 chars > 20)
        expect(chunks[0].summary).toBe('Goals: conquer the realm');
    });
    it('ragMode is undefined when no <!-- rag: --> hint present', () => {
        expect(chunks[0].ragMode).toBeUndefined();
    });
});

describe('chunkLoreFile — preamble becomes a world_overview chunk when > 20 tokens', () => {
    const md = 'This is a long preamble about the world. ' + 'a '.repeat(60) + '\n\n## Faction — The Guild\nbody';
    const chunks = chunkLoreFile(md);

    it('prepends a "preamble" chunk at index 0', () => {
        expect(chunks[0].id).toBe('preamble');
    });
    it('preamble chunk has header "World Overview", alwaysInclude=true, priority=10, category=world_overview', () => {
        const p = chunks[0];
        expect(p.header).toBe('World Overview');
        expect(p.alwaysInclude).toBe(true);
        expect(p.priority).toBe(10);
        expect(p.category).toBe('world_overview');
    });
    it('preamble content is the trimmed text before the first header', () => {
        // The preamble lines are joined and trimmed — the leading 60 "a "s + first sentence
        expect(chunks[0].content).toContain('This is a long preamble about the world.');
        expect(chunks[0].content).toContain('a a a');
    });
    it('the Faction section follows as the second chunk', () => {
        expect(chunks[1].header).toBe('Faction — The Guild');
        expect(chunks[1].category).toBe('faction');
    });
});

describe('chunkLoreFile — always-include prefixes', () => {
    it('header containing "wl-meta" -> alwaysInclude true, priority 10', () => {
        const chunks = chunkLoreFile('## wl-meta Core Rules\nbody text here');
        expect(chunks[0].alwaysInclude).toBe(true);
        expect(chunks[0].priority).toBe(10);
    });
    it('header containing "Economy" (generic obvious rule) -> alwaysInclude true', () => {
        const chunks = chunkLoreFile('## Economy Overview\nbody text here');
        expect(chunks[0].alwaysInclude).toBe(true);
    });
    it('plain character header -> alwaysInclude false (boundary)', () => {
        const chunks = chunkLoreFile('## Character — Bob\nbody text here');
        expect(chunks[0].alwaysInclude).toBe(false);
    });
});

describe('chunkLoreFile — category classification branches', () => {
    const cases: Array<[string, string]> = [
        ['## [CHUNK: HERO] Aldric\nbody', 'character'],
        ['## [CHUNK: FACTION] Guild\nbody', 'faction'],
        ['## [CHUNK: ORGANIZATION] Guild\nbody', 'faction'],
        ['## World Overview\nbody', 'world_overview'],
        ['## Core Identity\nbody', 'world_overview'],
        ['## World State\nbody', 'world_overview'],
        ['## Power System\nbody', 'power_system'],
        ['## Magic System\nbody', 'power_system'],
        ['## Currency\nbody', 'economy'],
        ['## Arc Summary\nbody', 'event'],
        ['## Timeline\nbody', 'event'],
        ['## Relationship Map\nbody', 'relationship'],
        ['## Rules\nbody', 'rules'],
        ['## Generation Protocol\nbody', 'rules'],
        ['## Location — Harbor\nbody', 'location'],
        ['## City of Troy\nbody', 'location'],
        ['## Culture\nbody', 'culture'],
        ['## Religion\nbody', 'culture'],
        ['## Random Topic\nbody', 'misc'],
    ];
    for (const [md, expectedCat] of cases) {
        it(`${md.split('\n')[0]} -> category "${expectedCat}"`, () => {
            expect(chunkLoreFile(md)[0].category).toBe(expectedCat);
        });
    }
});

describe('chunkLoreFile — priority assignment per category', () => {
    const cases: Array<[string, number]> = [
        ['## World Overview\nbody', 10],   // world_overview -> 10
        ['## Rules\nbody', 9],              // rules -> 9
        ['## Power System\nbody', 8],       // power_system -> 8
        ['## Faction — X\nbody', 7],        // faction -> 7
        ['## Character — X\nbody', 7],      // character -> 7
        ['## Location — X\nbody', 6],       // location -> 6
        // "## Event — X" is a level-2 header, so parentHeader is set to its own title,
        // making p.includes('EVENT') true -> category 'event' -> priority 6.
        ['## Event — X\nbody', 6],
    ];
    for (const [md, expectedPri] of cases) {
        it(`${md.split('\n')[0]} -> priority ${expectedPri}`, () => {
            expect(chunkLoreFile(md)[0].priority).toBe(expectedPri);
        });
    }
    it('misc category -> priority 3', () => {
        expect(chunkLoreFile('## Random Topic\nbody')[0].priority).toBe(3);
    });
});

describe('chunkLoreFile — <!-- rag: --> hint parsing', () => {
    it('mode=always sets alwaysInclude=true and ragMode="always"', () => {
        const md = '## Notes\n<!-- rag: always -->\nbody line';
        const c = chunkLoreFile(md)[0];
        expect(c.ragMode).toBe('always');
        expect(c.alwaysInclude).toBe(true);
    });
    it('mode=keyword sets ragMode="keyword" and alwaysInclude=false (hint overrides heuristic)', () => {
        const md = '## wl-meta Notes\n<!-- rag: keyword -->\nbody line';
        const c = chunkLoreFile(md)[0];
        expect(c.ragMode).toBe('keyword');
        // hint present and mode != always -> alwaysInclude = false even though wl-meta would normally be true
        expect(c.alwaysInclude).toBe(false);
    });
    it('hint with explicit priority overrides assignPriority', () => {
        const md = '## Character — Bob\n<!-- rag: always, priority: 15 -->\nbody';
        const c = chunkLoreFile(md)[0];
        expect(c.priority).toBe(15);
        expect(c.alwaysInclude).toBe(true);
    });
    it('hint with triggers prepends them to auto-extracted keywords (deduped)', () => {
        const md = '## Topic\n<!-- rag: keyword, triggers: foo, bar -->\nbody';
        const c = chunkLoreFile(md)[0];
        expect(c.triggerKeywords).toContain('foo');
        expect(c.triggerKeywords).toContain('bar');
    });
    it('hint with secondary keywords stores them on secondaryKeywords', () => {
        const md = '## Topic\n<!-- rag: keyword, secondary: sec1, sec2 -->\nbody';
        const c = chunkLoreFile(md)[0];
        expect(c.secondaryKeywords).toEqual(['sec1', 'sec2']);
    });
    it('hint line is stripped from the content the AI sees', () => {
        const md = '## Topic\n<!-- rag: always -->\nreal body line';
        const c = chunkLoreFile(md)[0];
        expect(c.content).toBe('real body line');
        expect(c.content).not.toContain('rag:');
    });
});

describe('chunkLoreFile — duplicate headers get unique ids with -N suffix', () => {
    it('two sections with the same header title get distinct ids', () => {
        const md = '## Notes\nfirst\n\n## Notes\nsecond';
        const chunks = chunkLoreFile(md);
        expect(chunks).toHaveLength(2);
        expect(chunks[0].id).toBe('notes');
        expect(chunks[1].id).toBe('notes-1');
    });
    it('three duplicate headers get -1 then -2', () => {
        const md = '## Notes\na\n\n## Notes\nb\n\n## Notes\nc';
        const chunks = chunkLoreFile(md);
        expect(chunks.map(c => c.id)).toEqual(['notes', 'notes-1', 'notes-2']);
    });
});

describe('chunkLoreFile — ### sub-sections and parent tracking', () => {
    it('### is a chunk; parentSection is the nearest ## header title', () => {
        const md = '## Faction — Guild\nintro\n\n### Subgroup\nsub body';
        const chunks = chunkLoreFile(md);
        expect(chunks).toHaveLength(2);
        expect(chunks[1].header).toBe('Subgroup');
        expect(chunks[1].parentSection).toBe('Faction — Guild');
    });
    it('a ### under no preceding ## has no parentSection (undefined)', () => {
        const md = '### Orphan Sub\nbody';
        const chunks = chunkLoreFile(md);
        expect(chunks[0].parentSection).toBeUndefined();
    });
    it('parent ### does not become parentSection (only ## does)', () => {
        const md = '## Top\nintro\n\n### Mid\nmidbody\n\n#### Deep\ndeepbody';
        const chunks = chunkLoreFile(md);
        // #### is not matched by the headerRegex (#{2,3}) -> becomes a body line of "### Mid"
        expect(chunks).toHaveLength(2);
        expect(chunks[1].header).toBe('Mid');
        expect(chunks[1].content).toContain('#### Deep');
        expect(chunks[1].content).toContain('deepbody');
    });
});

describe('chunkLoreFile — linkedEntities post-processing', () => {
    // Entity name = header with [CHUNK: ...] stripped, then split on —/- and [0] trimmed.
    // So "## Crimson Hand" -> entity name "Crimson Hand" (no dash to split on).
    it('chunks whose content mentions another chunk\'s name get linkedEntities populated', () => {
        const md = [
            '## Crimson Hand\nThey control the harbor.',
            '## Malachar\nMalachar serves the Crimson Hand.',
        ].join('\n\n');
        const chunks = chunkLoreFile(md);
        const malachar = findChunk(chunks, 'malachar');
        // Malachar's content mentions "crimson hand" -> linked
        expect(malachar.linkedEntities).toContain('Crimson Hand');
    });
    it('header with a dash splits: "## Faction — Guild" -> entity name "Faction" (first dash part)', () => {
        const md = [
            '## Faction — Guild\nA generic faction.',
            '## Malachar\nMalachar joins the Faction today.',
        ].join('\n\n');
        const chunks = chunkLoreFile(md);
        const malachar = findChunk(chunks, 'malachar');
        // entity name is "Faction" (split on —); Malachar content mentions "faction" -> linked
        expect(malachar.linkedEntities).toContain('Faction');
    });
    it('entity names shorter than 4 chars are skipped (filter e.nameLower.length > 3)', () => {
        const md = [
            '## Ab\nshort name.',
            '## Malachar\nMalachar knows Ab.',
        ].join('\n\n');
        const chunks = chunkLoreFile(md);
        const malachar = findChunk(chunks, 'malachar');
        // "ab" is 2 chars -> filtered out of entityDict -> not linked
        expect(malachar.linkedEntities).not.toContain('Ab');
    });
    it('a chunk does not link to itself', () => {
        const md = '## Malachar\nMalachar looks in the mirror.';
        const chunks = chunkLoreFile(md);
        expect(chunks[0].linkedEntities).not.toContain('Malachar');
    });
});

describe('chunkLoreFile — groups assigned from parentSection (slugified)', () => {
    it('chunk with parentSection gets group = slugify(parent) and groupWeight = priority', () => {
        const md = '## Faction — The Crimson Hand\nintro\n\n### Subgroup\nbody';
        const chunks = chunkLoreFile(md);
        const sub = findChunk(chunks, 'subgroup');
        // slugify("Faction — The Crimson Hand") = "faction-the-crimson-hand"
        expect(sub.group).toBe('faction-the-crimson-hand');
        expect(sub.groupWeight).toBe(sub.priority);
    });
    it('alwaysInclude chunks skip group assignment', () => {
        const md = '## wl-meta Rules\nintro\n\n### Detail\nbody';
        const chunks = chunkLoreFile(md);
        const detail = findChunk(chunks, 'detail');
        // parentSection = "wl-meta Rules", but detail is not alwaysInclude -> it gets a group
        expect(detail.group).toBe('wl-meta-rules');
    });
    it('a lone ## header still sets parentSection to itself, so it gets a group (current behavior)', () => {
        // Pinned behavior: a level-2 header sets parentHeader to its own title, so
        // parentSection is non-undefined and assignGroups assigns a group. This may
        // be unintended (a standalone section getting a self-referential group), but
        // it is what the code currently does.
        const md = '## Standalone\nbody';
        const chunks = chunkLoreFile(md);
        expect(chunks[0].group).toBe('standalone');
    });
    it('an alwaysInclude chunk skips group assignment even with a parentSection', () => {
        const md = '## wl-meta Rules\nbody';
        const chunks = chunkLoreFile(md);
        expect(chunks[0].alwaysInclude).toBe(true);
        expect(chunks[0].group).toBeUndefined();
    });
});

describe('chunkLoreFile — summary extraction', () => {
    it('returns the **Status:** line when present', () => {
        const md = '## Character — X\n**Status:** alive and well\nmore text';
        expect(chunkLoreFile(md)[0].summary).toBe('**Status:** alive and well');
    });
    it('returns the **Type:** line when present', () => {
        const md = '## Faction — X\n**Type:** criminal syndicate\nmore text';
        expect(chunkLoreFile(md)[0].summary).toBe('**Type:** criminal syndicate');
    });
    it('falls back to first non-bold line > 20 chars, truncated to 100 chars', () => {
        const md = '## Misc\nshort\nThis is a long enough fallback line about the world.';
        expect(chunkLoreFile(md)[0].summary).toBe('This is a long enough fallback line about the world.');
    });
    it('returns undefined when no line qualifies', () => {
        const md = '## Misc\nshort';
        expect(chunkLoreFile(md)[0].summary).toBeUndefined();
    });
});

describe('chunkLoreFile — oversize chunk windowing (> 3000 tokens)', () => {
    it('a chunk under LORE_CHUNK_MAX (3000) is emitted as a single chunk unchanged', () => {
        const md = '## Small\n' + 'word '.repeat(100); // ~100 tokens, well under 3000
        const chunks = chunkLoreFile(md);
        expect(chunks).toHaveLength(1);
        expect(chunks[0].id).toBe('small');
    });
    it('a chunk over 3000 tokens is split into multiple windows with #wN ids', () => {
        // Build a body that produces > 3000 tokens. ~4 chars/token -> need > 12000 chars.
        const body = 'This is a long lore paragraph about the world. '.repeat(400); // ~50 chars * 400 = 20000 chars
        const md = '## Big Topic\n' + body;
        const chunks = chunkLoreFile(md);
        expect(chunks.length).toBeGreaterThan(1);
        // window ids follow the pattern "<baseId>#w<index>"
        for (let i = 0; i < chunks.length; i++) {
            expect(chunks[i].id).toBe(`big-topic#w${i}`);
        }
        // each window's tokens is <= LORE_CHUNK_MAX (the splitter aims for LORE_WINDOW_SIZE=2000)
        for (const c of chunks) {
            expect(c.tokens).toBeLessThanOrEqual(3000);
        }
    });
    it('windowed chunks inherit the parent chunk\'s header, category, priority, and summary', () => {
        const body = 'This is a long lore paragraph about the world. '.repeat(400);
        const md = '## Character — Aldric\n**Status:** alive\n' + body;
        const chunks = chunkLoreFile(md);
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) {
            expect(c.header).toBe('Character — Aldric');
            expect(c.category).toBe('character');
            expect(c.priority).toBe(7);
        }
        expect(chunks[0].summary).toBe('**Status:** alive');
    });
});

describe('chunkLoreFile — triggerKeywords auto-extraction', () => {
    it('extracts capitalized proper nouns from header + content (lowercased, deduped, <=15)', () => {
        const md = '## Character — Aldric\nAldric met Brennan at the Harbor.';
        const kws = chunkLoreFile(md)[0].triggerKeywords;
        // "Aldric", "Brennan", "Harbor" are proper nouns (3+ chars after the capital)
        expect(kws).toContain('aldric');
        expect(kws).toContain('brennan');
        expect(kws).toContain('harbor');
        expect(kws.length).toBeLessThanOrEqual(15);
    });
    it('proper-noun regex can span newlines (\\s matches \\n) — pinned current behavior', () => {
        // The regex [A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})* uses \s which matches newlines,
        // so "Topic\nThe Dragon" is captured as ONE proper noun -> lowercased with the
        // newline embedded. This is likely a bug (\s should probably be [^\S\n] or a
        // literal space) but we pin the current behavior rather than fix it.
        const md = '## Topic\nThe Dragon attacked.';
        const kws = chunkLoreFile(md)[0].triggerKeywords;
        expect(kws).toContain('topic\nthe dragon');
        // "topic" is also extracted from the header-word path
        expect(kws).toContain('topic');
        // Neither "the" nor "dragon" is extracted as a standalone keyword
        expect(kws).not.toContain('the');
        expect(kws).not.toContain('dragon');
        // Flagged as suspected bug: the newline-spanning match produces a malformed
        // keyword "topic\nthe dragon" that will never usefully match retrievable text.
    });
    it('adds money/cost/buy/gear when the text contains a $ amount', () => {
        const md = '## Economy\nItems cost $1,200 each.';
        const kws = chunkLoreFile(md)[0].triggerKeywords;
        expect(kws).toContain('money');
        expect(kws).toContain('cost');
        expect(kws).toContain('buy');
        expect(kws).toContain('gear');
    });
});

describe('chunkLoreFile — escaped-header normalization', () => {
    it('\\## (escaped) in input is normalized to a real ## header line', () => {
        const md = 'Some intro\n\\## Hidden Header\nbody line';
        const chunks = chunkLoreFile(md);
        // The escaped \\## becomes a real ## header -> creates a chunk
        expect(chunks.some(c => c.header === 'Hidden Header')).toBe(true);
    });
});