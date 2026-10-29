import { describe, it, expect } from 'vitest';
import {
    scoreEntry,
    extractContextActivations,
    expandActivationsWithFacts,
    applyEventBoost,
} from '../scoring';
import type { ArchiveIndexEntry, ChatMessage, NPCEntry, SceneEvent } from '../../../types';

// ─────────────────────────────────────────────────────────────────────────────
// EXEMPLAR test (Refactor 19-06 Plan 04, wave 1). This file sets the QUALITY BAR
// for the other pure-logic test files GLM writes: assert EXACT numeric outcomes
// and cover each branch — never `toBeDefined()` tautologies. Every magic number
// below is derived by hand from scoring.ts so a logic change fails loudly.
// ─────────────────────────────────────────────────────────────────────────────

const entry = (over: Partial<ArchiveIndexEntry>): ArchiveIndexEntry => ({
    sceneId: '1',
    keywords: [],
    npcsMentioned: [],
    keywordStrengths: {},
    npcStrengths: {},
    ...over,
} as ArchiveIndexEntry);

const asst = (content: string): ChatMessage => ({ role: 'assistant', content } as ChatMessage);
const user = (content: string): ChatMessage => ({ role: 'user', content } as ChatMessage);

describe('scoreEntry — activation (strength-matrix path)', () => {
    it('keywordRelevance = 2 × (activation·strength·idf)', () => {
        // activation = 1.0(act) × 2(strength) × 3(idf) = 6 ; relevance = 2.0 × 6 = 12
        const r = scoreEntry(entry({ keywordStrengths: { dragon: 2 } }), '', { dragon: 1.0 }, 1, { dragon: 3 });
        expect(r.keywordRelevance).toBe(12);
    });

    it('npcStrengths carry the ×1.5 weight and idf defaults to 1', () => {
        // activation = 1.0 × 1 × 1.5 × 1 = 1.5 ; relevance = 3.0
        const r = scoreEntry(entry({ npcStrengths: { malachar: 1 } }), '', { malachar: 1.0 }, 1, {});
        expect(r.keywordRelevance).toBe(3);
    });

    it('importance defaults to 5 and recency decays with age', () => {
        const recent = scoreEntry(entry({ sceneId: '10' }), '', {}, 10, {}); // turnsSince 0 → recency 1
        const old = scoreEntry(entry({ sceneId: '1' }), '', {}, 10, {});     // turnsSince 9
        expect(recent.importance).toBe(5);
        expect(recent.recency).toBe(1);
        expect(recent.recency).toBeGreaterThan(old.recency);
        expect(old.recency).toBeGreaterThan(0); // logarithmic, never zero
    });

    it('honors an explicit importance value', () => {
        expect(scoreEntry(entry({ importance: 9 }), '', {}, 1, {}).importance).toBe(9);
    });
});

describe('scoreEntry — legacy fallback (no strength matrices)', () => {
    it('exact keyword match scores 2×idf and mentioned NPC scores 3×idf', () => {
        // 'dragon' word-boundary match → 2×1 ; 'aldric' mention → 3×1 ; activation 5 ; relevance 10
        const r = scoreEntry(
            entry({ keywords: ['Dragon'], npcsMentioned: ['Aldric'] }),
            'the dragon and aldric appear', {}, 1, {},
        );
        expect(r.keywordRelevance).toBe(10);
    });
});

describe('scoreEntry — POV-aware boost/penalty', () => {
    // Pre-POV relevance is fixed at 4 = 2.0 × (1.0 act × 2 strength × 1 idf), so each
    // case below isolates only the POV multiplier.
    const ctx = { dragon: 1.0 };
    const idf = { dragon: 1 };
    const povEntry = (over: Partial<ArchiveIndexEntry>) =>
        entry({ keywordStrengths: { dragon: 2 }, ...over });

    it('witness ×1.5', () => {
        const r = scoreEntry(povEntry({ witnesses: ['Aldric'] }), '', ctx, 1, idf, 'aldric');
        expect(r.keywordRelevance).toBe(6); // 4 × 1.5
    });

    it('mentioned-but-not-witness ×0.8', () => {
        const r = scoreEntry(povEntry({ npcsMentioned: ['Aldric'] }), '', ctx, 1, idf, 'aldric');
        expect(r.keywordRelevance).toBeCloseTo(3.2); // 4 × 0.8
    });

    it('outsider when other witnesses exist ×0.3', () => {
        const r = scoreEntry(povEntry({ witnesses: ['Bob'] }), '', ctx, 1, idf, 'aldric');
        expect(r.keywordRelevance).toBeCloseTo(1.2); // 4 × 0.3
    });

    it('no POV adjustment when relevance is 0', () => {
        const r = scoreEntry(entry({ witnesses: ['Bob'] }), '', {}, 1, {}, 'aldric');
        expect(r.keywordRelevance).toBe(0);
    });
});

describe('extractContextActivations — tiered weights', () => {
    it('user words/proper-nouns = 1.0; assistant fill = 0.7 without downgrading', () => {
        const a = extractContextActivations('dragon', [asst('dragon castle')]);
        expect(a['dragon']).toBe(1.0);  // user wins, not downgraded by assistant 0.7
        expect(a['castle']).toBe(0.7);
    });

    it('older messages fill at 0.3', () => {
        const a = extractContextActivations('hello', [user('faraway')]);
        expect(a['hello']).toBe(1.0);
        expect(a['faraway']).toBe(0.3);
    });

    it('ignores sub-2-char tokens', () => {
        const a = extractContextActivations('a go', []);
        expect(a['a']).toBeUndefined();
        expect(a['go']).toBe(1.0);
    });

    it('npc ledger names and comma-split aliases all activate at 1.0', () => {
        const ledger = [{ name: 'Malachar', aliases: 'The Dark One, Mal' }] as NPCEntry[];
        const a = extractContextActivations('hi', [], ledger);
        expect(a['malachar']).toBe(1.0);
        expect(a['the dark one']).toBe(1.0);
        expect(a['mal']).toBe(1.0);
    });
});

describe('expandActivationsWithFacts', () => {
    it('returns input unchanged when there are no facts', () => {
        const a = { malachar: 1.0 };
        expect(expandActivationsWithFacts(a)).toBe(a);
    });

    it('1-hop activates the connected entity at half weight', () => {
        const out = expandActivationsWithFacts(
            { malachar: 1.0 },
            [{ subject: 'x', predicate: 'killed_by', object: 'Malachar', importance: 5 }],
        );
        expect(out['x']).toBe(0.5);
        expect(out['malachar']).toBe(1.0);
    });

    it('chains across a 2-hop path (a→b→c)', () => {
        const out = expandActivationsWithFacts(
            { a: 1.0 },
            [
                { subject: 'a', predicate: 'r', object: 'b', importance: 5 },
                { subject: 'b', predicate: 'r', object: 'c', importance: 5 },
            ],
        );
        expect(out['b']).toBe(0.5);
        expect(out['c']).toBe(0.25);
    });
});

describe('applyEventBoost', () => {
    it('sums importance(≥7)=+1.5, character match=+1.0, location match=+1.0', () => {
        const boost = applyEventBoost(
            [entry({ sceneId: 's1', events: [{ importance: 8, characters: ['Aldric'], locations: ['Harbor'] } as unknown as SceneEvent] }) as ArchiveIndexEntry],
            'aldric at the harbor', [],
        );
        expect(boost.get('s1')).toBe(3.5);
    });

    it('omits entries that earn no bonus', () => {
        const boost = applyEventBoost(
            [
                entry({ sceneId: 'none', events: [] }) as ArchiveIndexEntry,
                entry({ sceneId: 'low', events: [{ importance: 3, characters: ['Nobody'], locations: [] } as unknown as SceneEvent] }) as ArchiveIndexEntry,
            ],
            'unrelated text', [],
        );
        expect(boost.has('none')).toBe(false);
        expect(boost.has('low')).toBe(false);
    });
});
