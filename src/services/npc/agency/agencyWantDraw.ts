import { SHORT_WANTS, MEDIUM_WANTS, type WantEntry } from './agencyPools';

// Deterministic, pure pool draws for NPC Agency Phase 2. No LLM, no network, no dice.
// short/medium wants are plain pool draws; the long want is LLM-generated (see npcGeneration.ts).
// Per §9.8 + work-order 03: the only gate this phase is the mature-tier gate. The `traits` param
// is accepted (keeps the signature stable for Phase 3 per-trait gating) but otherwise unused now.

type DrawOpts = { matureMode: boolean; traits: string[]; count?: number; rng?: () => number };

/**
 * Draw `count` unique want strings from `pool`, excluding mature-tier entries when
 * `matureMode` is false. Returns fewer than `count` only if the eligible pool is smaller
 * (never pads or repeats). Pure: pass `rng` to make the draw deterministic.
 */
function drawFromPool(pool: readonly WantEntry[], count: number, matureMode: boolean, rng: () => number): string[] {
    const eligible = pool.filter(w => matureMode || w.tier !== 'mature');
    // Fisher-Yates partial shuffle over a copy, then take `count`.
    const items = eligible.slice();
    const take = Math.min(count, items.length);
    for (let i = 0; i < take; i++) {
        const j = i + Math.floor(rng() * (items.length - i));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items.slice(0, take).map(w => w.text);
}

export function drawShortWants(opts: DrawOpts): string[] {
    const { matureMode, count = 4, rng = Math.random } = opts;
    return drawFromPool(SHORT_WANTS, count, matureMode, rng);
}

export function drawMediumWants(opts: DrawOpts): string[] {
    const { matureMode, count = 3, rng = Math.random } = opts;
    return drawFromPool(MEDIUM_WANTS, count, matureMode, rng);
}
