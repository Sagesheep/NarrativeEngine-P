import { describe, it, expect } from 'vitest';
import { enumerateBlocks } from '../blockModel';
import { listTierBlocks } from '../../../services/turn/aiTier';
import { createFinalUserRegistryWithExtensions } from '../../../services/payload/contributions/extensions';
import { postTurnTracks } from '../../../services/turn/tracks';

/**
 * WORKORDER-P5-02 §4 / §5 — the block model.
 *
 * Verifies that `enumerateBlocks()` walks the three registries and produces the unified
 * `Block` shape, and that the §5 automation rules (manual blocks are not switchable;
 * unwired blocks are present-but-inert; locked blocks are visible, not hidden) hold —
 * all derived from metadata, never from feature-name checks.
 */
describe('WORKORDER-P5-02 §4 — enumerateBlocks', () => {
    const result = enumerateBlocks();

    it('returns three sections (tier, contributions, tracks)', () => {
        expect(result.tier).toBeInstanceOf(Array);
        expect(result.contributions).toBeInstanceOf(Array);
        expect(result.tracks).toBeInstanceOf(Array);
    });

    it('tier section has one Block per TierBlock the registry publishes', () => {
        expect(result.tier).toHaveLength(listTierBlocks().length);
    });

    it('contributions section has one Block per registered contribution module (built-ins + mods)', () => {
        const expected = createFinalUserRegistryWithExtensions().list().length;
        expect(result.contributions).toHaveLength(expected);
    });

    it('tracks section has one Block per registered post-turn track', () => {
        expect(result.tracks).toHaveLength(postTurnTracks.list().length);
    });

    it('every Block has the required fields and a valid kind/source', () => {
        const all = [...result.tier, ...result.contributions, ...result.tracks];
        expect(all.length).toBeGreaterThan(0);
        for (const block of all) {
            expect(typeof block.id).toBe('string');
            expect(block.id.length).toBeGreaterThan(0);
            expect(typeof block.name).toBe('string');
            expect(block.name.length).toBeGreaterThan(0);
            expect(typeof block.description).toBe('string');
            expect(block.description.length).toBeGreaterThan(0);
            expect(['engine', 'model']).toContain(block.kind);
            expect(['tier', 'contribution', 'track']).toContain(block.source);
            expect(typeof block.switchable).toBe('boolean');
            expect(typeof block.defaultEnabled).toBe('boolean');
            if (block.lockReason !== undefined) {
                expect(['structural', 'manual', 'unwired']).toContain(block.lockReason);
                expect(block.switchable).toBe(false);
            }
        }
    });

    it('ids are unique across all three sections (no id collision between registries)', () => {
        const all = [...result.tier, ...result.contributions, ...result.tracks];
        const ids = all.map((b) => b.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('WORKORDER-P5-02 §5 — switchable / locked / manual / unwired rules (metadata-driven)', () => {
    const result = enumerateBlocks();
    const all = [...result.tier, ...result.contributions, ...result.tracks];

    it('every switchable block has no lockReason', () => {
        for (const block of all) {
            if (block.switchable) {
                expect(block.lockReason, `${block.id} is switchable but has a lockReason`).toBeUndefined();
            }
        }
    });

    it('every locked block has a lockReason', () => {
        for (const block of all) {
            if (!block.switchable) {
                expect(block.lockReason, `${block.id} is locked but has no lockReason`).toBeDefined();
            }
        }
    });

    it('manual blocks are visible (in the list), not silently omitted', () => {
        // The §5 rule: "Do not silently omit it." A manual block must appear in the list.
        const manual = all.filter((b) => b.lockReason === 'manual');
        expect(manual.length).toBeGreaterThan(0);
    });

    it('manual blocks are not switchable', () => {
        const manual = all.filter((b) => b.lockReason === 'manual');
        for (const block of manual) {
            expect(block.switchable, `${block.id} is manual but switchable`).toBe(false);
        }
    });

    it('unwired blocks are visible (in the list), not silently omitted', () => {
        // §5: a reserved slot with no call site is shown as present-but-inert, not hidden.
        const unwired = all.filter((b) => b.lockReason === 'unwired');
        expect(unwired.length).toBeGreaterThan(0);
    });

    it('unwired blocks are not switchable', () => {
        const unwired = all.filter((b) => b.lockReason === 'unwired');
        for (const block of unwired) {
            expect(block.switchable, `${block.id} is unwired but switchable`).toBe(false);
        }
    });

    it('structural blocks (toggleable === false) are visible, not omitted, and locked', () => {
        // §5: "toggleable: false renders locked, not hidden."
        const structural = all.filter((b) => b.lockReason === 'structural');
        expect(structural.length).toBeGreaterThan(0);
        for (const block of structural) {
            expect(block.switchable).toBe(false);
        }
    });
});