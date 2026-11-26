import { describe, it, expect, beforeEach } from 'vitest';
import { countTokens, __resetTokenCacheForTests } from '../tokenizer';

/**
 * `countTokens` is on the per-turn payload path: the payload builder re-counts
 * the whole unchanged history window every turn, and `trimToBudget` binary
 * searches by re-counting prefixes of the same block. The memo must be
 * invisible to callers — same input, same answer, always.
 */

beforeEach(() => {
    __resetTokenCacheForTests();
});

describe('countTokens', () => {
    it('returns 0 for empty input', () => {
        expect(countTokens('')).toBe(0);
    });

    it('counts a known string', () => {
        // cl100k_base: each of these short words is a single token.
        expect(countTokens('hello')).toBe(1);
        expect(countTokens('hello world')).toBe(2);
    });

    it('returns the same answer on a repeat call', () => {
        const text = 'The bridge burned before anyone reached the far bank.';
        const first = countTokens(text);
        expect(countTokens(text)).toBe(first);
        expect(countTokens(text)).toBe(first);
    });

    it('agrees with itself across a cache reset', () => {
        const text = 'A worn sword; a healing draught.';
        const cached = countTokens(text);
        __resetTokenCacheForTests();
        expect(countTokens(text)).toBe(cached);
    });

    it('distinguishes different strings', () => {
        const a = countTokens('one');
        const b = countTokens('one two three four five six seven');
        expect(b).toBeGreaterThan(a);
    });

    it('is monotonic over prefixes, which is what trimToBudget relies on', () => {
        const block = 'word '.repeat(200);
        let previous = 0;
        for (const end of [50, 200, 400, 800, 1000]) {
            const count = countTokens(block.slice(0, end));
            expect(count).toBeGreaterThanOrEqual(previous);
            previous = count;
        }
    });

    it('stays correct past the cache capacity', () => {
        // More distinct strings than the cache holds, so entries are evicted
        // while the run is in progress. Eviction must not change any answer.
        const sample = 'eviction probe 1234';
        const expected = countTokens(sample);
        for (let i = 0; i < 2500; i++) countTokens(`filler string number ${i}`);
        expect(countTokens(sample)).toBe(expected);
    });

    it('is faster on a repeated window than on a cold one', () => {
        const history = Array.from({ length: 60 }, (_, i) =>
            `${'the quick brown fox jumps over a lazy dog '.repeat(20)} [${i}]`);

        const coldStart = performance.now();
        for (const m of history) countTokens(m);
        const cold = performance.now() - coldStart;

        const warmStart = performance.now();
        for (const m of history) countTokens(m);
        const warm = performance.now() - warmStart;

        // The whole point of the memo: a turn that re-counts an unchanged
        // window does no BPE work at all. Generous margin so this is not
        // flaky on a loaded machine.
        expect(warm).toBeLessThan(cold);
    });
});
