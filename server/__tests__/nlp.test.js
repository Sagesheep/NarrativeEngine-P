import { describe, it, expect } from 'vitest';
import {
    extractIndexKeywords,
    extractNPCNames,
    estimateImportance,
    extractKeywordStrengths,
    extractNPCStrengths,
    extractWitnessesHeuristic,
    extractTimelineEventsRegex,
} from '../lib/nlp.js';

// ─── extractIndexKeywords ───────────────────────────────────────────────────

describe('extractIndexKeywords', () => {
    it('returns lowercase unique keywords from rich text', () => {
        const text = 'Aldric entered the Shadowkeep and faced Morrigan the Archmage';
        const kw = extractIndexKeywords(text);
        expect(kw).toContain('aldric');
        expect(kw).toContain('shadowkeep');
        expect(kw).toContain('morrigan');
    });

    it('filters stopwords like "The", "And", "For"', () => {
        const text = 'The king went And the queen followed For the throne';
        const kw = extractIndexKeywords(text);
        expect(kw).not.toContain('the');
        expect(kw).not.toContain('and');
        expect(kw).not.toContain('for');
    });

    it('extracts quoted strings', () => {
        const text = '"I will return to Stonehaven" said the warrior';
        const kw = extractIndexKeywords(text);
        expect(kw).toContain('i will return to stonehaven');
    });

    it('extracts [MEMORABLE: "..."] tags', () => {
        const text = '[MEMORABLE: "The betrayal at Irongate"] changed everything';
        const kw = extractIndexKeywords(text);
        expect(kw).toContain('the betrayal at irongate');
    });

    it('returns empty array for empty string', () => {
        expect(extractIndexKeywords('')).toEqual([]);
    });

    it('caps at 20 keywords', () => {
        const text = 'Alpha Beta Charlie Delta Echo Foxtrot Golf Hotel India Juliet ' +
            'Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango Uniform Victor';
        const kw = extractIndexKeywords(text);
        expect(kw.length).toBeLessThanOrEqual(20);
    });
});

// ─── extractNPCNames ────────────────────────────────────────────────────────

describe('extractNPCNames', () => {
    it('extracts names in [**Name**] format', () => {
        const text = '[**Aldric**] spoke first, then [**Morrigan**] replied';
        const names = extractNPCNames(text);
        expect(names).toContain('Aldric');
        expect(names).toContain('Morrigan');
    });

    it('extracts names in [Name] format (no asterisks)', () => {
        const text = '[Borric] watched from the shadows';
        const names = extractNPCNames(text);
        expect(names).toContain('Borric');
    });

    it('returns empty array when no names found', () => {
        const text = 'You walk through the empty corridor';
        expect(extractNPCNames(text)).toEqual([]);
    });

    it('deduplicates repeated names', () => {
        const text = '[**Aldric**] attacked. [**Aldric**] retreated.';
        const names = extractNPCNames(text);
        expect(names.filter(n => n === 'Aldric').length).toBe(1);
    });

    it('caps at 15 names', () => {
        const many = Array.from({ length: 20 }, (_, i) => `[**Npc${i}**]`).join(' ');
        expect(extractNPCNames(many).length).toBeLessThanOrEqual(15);
    });
});

// ─── estimateImportance ─────────────────────────────────────────────────────

describe('estimateImportance', () => {
    it('returns base score 3 for mundane text', () => {
        const score = estimateImportance('The party walked into town and bought supplies');
        expect(score).toBe(3);
    });

    it('adds 3 for death/combat keywords', () => {
        const score = estimateImportance('The bandit was killed by the guards');
        expect(score).toBeGreaterThanOrEqual(6);
    });

    it('adds 2 for [MEMORABLE: tag', () => {
        const score = estimateImportance('[MEMORABLE: "Key revelation"] occurred');
        expect(score).toBeGreaterThanOrEqual(5);
    });

    it('caps at 10', () => {
        // base(3) + death(3) + memorable(2) + noble(1) + quest(1) = 10
        const text = 'The king was killed [MEMORABLE: "death"] in pursuit of the quest';
        expect(estimateImportance(text)).toBe(10);
    });
});

// ─── extractKeywordStrengths ────────────────────────────────────────────────

describe('extractKeywordStrengths', () => {
    it('returns strengths between 0 and 1 for each keyword', () => {
        const text = 'Aldric fought Aldric fought Aldric won';
        const strengths = extractKeywordStrengths(text, ['aldric']);
        expect(strengths['aldric']).toBeGreaterThan(0);
        expect(strengths['aldric']).toBeLessThanOrEqual(1);
    });

    it('assigns higher strength for 3+ occurrences', () => {
        const text = 'dragon dragon dragon';
        const one = extractKeywordStrengths('dragon', ['dragon'])['dragon'];
        const three = extractKeywordStrengths(text, ['dragon'])['dragon'];
        expect(three).toBeGreaterThan(one);
    });

    it('returns empty object for empty keyword list', () => {
        expect(extractKeywordStrengths('some text', [])).toEqual({});
    });
});

// ─── extractNPCStrengths ────────────────────────────────────────────────────

describe('extractNPCStrengths', () => {
    it('assigns 1.0 for NPC death as subject', () => {
        const text = 'Aldric was killed by the dragon';
        const s = extractNPCStrengths(text, ['Aldric']);
        expect(s['Aldric']).toBe(1.0);
    });

    it('assigns 1.0 for NPC death as object (killed by)', () => {
        const text = 'The guards killed Morrigan';
        const s = extractNPCStrengths(text, ['Morrigan']);
        expect(s['Morrigan']).toBe(1.0);
    });

    it('assigns lower strength for simple mentions', () => {
        const text = 'Borric is somewhere in the city';
        const s = extractNPCStrengths(text, ['Borric']);
        expect(s['Borric']).toBeGreaterThan(0);
        expect(s['Borric']).toBeLessThan(1.0);
    });

    it('returns 0 for NPC not mentioned', () => {
        const text = 'The town is quiet tonight';
        const s = extractNPCStrengths(text, ['Aldric']);
        expect(s['Aldric']).toBe(0);
    });
});

// ─── extractWitnessesHeuristic ──────────────────────────────────────────────

describe('extractWitnessesHeuristic', () => {
    it('classifies NPCs with dialogue as witnesses', () => {
        const assistantText = '[**Aldric**] "I am ready to fight"';
        const { witnesses, mentioned } = extractWitnessesHeuristic(['Aldric', 'Borric'], '', assistantText);
        expect(witnesses).toContain('Aldric');
    });

    it('classifies NPCs addressed by user as witnesses', () => {
        const userText = 'talk to Morrigan about the quest';
        const { witnesses } = extractWitnessesHeuristic(['Morrigan'], userText, '');
        expect(witnesses).toContain('Morrigan');
    });

    it('puts non-active NPCs in mentioned list', () => {
        const assistantText = 'The distant lands of Farenholm are mentioned in lore';
        const { mentioned } = extractWitnessesHeuristic(['Aldric'], '', assistantText);
        expect(mentioned).toContain('Aldric');
    });
});

// ─── extractTimelineEventsRegex ─────────────────────────────────────────────

describe('extractTimelineEventsRegex', () => {
    it('extracts killed_by events', () => {
        const text = 'The guards killed Morrigan in the courtyard';
        const events = extractTimelineEventsRegex(['Morrigan'], text, '001', 'CH01');
        expect(events.some(e => e.predicate === 'killed_by' && e.subject === 'Morrigan')).toBe(true);
    });

    it('extracts located_in events', () => {
        const text = 'Aldric entered the Shadowkeep';
        const events = extractTimelineEventsRegex(['Aldric'], text, '001', 'CH01');
        expect(events.some(e => e.predicate === 'located_in' && e.subject === 'Aldric')).toBe(true);
    });

    it('returns empty array when no matching patterns', () => {
        const text = 'The clouds are gray today';
        const events = extractTimelineEventsRegex([], text, '001', 'CH01');
        expect(events).toEqual([]);
    });

    it('populates sceneId and chapterId correctly', () => {
        const text = 'Borric entered the Dungeon';
        const events = extractTimelineEventsRegex(['Borric'], text, '042', 'CH03');
        if (events.length > 0) {
            expect(events[0].sceneId).toBe('042');
            expect(events[0].chapterId).toBe('CH03');
        }
    });
});
