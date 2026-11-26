import { describe, it, expect } from 'vitest';
import {
    keywordMatches,
    makeScanTextGetter,
    fillByTokenBudget,
} from '../retrievalCore';
import type { ChatMessage } from '../../../types';

const msg = (role: 'user' | 'assistant', content: string): ChatMessage =>
    ({ role, content } as ChatMessage);

describe('retrievalCore — keywordMatches', () => {
    it('matches whole words case-insensitively', () => {
        expect(keywordMatches('Dragon', 'a DRAGON appears')).toBe(true);
        expect(keywordMatches('dragon', 'no beasts here')).toBe(false);
    });

    it('does not match substrings (word boundary)', () => {
        expect(keywordMatches('cat', 'concatenate')).toBe(false);
    });

    it('handles regex-special characters literally (no crash, escaped)', () => {
        // The keyword is escaped, so special chars are matched literally and never throw.
        // Note: the \b…\b anchoring means a keyword ending in a non-word char (e.g. "c++")
        // won't match when followed by whitespace — this asserts the safety, not word-boundary semantics.
        expect(() => keywordMatches('c++', 'I love c++ code')).not.toThrow();
        expect(() => keywordMatches('(', 'unbalanced (')).not.toThrow();
        expect(keywordMatches('a.b', 'value a.b here')).toBe(true); // '.' matched literally
        expect(keywordMatches('a.b', 'value axb here')).toBe(false); // not treated as regex wildcard
    });
});

describe('retrievalCore — makeScanTextGetter', () => {
    const history = [
        msg('user', 'First'),
        msg('assistant', 'Second SCENE'),
        msg('user', 'Third'),
    ];

    it('concatenates the last `depth` messages plus the user message, lowercased', () => {
        const get = makeScanTextGetter(history, 'Current QUESTION');
        const d1 = get(1);
        expect(d1).toBe('third current question');
    });

    it('includes all history when depth exceeds length', () => {
        const get = makeScanTextGetter(history, 'Q');
        const d10 = get(10);
        expect(d10).toContain('first');
        expect(d10).toContain('second scene');
        expect(d10).toContain('third');
        expect(d10.endsWith('q')).toBe(true);
    });

    it('memoizes per depth (same string instance returned)', () => {
        const get = makeScanTextGetter(history, 'Q');
        expect(get(2)).toBe(get(2));
    });
});

describe('retrievalCore — fillByTokenBudget', () => {
    type Item = { id: string; tokens: number };
    const items: Item[] = [
        { id: 'a', tokens: 30 },
        { id: 'b', tokens: 40 },
        { id: 'c', tokens: 50 },
    ];

    it('admits items in order until the budget is exhausted', () => {
        const results: Item[] = [];
        const includedSet = new Set<string>();
        const used = fillByTokenBudget(items, {
            idOf: i => i.id, tokensOf: i => i.tokens,
            budget: 80, usedTokens: 0, includedSet, results,
        });
        expect(results.map(r => r.id)).toEqual(['a', 'b']); // 30+40=70 fits, +50 would be 120
        expect(used).toBe(70);
    });

    it('skips items already in includedSet', () => {
        const results: Item[] = [];
        const includedSet = new Set<string>(['a']);
        fillByTokenBudget(items, {
            idOf: i => i.id, tokensOf: i => i.tokens,
            budget: 1000, usedTokens: 0, includedSet, results,
        });
        expect(results.map(r => r.id)).toEqual(['b', 'c']);
    });

    it('skips an oversized item but keeps filling with later items that fit', () => {
        const results: Item[] = [];
        const includedSet = new Set<string>();
        fillByTokenBudget(items, {
            idOf: i => i.id, tokensOf: i => i.tokens,
            budget: 35, usedTokens: 0, includedSet, results,
        });
        // a (30) fits; b (40) and c (50) don't.
        expect(results.map(r => r.id)).toEqual(['a']);
    });
});
