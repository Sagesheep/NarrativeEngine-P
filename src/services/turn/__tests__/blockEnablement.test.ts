import { describe, it, expect } from 'vitest';
import { isBlockEnabled } from '../blockEnablement';
import type { AiTier } from '../../../types';

/**
 * WORKORDER-P5-01 §4 Step 2 — resolver unit tests.
 *
 * Covers both branches of the asymmetry:
 *   - ids IN `TierFeature` resolve from the matrix when no explicit override.
 *   - ids NOT in `TierFeature` resolve to enabled when no explicit override
 *     (the "absent means enabled" convention for contributions/tracks).
 * And the precedence: explicit override wins over the tier preset.
 */

describe('WORKORDER-P5-01 — isBlockEnabled resolver', () => {
    describe('explicit override wins (precedence 1)', () => {
        it('explicit true overrides a tier preset that would be false', () => {
            // 'arcTick' is false on lite, but an explicit true wins.
            expect(isBlockEnabled('arcTick', 'lite', { arcTick: true })).toBe(true);
        });

        it('explicit false overrides a tier preset that would be true', () => {
            // 'arcTick' is true on pro, but an explicit false wins.
            expect(isBlockEnabled('arcTick', 'pro', { arcTick: false })).toBe(false);
        });

        it('explicit true for a non-matrix id stays true', () => {
            expect(isBlockEnabled('track.npc', 'lite', { 'track.npc': true })).toBe(true);
        });

        it('explicit false for a non-matrix id disables it', () => {
            expect(isBlockEnabled('track.npc', 'max', { 'track.npc': false })).toBe(false);
        });
    });

    describe('tier preset fallback (precedence 2)', () => {
        it('a TierFeature id with no override resolves from the matrix', () => {
            expect(isBlockEnabled('arcTick', 'lite', undefined)).toBe(false);
            expect(isBlockEnabled('arcTick', 'pro', undefined)).toBe(true);
            expect(isBlockEnabled('arcTick', 'max', undefined)).toBe(true);
        });

        it('undefined tier falls back to the pro preset', () => {
            expect(isBlockEnabled('planner', undefined, undefined)).toBe(true);
            expect(isBlockEnabled('introEngine', undefined, undefined)).toBe(false);
        });

        it('an empty moduleEnabled map falls back to the tier preset', () => {
            expect(isBlockEnabled('deepScan', 'pro', {})).toBe(true);
            expect(isBlockEnabled('deepScan', 'lite', {})).toBe(false);
        });

        it('an unrelated explicit key does not affect a TierFeature id', () => {
            expect(isBlockEnabled('planner', 'pro', { 'track.other': false })).toBe(true);
        });
    });

    describe('matrix miss + no explicit entry → enabled (the asymmetry)', () => {
        it('a non-matrix id with no override resolves to enabled', () => {
            expect(isBlockEnabled('track.npc', 'lite', undefined)).toBe(true);
            expect(isBlockEnabled('track.npc', 'pro', undefined)).toBe(true);
            expect(isBlockEnabled('track.npc', 'max', undefined)).toBe(true);
        });

        it('a non-matrix id with an empty map resolves to enabled', () => {
            expect(isBlockEnabled('volatile.block', 'lite', {})).toBe(true);
        });

        it('a non-matrix id with undefined tier still resolves to enabled', () => {
            expect(isBlockEnabled('mod.grimdark', undefined, undefined)).toBe(true);
        });

        it('a non-matrix id with an unrelated explicit key still resolves to enabled', () => {
            expect(isBlockEnabled('track.npc', 'pro', { 'track.other': false })).toBe(true);
        });
    });

    describe('byte-identical to today — tierAllows(tier, f) = isBlockEnabled(f, tier, undefined)', () => {
        const tierFeatureIds: Array<[string, AiTier | undefined, boolean]> = [
            ['introEngine', 'lite', false],
            ['introEngine', 'pro', false],
            ['introEngine', 'max', true],
            ['planner', 'lite', false],
            ['planner', 'pro', true],
            ['planner', 'max', true],
            ['arcTick', 'lite', false],
            ['arcTick', 'pro', true],
            ['arcTick', 'max', true],
            ['arcSpawn', 'lite', false],
            ['arcSpawn', 'pro', true],
            ['arcSpawn', 'max', true],
            ['directorBrief', 'lite', false],
            ['directorBrief', 'pro', true],
            ['directorBrief', 'max', true],
            ['lodSlottedRag', 'lite', false],
            ['lodSlottedRag', 'pro', false],
            ['lodSlottedRag', 'max', true],
        ];

        for (const [id, tier, expected] of tierFeatureIds) {
            it(`isBlockEnabled('${id}', '${tier}', undefined) === ${expected}`, () => {
                expect(isBlockEnabled(id, tier, undefined)).toBe(expected);
            });
        }

        it('undefined tier falls back to pro (matches tierAllows ?? pro)', () => {
            for (const id of ['planner', 'introEngine', 'lodSlottedRag'] as const) {
                const proValue = isBlockEnabled(id, 'pro', undefined);
                expect(isBlockEnabled(id, undefined, undefined)).toBe(proValue);
            }
        });
    });
});