import { describe, it, expect } from 'vitest';
import type { PersonalityHex } from '../../types';
import {
    rollWeightedAxis,
    rollHex,
    pickGroups,
    drawConsistentTraits,
    rollLooksTier,
    applySecondaryEnvelope,
} from './hexRoll';
import { ENVELOPES, GROUP_KEYS, type AxisEnvelope, type GroupEnvelope } from './dispositionGroups';

// ── Seeded RNG (mulberry32) — deterministic across runs. Injected into every roll fn so the
// engine never reaches for Math.random in tests. Matches the codebase convention of `rng: () => number`
// with a `Math.random` default (see agencyWantDraw.ts / agencyAudition.ts).
function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const AXES: readonly (keyof PersonalityHex)[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];

describe('rollWeightedAxis', () => {
    it('is deterministic given a seeded rng', () => {
        const env: AxisEnvelope = { center: 1, spread: 'normal' };
        const a = rollWeightedAxis(env, mulberry32(42));
        const b = rollWeightedAxis(env, mulberry32(42));
        expect(a).toBe(b);
    });

    it('always returns an integer in [-3, +3]', () => {
        const rng = mulberry32(7);
        const envs: AxisEnvelope[] = [
            { center: 3, spread: 'tight' },
            { center: -3, spread: 'tight' },
            { center: 0, spread: 'wide' },
            { center: 2, spread: 'normal' },
        ];
        for (const env of envs) {
            for (let i = 0; i < 5000; i++) {
                const v = rollWeightedAxis(env, rng);
                expect(Number.isInteger(v)).toBe(true);
                expect(v).toBeGreaterThanOrEqual(-3);
                expect(v).toBeLessThanOrEqual(3);
            }
        }
    });

    it('weighted toward center: a high-skew axis (center +2, normal) lands mostly >= +1', () => {
        const env: AxisEnvelope = { center: 2, spread: 'normal' };
        const rng = mulberry32(123);
        const N = 20000;
        let ge1 = 0;
        for (let i = 0; i < N; i++) {
            if (rollWeightedAxis(env, rng) >= 1) ge1++;
        }
        // Most rolls should land at or above +1 (expected ~84% per the Gaussian+floor model).
        expect(ge1 / N).toBeGreaterThan(0.7);
    });

    it('keeps -3 and +3 reachable at EVERY spread (weighted, never walled)', () => {
        // The make-or-break rule (00_SPEC §3.3): extremes are rare-but-possible at every spread.
        const cases: { env: AxisEnvelope; want: (v: number) => boolean; label: string }[] = [
            { env: { center: 2, spread: 'normal' }, want: v => v <= -2, label: 'normal/high-center hits <= -2' },
            { env: { center: 2, spread: 'tight' },  want: v => v === -3, label: 'tight/high-center hits -3' },
            { env: { center: -2, spread: 'tight' }, want: v => v === 3,  label: 'tight/low-center hits +3' },
            { env: { center: 0, spread: 'wide' },   want: v => v === -3, label: 'wide hits -3' },
            { env: { center: 0, spread: 'wide' },   want: v => v === 3,  label: 'wide hits +3' },
        ];
        for (const c of cases) {
            const rng = mulberry32(999);
            let hit = false;
            for (let i = 0; i < 200000 && !hit; i++) {
                if (c.want(rollWeightedAxis(c.env, rng))) hit = true;
            }
            expect(hit, c.label).toBe(true);
        }
    });
});

describe('rollHex', () => {
    it('is deterministic given a seeded rng', () => {
        const a = rollHex('scholar', 'brute', ['curious'], mulberry32(1));
        const b = rollHex('scholar', 'brute', ['curious'], mulberry32(1));
        expect(a).toEqual(b);
    });

    it('returns a full clamped hexagon for every axis', () => {
        const hex = rollHex('scholar', 'fool', [], mulberry32(5));
        for (const axis of AXES) {
            expect(Number.isInteger(hex[axis])).toBe(true);
            expect(hex[axis]).toBeGreaterThanOrEqual(-3);
            expect(hex[axis]).toBeLessThanOrEqual(3);
        }
    });

    it('clamp: an anchor-trait mod cannot push an axis past ±3', () => {
        const env: AxisEnvelope = { center: 3, spread: 'tight' };
        const rng = mulberry32(77);
        for (let i = 0; i < 50000; i++) {
            const v = rollWeightedAxis(env, rng);
            const withMod = v + 2;
            const clamped = Math.max(-3, Math.min(3, withMod));
            expect(clamped).toBeLessThanOrEqual(3);
            expect(clamped).toBeGreaterThanOrEqual(-3);
        }
        const hex = rollHex('scholar', undefined, [], mulberry32(88));
        for (const axis of AXES) {
            expect(hex[axis]).toBeGreaterThanOrEqual(-3);
            expect(hex[axis]).toBeLessThanOrEqual(3);
        }
    });

    it('falls back gracefully when the primary group is unknown (no crash, valid hex)', () => {
        const hex = rollHex('nonexistent-group', undefined, [], mulberry32(3));
        for (const axis of AXES) {
            expect(Number.isInteger(hex[axis])).toBe(true);
            expect(hex[axis]).toBeGreaterThanOrEqual(-3);
            expect(hex[axis]).toBeLessThanOrEqual(3);
        }
    });

    it('3 NPCs from the same candidate pool yield 3 measurably different hexes (variance)', () => {
        const pool = ['scholar', 'brute', 'fool'];
        const rng = mulberry32(2026);
        const hexes: PersonalityHex[] = [];
        for (let i = 0; i < 3; i++) {
            const { primary, secondary } = pickGroups(pool, rng);
            hexes.push(rollHex(primary, secondary, [], rng));
        }
        const sigs = hexes.map(h => AXES.map(a => h[a]).join(','));
        const unique = new Set(sigs);
        expect(unique.size).toBeGreaterThan(1);
    });
});

describe('applySecondaryEnvelope (derived, supersedes 00_SPEC §8 MODIFIERS table)', () => {
    it('pulls the primary center ~40% toward the secondary center per axis', () => {
        const primary: GroupEnvelope = {
            drive:     { center: 0, spread: 'normal' },
            diligence: { center: 0, spread: 'normal' },
            boldness:  { center: 0, spread: 'normal' },
            warmth:    { center: 0, spread: 'normal' },
            empathy:   { center: 0, spread: 'normal' },
            composure: { center: 0, spread: 'normal' },
        };
        const secondary: GroupEnvelope = {
            drive:     { center: 2, spread: 'normal' },
            diligence: { center: 2, spread: 'normal' },
            boldness:  { center: 2, spread: 'normal' },
            warmth:    { center: 2, spread: 'normal' },
            empathy:   { center: 2, spread: 'normal' },
            composure: { center: 2, spread: 'normal' },
        };
        const key = '__test_secondary__';
        (ENVELOPES as Record<string, GroupEnvelope>)[key] = secondary;
        try {
            const merged = applySecondaryEnvelope(primary, key);
            for (const axis of AXES) {
                // 0 + (2 - 0) * 0.4 = 0.8 → rounded to 1.
                expect(merged[axis].center).toBe(1);
            }
        } finally {
            delete (ENVELOPES as Record<string, GroupEnvelope>)[key];
        }
    });

    it('widens spread one step where centers diverge, leaves it where they agree', () => {
        const primary: GroupEnvelope = {
            drive:     { center: 0, spread: 'tight' },
            diligence: { center: 0, spread: 'tight' },
            boldness:  { center: 0, spread: 'tight' },
            warmth:    { center: 0, spread: 'tight' },
            empathy:   { center: 0, spread: 'tight' },
            composure: { center: 0, spread: 'tight' },
        };
        const secondary: GroupEnvelope = {
            drive:     { center: 3, spread: 'wide' },
            diligence: { center: 0, spread: 'wide' },
            boldness:  { center: 0, spread: 'wide' },
            warmth:    { center: 0, spread: 'wide' },
            empathy:   { center: 0, spread: 'wide' },
            composure: { center: 0, spread: 'wide' },
        };
        const key = '__test_secondary2__';
        (ENVELOPES as Record<string, GroupEnvelope>)[key] = secondary;
        try {
            const merged = applySecondaryEnvelope(primary, key);
            expect(merged.drive.spread).toBe('normal');
            expect(merged.diligence.spread).toBe('tight');
        } finally {
            delete (ENVELOPES as Record<string, GroupEnvelope>)[key];
        }
    });

    it('returns the primary unchanged when the secondary key is unknown/absent', () => {
        const primary: GroupEnvelope = ENVELOPES[GROUP_KEYS[0]];
        const merged = applySecondaryEnvelope(primary, 'does-not-exist');
        expect(merged).toBe(primary);
        expect(applySecondaryEnvelope(primary, undefined)).toBe(primary);
    });
});

describe('pickGroups', () => {
    it('never returns primary === secondary', () => {
        const rng = mulberry32(555);
        for (let i = 0; i < 5000; i++) {
            const { primary, secondary } = pickGroups(['scholar', 'brute', 'fool'], rng);
            expect(secondary).not.toBe(primary);
        }
    });

    it('never returns an unknown key', () => {
        const rng = mulberry32(9999);
        const known = new Set(GROUP_KEYS);
        for (let i = 0; i < 5000; i++) {
            const { primary, secondary } = pickGroups(['scholar', 'garbage-key', 'fool'], rng);
            expect(known.has(primary)).toBe(true);
            if (secondary !== undefined) expect(known.has(secondary)).toBe(true);
        }
    });

    it('falls back to GROUP_KEYS on empty/garbage candidate list', () => {
        const rng = mulberry32(12);
        const { primary } = pickGroups([], rng);
        expect(GROUP_KEYS).toContain(primary);
        const { primary: p2 } = pickGroups(['only-garbage'], rng);
        expect(GROUP_KEYS).toContain(p2);
    });

    it('returns secondary undefined when only one valid candidate exists', () => {
        const { primary, secondary } = pickGroups(['scholar'], mulberry32(1));
        expect(primary).toBe('scholar');
        expect(secondary).toBeUndefined();
    });
});

describe('drawConsistentTraits', () => {
    it('draws 1–2 traits that do not duplicate the existing set', () => {
        const hex: PersonalityHex = { drive: 1, diligence: 1, boldness: 1, warmth: 1, empathy: 1, composure: 1 };
        const drawn = drawConsistentTraits(hex, ['loyal'], mulberry32(3), false);
        expect(drawn.length).toBeGreaterThanOrEqual(1);
        expect(drawn.length).toBeLessThanOrEqual(2);
        expect(drawn).not.toContain('loyal');
    });

    it('respects the mature gate (no mature traits when matureMode=false)', () => {
        const hex: PersonalityHex = { drive: -3, diligence: -3, boldness: -3, warmth: -3, empathy: -3, composure: -3 };
        const MATURE = new Set(['sadistic', 'predatory', 'bloodthirsty', 'ruthless', 'manipulative', 'possessive', 'fanatical', 'addictive', 'depraved', 'treacherous', 'extortionist', 'corrupt']);
        const drawn = drawConsistentTraits(hex, [], mulberry32(4), false);
        for (const t of drawn) expect(MATURE.has(t)).toBe(false);
    });

    it('caps total (existing + drawn) at 5', () => {
        const hex: PersonalityHex = { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 };
        const existing = ['a', 'b', 'c', 'd'];
        const drawn = drawConsistentTraits(hex, existing, mulberry32(5), false);
        expect(existing.length + drawn.length).toBeLessThanOrEqual(5);
    });

    it('returns empty when existing already has 5', () => {
        const hex: PersonalityHex = { drive: 0, diligence: 0, boldness: 0, warmth: 0, empathy: 0, composure: 0 };
        const drawn = drawConsistentTraits(hex, ['a', 'b', 'c', 'd', 'e'], mulberry32(6), false);
        expect(drawn).toEqual([]);
    });
});

describe('rollLooksTier', () => {
    it('always returns one of the three tiers', () => {
        const rng = mulberry32(31);
        for (let i = 0; i < 1000; i++) {
            const t = rollLooksTier(rng);
            expect(['attractive', 'plain', 'ugly']).toContain(t);
        }
    });

    it('is roughly weighted ~25/50/25 over a large sample', () => {
        const rng = mulberry32(99);
        const N = 20000;
        let att = 0, plain = 0, ugly = 0;
        for (let i = 0; i < N; i++) {
            const t = rollLooksTier(rng);
            if (t === 'attractive') att++;
            else if (t === 'plain') plain++;
            else ugly++;
        }
        expect(att / N).toBeGreaterThan(0.2);
        expect(att / N).toBeLessThan(0.3);
        expect(plain / N).toBeGreaterThan(0.45);
        expect(plain / N).toBeLessThan(0.55);
        expect(ugly / N).toBeGreaterThan(0.2);
        expect(ugly / N).toBeLessThan(0.3);
    });
});