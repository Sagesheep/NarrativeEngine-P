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
    // ── Pass 1: [Name] and [**Name**] ──
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

    it('extracts names in [*Name*] format (single asterisks)', () => {
        const text = '[*Seraphine*] nodded.';
        const names = extractNPCNames(text);
        expect(names).toContain('Seraphine');
    });

    // ── Pass 2: [SYSTEM: NPC_ENTRY - Name] ──
    it('extracts names from SYSTEM NPC_ENTRY tags', () => {
        const text = '[SYSTEM: NPC_ENTRY - Orin] appeared at the gate';
        const names = extractNPCNames(text);
        expect(names).toContain('Orin');
    });

    it('extracts names from SYSTEM NPC_ENTRY with em dash', () => {
        const text = '[SYSTEM: NPC_ENTRY — Bram] stood by the door';
        const names = extractNPCNames(text);
        expect(names).toContain('Bram');
    });

    // ── Pass 3: Title-prefixed ──
    it('extracts title-prefixed names and strips the title', () => {
        const text = 'Captain Aldric said hello';
        const names = extractNPCNames(text);
        expect(names).toContain('Aldric');
    });

    it('extracts multi-word title-prefixed names', () => {
        const text = 'Instructor Roderick Vaul greeted the class';
        const names = extractNPCNames(text);
        expect(names).toContain('Roderick Vaul');
    });

    // ── Pass 4a: Name + speech verb ──
    it('extracts name before speech verb', () => {
        const text = 'Aldric said hello to the group';
        const names = extractNPCNames(text);
        expect(names).toContain('Aldric');
    });

    it('extracts name before whispered', () => {
        const text = 'Maren whispered the secret';
        const names = extractNPCNames(text);
        expect(names).toContain('Maren');
    });

    // ── Pass 4b: Speech verb + name ──
    it('extracts name after speech verb', () => {
        const text = 'said Aldric, the brave';
        const names = extractNPCNames(text);
        expect(names).toContain('Aldric');
    });

    it('extracts name after exclaimed', () => {
        const text = 'exclaimed Seraphine from the tower';
        const names = extractNPCNames(text);
        expect(names).toContain('Seraphine');
    });

    // ── Pass 5a: Role-apposition ──
    it('extracts names from "the merchant Orin" pattern', () => {
        const text = 'the merchant Orin entered the square';
        const names = extractNPCNames(text);
        expect(names).toContain('Orin');
    });

    it('extracts names from "an innkeeper Bram" pattern', () => {
        const text = 'An innkeeper Bram poured the ale';
        const names = extractNPCNames(text);
        expect(names).toContain('Bram');
    });

    // ── Pass 5b: Named/called ──
    it('extracts names from "named" introduction', () => {
        const text = 'a man named Bram approached the group';
        const names = extractNPCNames(text);
        expect(names).toContain('Bram');
    });

    it('extracts names from "called" introduction', () => {
        const text = 'She called Orin to join them';
        const names = extractNPCNames(text);
        expect(names).toContain('Orin');
    });

    // ── Pass 6: Connective ──
    it('extracts connective names like "Aldric of Westhold"', () => {
        const text = 'Aldric of Westhold arrived at the gate';
        const names = extractNPCNames(text);
        expect(names).toContain('Aldric of Westhold');
    });

    it('extracts connective names like "Elara von Mire"', () => {
        const text = 'Elara von Mire rode through the valley';
        const names = extractNPCNames(text);
        expect(names).toContain('Elara von Mire');
    });

    // ── Pass 7 deliberately omitted ──
    it('does NOT extract two capitalized tokens without structural cue (Pass 7 omitted)', () => {
        const text = 'Iron Gate stands before you';
        const names = extractNPCNames(text);
        expect(names).not.toContain('Iron Gate');
    });

    it('does NOT extract "North Bridge" as a name', () => {
        const text = 'They crossed North Bridge at dawn';
        const names = extractNPCNames(text);
        expect(names).not.toContain('North Bridge');
    });

    // ── Blocklist / filter tests ──
    it('filters out blocklisted words like "Not" and "But" at sentence start', () => {
        const text = 'Not But are the problem here';
        const names = extractNPCNames(text);
        expect(names).not.toContain('Not');
        expect(names).not.toContain('But');
    });

    it('filters out structural words — "Great Hall" not a name', () => {
        const text = 'They entered the Great Hall together';
        const names = extractNPCNames(text);
        expect(names).not.toContain('Great Hall');
    });

    it('filters out contractions — "Maren\'s" not a name', () => {
        const text = "Maren's sword gleamed in the light.";
        const names = extractNPCNames(text);
        expect(names).not.toContain("Maren's");
    });

    it('filters out generic roles like "Guard #3"', () => {
        const text = 'Guard #3 stood at the post';
        const names = extractNPCNames(text);
        expect(names).not.toContain('Guard #3');
    });

    it('strips title from "Captain Aldric" producing "Aldric"', () => {
        const text = 'Captain Aldric said hello';
        const names = extractNPCNames(text);
        expect(names).toContain('Aldric');
        expect(names).not.toContain('Captain Aldric');
    });

    it('deduplicates repeated names across passes', () => {
        const text = '[**Aldric**] said hello. Captain Aldric nodded.';
        const names = extractNPCNames(text);
        expect(names.filter(n => n === 'Aldric').length).toBe(1);
    });

    it('returns empty array for empty string', () => {
        expect(extractNPCNames('')).toEqual([]);
    });

    it('caps at 15 names', () => {
        const many = Array.from({ length: 20 }, (_, i) => `[**Npc${i}**]`).join(' ');
        expect(extractNPCNames(many).length).toBeLessThanOrEqual(15);
    });

    it('respects custom maxNames parameter', () => {
        const many = Array.from({ length: 10 }, (_, i) => `[**Npc${i}**]`).join(' ');
        expect(extractNPCNames(many, 5).length).toBeLessThanOrEqual(5);
    });

    it('precision-order: bracket names fill before non-bracket names when capped', () => {
        const bracketNames = Array.from({ length: 12 }, (_, i) => `[**BracketNpc${i}**]`).join(' ');
        const extraText = 'Captain Alpha said hello. Captain Beta said goodbye.';
        const text = bracketNames + ' ' + extraText;
        const names = extractNPCNames(text, 13);
        const bracketCount = names.filter(n => n.startsWith('BracketNpc')).length;
        expect(bracketCount).toBe(12);
        expect(names.length).toBeLessThanOrEqual(13);
    });

    // ── Downstream safety ──
    it('names from non-bracket passes appear in extractNPCNames output', () => {
        const text = 'Captain Aldric said hello. The merchant Orin arrived.';
        const names = extractNPCNames(text);
        expect(names).toContain('Aldric');
        expect(names).toContain('Orin');
    });

    it('multi-word names like "Roderick Vaul" are extracted intact', () => {
        const text = 'Instructor Roderick Vaul greeted the class';
        const names = extractNPCNames(text);
        expect(names).toContain('Roderick Vaul');
    });

    // ── Phase 4 parity: excludeNames param ──
    it('excludes a name when given an excludeNames list', () => {
        const text = '[**Aldric**] nodded. [**Maren**] smiled.';
        const names = extractNPCNames(text, 15, ['Aldric']);
        expect(names).not.toContain('Aldric');
        expect(names).toContain('Maren');
    });

    it('excludeNames is case-insensitive', () => {
        const text = '[**Seraphine**] entered the room.';
        const names = extractNPCNames(text, 15, ['SERAPHINE']);
        expect(names).not.toContain('Seraphine');
    });

    // ── Phase 4 parity: structural words still rejected after STRUCTURAL_WORDS dedup ──
    it('structural word "Gate" still rejected by blocklist after dedup', () => {
        const text = '[**Iron Gate**] stood firm.';
        const names = extractNPCNames(text);
        // "Iron Gate" has a blocklisted token ("gate") — should be filtered
        expect(names).not.toContain('Iron Gate');
    });

    it('structural word "Hall" still rejected by blocklist after dedup', () => {
        const text = 'Captain Great Hall said hello.';
        const names = extractNPCNames(text);
        expect(names).not.toContain('Great Hall');
    });

    // ── Phase 4 parity: smoke test ──
    it('smoke: Seraphine Thornmere admitted; Iron Gate and Chapter Two rejected', () => {
        // Server has no Pass 7, so Seraphine Thornmere only appears via earlier passes.
        // Use a bracket format to ensure she's captured.
        const text = '[**Seraphine Thornmere**] stepped through Iron Gate. Chapter Two begins.';
        const names = extractNPCNames(text);
        expect(names).toContain('Seraphine Thornmere');
        expect(names).not.toContain('Iron Gate');
        expect(names).not.toContain('Chapter Two');
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

    it('handles multi-word names from new passes', () => {
        const text = 'Roderick Vaul was killed by the dragon';
        const s = extractNPCStrengths(text, ['Roderick Vaul']);
        expect(s['Roderick Vaul']).toBe(1.0);
    });

    it('computes mention-based strength for multi-word names', () => {
        const text = 'Roderick Vaul entered the hall. Roderick Vaul nodded. Roderick Vaul smiled.';
        const s = extractNPCStrengths(text, ['Roderick Vaul']);
        expect(s['Roderick Vaul']).toBeGreaterThanOrEqual(0.7);
    });

    // Names come from the model's prose, so they can hold regex metacharacters.
    // Built into a pattern unescaped, these threw inside the scene append path
    // (leaving prose on disk with no index entry) or matched the wrong text.
    it('does not throw on names containing regex metacharacters', () => {
        const text = 'The crowd parted. Nobody moved.';
        for (const name of ['C++ Bot', 'Smith (the Elder', 'Who?', '[Redacted]', 'A*Star', 'Ven|ra']) {
            expect(() => extractNPCStrengths(text, [name]), name).not.toThrow();
        }
    });

    it('matches a name with metacharacters literally', () => {
        const s = extractNPCStrengths('Smith (the Elder) was killed at dawn', ['Smith (the Elder)']);
        expect(s['Smith (the Elder)']).toBe(1.0);
    });

    it('does not treat a dot in a name as a wildcard', () => {
        // Unescaped, the dot in "mr. vale" matches any character, so a
        // different person, "mrx vale", was scored as Mr. Vale's death.
        const s = extractNPCStrengths('mrx vale was killed', ['Mr. Vale']);
        expect(s['Mr. Vale']).toBe(0);
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

    it('classifies non-bracket names as mentioned (not witnesses)', () => {
        const assistantText = 'Captain Aldric said hello to the group.';
        const { witnesses, mentioned } = extractWitnessesHeuristic(['Aldric'], '', assistantText);
        expect(mentioned).toContain('Aldric');
        expect(witnesses).not.toContain('Aldric');
    });

    it('bracket names with dialogue are witnesses, speech-verb names are mentioned', () => {
        const assistantText = '[**Maren**] whispered a secret. Captain Aldric said hello.';
        const { witnesses, mentioned } = extractWitnessesHeuristic(['Maren', 'Aldric'], '', assistantText);
        expect(witnesses).toContain('Maren');
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

    it('handles connective names like "Aldric of Westhold" in timeline', () => {
        const text = 'Aldric of Westhold died in the battle';
        const events = extractTimelineEventsRegex(['Aldric of Westhold'], text, '001', 'CH01');
        expect(events.some(e => e.subject === 'Aldric of Westhold')).toBe(true);
    });

    it('does not produce spurious events for non-matching multi-word names', () => {
        const text = 'Roderick Vaul walked through the marketplace';
        const events = extractTimelineEventsRegex(['Roderick Vaul'], text, '001', 'CH01');
        expect(events).toEqual([]);
    });

    it('handles names containing regex metacharacters (e.g. ".", "(", "-)", without throwing or mis-matching', () => {
        // Names with regex metacharacters must be escaped before building patterns.
        // Without escaping, "Dr. Moriarty" would match any "Dr<任意字符> Moriarty".
        const text = 'Dr. Moriarty entered the Crypt';
        const events = extractTimelineEventsRegex(['Dr. Moriarty'], text, '001', 'CH01');
        expect(events.some(e => e.subject === 'Dr. Moriarty' && e.predicate === 'located_in')).toBe(true);
    });

    it('does not treat a name with a metachar as a wildcard that matches unrelated text', () => {
        // Without escaping, "Kor'vak" containing no metachar is fine, but "Kor(vak)"
        // would treat "(" as a group start and throw or mis-match.
        const text = 'Kor(vak) died in the arena';
        const events = extractTimelineEventsRegex(['Kor(vak)'], text, '001', 'CH01');
        expect(events.some(e => e.subject === 'Kor(vak)' && e.predicate === 'status' && e.object === 'dead')).toBe(true);
    });
});
