import type { Rng } from './types';

const GOLDEN = 0x6d2b79f5;

function normalizeSeed(seed: number): number {
    return Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0;
}

function normalizeCursor(cursor: number): number {
    return Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
}

function mulberry32At(seed: number, step: number): number {
    const state = (seed + Math.imul(step, GOLDEN)) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function createRng(seed: number, cursor = 0): Rng {
    const s = normalizeSeed(seed);
    let position = normalizeCursor(cursor);

    const next = (): number => {
        position += 1;
        return mulberry32At(s, position);
    };

    const int = (min: number, max: number): number => {
        const lo = Math.ceil(Math.min(min, max));
        const hi = Math.floor(Math.max(min, max));
        if (hi <= lo) return lo;
        return lo + Math.floor(next() * (hi - lo + 1));
    };

    const roll = (sides: number): number => int(1, Math.max(1, Math.floor(sides)));

    return {
        get seed() { return s; },
        get cursor() { return position; },
        next,
        int,
        roll,
    };
}
