import { describe, it, expect } from 'vitest';
import { extractEngineSeeds } from '../loreEngineSeeder';
import type { LoreChunk, EngineSeed } from '../../../types';

// ─────────────────────────────────────────────────────────────────────────────
// Characterization tests for loreEngineSeeder.ts (Refactor 19-06 Plan 04 w1).
// extractEngineSeeds walks LoreChunks and builds an EngineSeed (8 string[] fields)
// from category-specific heuristics + explicit **Field:** lines. All magic strings
// below are derived by hand from loreEngineSeeder.ts.
// ─────────────────────────────────────────────────────────────────────────────

const chunk = (over: Partial<LoreChunk>): LoreChunk => ({
    id: 'c1',
    header: '',
    content: '',
    tokens: 0,
    alwaysInclude: false,
    triggerKeywords: [],
    scanDepth: 3,
    category: 'misc',
    linkedEntities: [],
    priority: 3,
    ...over,
} as LoreChunk);

const emptySeed = (): EngineSeed => ({
    surpriseTypes: [], surpriseTones: [], encounterTypes: [], encounterTones: [],
    worldWho: [], worldWhere: [], worldWhy: [], worldWhat: [],
});

describe('extractEngineSeeds — empty / no-input cases', () => {
    it('empty chunks array -> all eight seed fields are empty arrays', () => {
        expect(extractEngineSeeds([])).toEqual(emptySeed());
    });
    it('chunks with no matching category/fields -> all eight seed fields empty', () => {
        const c = chunk({ category: 'misc', content: 'just some text with no fields' });
        expect(extractEngineSeeds([c])).toEqual(emptySeed());
    });
    it('a chunk with category faction but empty header and no Key Members/Leader -> whoSet stays empty', () => {
        const c = chunk({ category: 'faction', header: '', content: 'a faction body' });
        const seed = extractEngineSeeds([c]);
        expect(seed.worldWho).toEqual([]);
    });
});

describe('extractEngineSeeds — WHO (factions + leaders)', () => {
    it('faction chunk adds its header name (with [CHUNK:] prefix and dash suffix stripped) to worldWho', () => {
        const c = chunk({
            category: 'faction',
            header: '[CHUNK: FACTION] The Crimson Hand — A Syndicate',
            content: 'body',
        });
        // header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i,'') -> "The Crimson Hand — A Syndicate"
        // .split(/[—–-]/)[0].trim() -> "The Crimson Hand"
        expect(extractEngineSeeds([c]).worldWho).toEqual(['The Crimson Hand']);
    });
    it('**Key Members:** line splits on comma and trims each into worldWho', () => {
        const c = chunk({
            category: 'faction',
            header: 'Guild',
            content: '**Key Members:** Alice, Bob, Carol',
        });
        expect(extractEngineSeeds([c]).worldWho).toEqual(['Guild', 'Alice', 'Bob', 'Carol']);
    });
    it('**Leader:** line is the fallback when **Key Members:** is absent', () => {
        const c = chunk({
            category: 'faction',
            header: 'Guild',
            content: '**Leader:** Malachar',
        });
        expect(extractEngineSeeds([c]).worldWho).toEqual(['Guild', 'Malachar']);
    });
    it('when both Key Members and Leader present, only Key Members fires (|| short-circuits, .+ stops at newline)', () => {
        const c = chunk({
            category: 'faction',
            header: 'Guild',
            content: '**Key Members:** Alice\n**Leader:** Bob',
        });
        // leaderMatch uses `||`: Key Members matches first, and `.+` stops at the newline,
        // so only "Alice" is captured. The Leader line is never parsed. Bob is NOT added.
        // Pinned current behavior (the `||` means Leader is a fallback, not additive).
        expect(extractEngineSeeds([c]).worldWho.sort()).toEqual(['Alice', 'Guild']);
    });
});

describe('extractEngineSeeds — WHERE (locations + overview proper nouns)', () => {
    it('location chunk adds "in or around <name>" where name is the header (dash-split first part)', () => {
        const c = chunk({ category: 'location', header: 'Harbor District', content: 'body' });
        expect(extractEngineSeeds([c]).worldWhere).toEqual(['in or around Harbor District']);
    });
    it('world_overview chunk extracts "in <Place>" proper-noun phrases', () => {
        const c = chunk({
            category: 'world_overview',
            header: 'Overview',
            content: 'The story unfolds in the Capital and in distant Ryuten.',
        });
        // regex /in (the )?([A-Z][a-z]+(\s[A-Z][a-z]+)*)/g -> "in the Capital", "in distant Ryuten"
        // wait: "in distant Ryuten" — "distant" is lowercase, so the regex (the )? then [A-Z]... 
        // "in distant Ryuten": after "in ", optional "the " (not present), then [A-Z][a-z]+ — "distant" starts lowercase -> no match there.
        // Actually the regex is /in (the )?([A-Z][a-z]+(\s[A-Z][a-z]+)*)/g — it looks for "in " then optional "the " then a capitalized word.
        // "in the Capital" matches -> "in the Capital"
        // "in distant Ryuten" — "in " then "the "? no. then [A-Z] — "distant" is lowercase -> no match.
        // So only "in the Capital" is captured.
        expect(extractEngineSeeds([c]).worldWhere).toEqual(['in the Capital']);
    });
});

describe('extractEngineSeeds — WHY (goals + motivations)', () => {
    it('**Goals:** line (any category) -> "to <lowercased value>" added to worldWhy', () => {
        const c = chunk({ category: 'character', header: 'Aldric', content: '**Goals:** Conquer The Realm' });
        expect(extractEngineSeeds([c]).worldWhy).toEqual(['to conquer the realm']);
    });
    it('**Motivations:** in an event chunk -> "driven by <lowercased value>"', () => {
        const c = chunk({ category: 'event', header: 'The Coup', content: '**Motivations:** Pure Greed' });
        expect(extractEngineSeeds([c]).worldWhy).toEqual(['driven by pure greed']);
    });
    it('**Motivation:** (singular) also matches the regex (Motivations? with optional s)', () => {
        const c = chunk({ category: 'faction', header: 'Guild', content: '**Motivation:** Revenge' });
        expect(extractEngineSeeds([c]).worldWhy).toEqual(['driven by revenge']);
    });
    it('**Motivations:** in a non-event/non-faction chunk is NOT added (gate is event||faction)', () => {
        const c = chunk({ category: 'character', header: 'A', content: '**Motivations:** power' });
        expect(extractEngineSeeds([c]).worldWhy).toEqual([]);
    });
});

describe('extractEngineSeeds — WHAT (event summaries + arc headers)', () => {
    it('event chunk with a summary > 5 chars adds the lowercased summary to worldWhat', () => {
        const c = chunk({ category: 'event', header: 'Coup', content: 'body', summary: 'The king was overthrown' });
        expect(extractEngineSeeds([c]).worldWhat).toEqual(['the king was overthrown']);
    });
    it('event chunk with a summary <= 5 chars does NOT add to worldWhat', () => {
        const c = chunk({ category: 'event', header: 'Coup', content: 'body', summary: 'short' });
        // "short" is 5 chars, the gate is `summaryLine.length > 5` -> 5 is NOT > 5 -> skipped
        expect(extractEngineSeeds([c]).worldWhat).toEqual([]);
    });
    it('event chunk with header containing "arc" adds "initiated <header-stripped>"', () => {
        const c = chunk({
            category: 'event',
            header: '[CHUNK: ARC] The Great War',
            content: 'body',
            summary: undefined,
        });
        // header.replace(...) -> "The Great War", trim -> "The Great War"
        // -> "initiated The Great War"
        expect(extractEngineSeeds([c]).worldWhat).toEqual(['initiated The Great War']);
    });
});

describe('extractEngineSeeds — TONES (world_overview **Tone:**)', () => {
    it('splits **Tone:** on ,/ and uppercases each, adding to BOTH surpriseTones and encounterTones', () => {
        const c = chunk({
            category: 'world_overview',
            header: 'Overview',
            content: '**Tone:** dark, tense / epic',
        });
        const seed = extractEngineSeeds([c]);
        expect(seed.surpriseTones.sort()).toEqual(['DARK', 'EPIC', 'TENSE']);
        expect(seed.encounterTones.sort()).toEqual(['DARK', 'EPIC', 'TENSE']);
    });
    it('**Tone:** in a non-overview chunk is ignored (gate is category === world_overview)', () => {
        const c = chunk({ category: 'faction', header: 'X', content: '**Tone:** dark' });
        const seed = extractEngineSeeds([c]);
        expect(seed.surpriseTones).toEqual([]);
        expect(seed.encounterTones).toEqual([]);
    });
});

describe('extractEngineSeeds — TYPES (category-derived defaults)', () => {
    it('power_system chunk adds POWER_ANOMALY to encounterTypes and MAGIC_FLUCTUATION to surpriseTypes', () => {
        const c = chunk({ category: 'power_system', header: 'Magic', content: 'body' });
        const seed = extractEngineSeeds([c]);
        expect(seed.encounterTypes).toEqual(['POWER_ANOMALY']);
        expect(seed.surpriseTypes).toEqual(['MAGIC_FLUCTUATION']);
    });
    it('rules chunk adds SYSTEM_GLITCH to encounterTypes and MECHANIC_SHIFT to surpriseTypes', () => {
        const c = chunk({ category: 'rules', header: 'Rules', content: 'body' });
        const seed = extractEngineSeeds([c]);
        expect(seed.encounterTypes).toEqual(['SYSTEM_GLITCH']);
        expect(seed.surpriseTypes).toEqual(['MECHANIC_SHIFT']);
    });
    it('culture chunk adds CULTURAL_MISUNDERSTANDING to surpriseTypes and SOCIAL_FAUX_PAS to encounterTypes', () => {
        const c = chunk({ category: 'culture', header: 'Customs', content: 'body' });
        const seed = extractEngineSeeds([c]);
        expect(seed.surpriseTypes).toEqual(['CULTURAL_MISUNDERSTANDING']);
        expect(seed.encounterTypes).toEqual(['SOCIAL_FAUX_PAS']);
    });
});

describe('extractEngineSeeds — explicit **Engine Seed Field:** lines (any category)', () => {
    it('**Surprise Types:** line splits on ,/ into surpriseTypes', () => {
        const c = chunk({ category: 'misc', header: 'X', content: '**Surprise Types:** WEATHER_SHIFT, ODD_SOUND / EERIE' });
        const seed = extractEngineSeeds([c]);
        expect(seed.surpriseTypes.sort()).toEqual(['EERIE', 'ODD_SOUND', 'WEATHER_SHIFT']);
    });
    it('**Encounter Tones:** line populates encounterTones', () => {
        const c = chunk({ category: 'misc', header: 'X', content: '**Encounter Tones:** TENSE, CHAOTIC' });
        expect(extractEngineSeeds([c]).encounterTones.sort()).toEqual(['CHAOTIC', 'TENSE']);
    });
    it('**World Event Who:** line populates worldWho', () => {
        const c = chunk({ category: 'misc', header: 'X', content: '**World Event Who:** a faction, a rogue group' });
        expect(extractEngineSeeds([c]).worldWho.sort()).toEqual(['a faction', 'a rogue group']);
    });
    it('**World Event What:** line populates worldWhat', () => {
        const c = chunk({ category: 'misc', header: 'X', content: '**World Event What:** declared war, formed alliance' });
        expect(extractEngineSeeds([c]).worldWhat.sort()).toEqual(['declared war', 'formed alliance']);
    });
    it('**World Event Where:** line populates worldWhere', () => {
        const c = chunk({ category: 'misc', header: 'X', content: '**World Event Where:** in the capital, across the border' });
        expect(extractEngineSeeds([c]).worldWhere.sort()).toEqual(['across the border', 'in the capital']);
    });
    it('**World Event Why:** line populates worldWhy', () => {
        const c = chunk({ category: 'misc', header: 'X', content: '**World Event Why:** for power, out of desperation' });
        expect(extractEngineSeeds([c]).worldWhy.sort()).toEqual(['for power', 'out of desperation']);
    });
    it('empty values after split are filtered out (filter(Boolean))', () => {
        const c = chunk({ category: 'misc', header: 'X', content: '**Surprise Types:** , , WEATHER_SHIFT ,' });
        expect(extractEngineSeeds([c]).surpriseTypes).toEqual(['WEATHER_SHIFT']);
    });
});

describe('extractEngineSeeds — dedup via Set across multiple chunks', () => {
    it('two faction chunks with the same header name produce only one worldWho entry', () => {
        const c1 = chunk({ id: 'a', category: 'faction', header: 'Guild', content: 'body' });
        const c2 = chunk({ id: 'b', category: 'faction', header: 'Guild', content: 'body' });
        expect(extractEngineSeeds([c1, c2]).worldWho).toEqual(['Guild']);
    });
    it('same tone from overview + explicit field is deduped', () => {
        const c1 = chunk({ category: 'world_overview', header: 'O', content: '**Tone:** DARK' });
        const c2 = chunk({ category: 'misc', header: 'X', content: '**Surprise Tones:** DARK' });
        const seed = extractEngineSeeds([c1, c2]);
        expect(seed.surpriseTones).toEqual(['DARK']);
    });
});

describe('extractEngineSeeds — field precedence / additive behavior', () => {
    it('a single faction chunk can contribute to WHO (header), WHY (motivation), and TYPES (none) at once', () => {
        const c = chunk({
            id: 'c1',
            category: 'faction',
            header: 'The Crimson Hand',
            content: '**Motivations:** profit\n**Key Members:** Alice',
        });
        const seed = extractEngineSeeds([c]);
        // worldWho: header "The Crimson Hand" + "Alice" (Key Members split on comma -> just "Alice")
        expect(seed.worldWho.sort()).toEqual(['Alice', 'The Crimson Hand']);
        // worldWhy: "driven by profit"
        expect(seed.worldWhy).toEqual(['driven by profit']);
    });
});