import { describe, it, expect } from 'vitest';
import {
    ONE_SHOT_EVENT_TYPES,
    buildOneShotDirective,
    type OneShotEventId,
} from '../oneShotEvents';

// Behavior lock for the One-Shot Event Injector v1 (WORKORDER-oneshot-injector.md).
// Style follows rollsBehaviorLock.test.ts: exact-string where cheap, structural
// elsewhere. The shared introduction rules are kept as a single constant in the
// source, so test-3's byte-identity lock should hold by construction — but we
// assert it anyway to freeze that contract.

const IDS: OneShotEventId[] = [
    'combat', 'location', 'social', 'romance', 'mystery', 'weird', 'windfall',
];

describe('behavior lock: oneShotEvents — registry integrity', () => {
    it('has exactly 7 entries', () => {
        expect(ONE_SHOT_EVENT_TYPES).toHaveLength(7);
    });

    it('ids are unique and match the OneShotEventId union', () => {
        const ids = ONE_SHOT_EVENT_TYPES.map(t => t.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids.sort()).toEqual([...IDS].sort());
    });

    it('every entry has non-empty label, blurb, and directive', () => {
        for (const t of ONE_SHOT_EVENT_TYPES) {
            expect(t.label.length).toBeGreaterThan(0);
            expect(t.blurb.length).toBeGreaterThan(0);
            expect(t.directive.length).toBeGreaterThan(0);
        }
    });
});

describe('behavior lock: oneShotEvents — buildOneShotDirective per id', () => {
    for (const id of IDS) {
        it(`${id}: starts with \\n[INJECTED EVENT — <LABEL UPPERCASE>, contains its directive, the shared rules, and ends with ]`, () => {
            const type = ONE_SHOT_EVENT_TYPES.find(t => t.id === id)!;
            const out = buildOneShotDirective(id);

            // Leading \n, matching the loot tag convention.
            expect(out.startsWith('\n[INJECTED EVENT — ')).toBe(true);

            // The label is uppercased in the header.
            expect(out.startsWith(`\n[INJECTED EVENT — ${type.label.toUpperCase()}.`)).toBe(true);

            // The type-specific directive text is present.
            expect(out).toContain(type.directive);

            // The shared introduction rules anchor is present.
            expect(out).toContain('INTRODUCTION RULES — binding:');

            // Ends with the closing bracket.
            expect(out.endsWith(']')).toBe(true);
        });
    }
});

describe('behavior lock: oneShotEvents — shared rules byte-identity', () => {
    it('the INTRODUCTION RULES block is byte-identical across all 7 outputs', () => {
        const slices: string[] = [];
        for (const id of IDS) {
            const out = buildOneShotDirective(id);
            const start = out.indexOf('INTRODUCTION RULES');
            expect(start).toBeGreaterThan(-1);
            // From the shared-rules anchor to the final closing bracket.
            slices.push(out.slice(start));
        }
        // All seven shared-rule substrings must be equal.
        const first = slices[0];
        for (const s of slices) {
            expect(s).toBe(first);
        }
        // And that shared block must be non-trivial (not empty, not just "]").
        expect(first.length).toBeGreaterThan('INTRODUCTION RULES'.length + 10);
    });
});

describe('behavior lock: oneShotEvents — unknown id', () => {
    it('returns "" for an unknown id (defensive)', () => {
        const unknown = 'totally-not-a-real-id' as unknown as OneShotEventId;
        expect(buildOneShotDirective(unknown)).toBe('');
    });
});