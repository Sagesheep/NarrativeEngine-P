import { tileHash } from './tileset';

export function patchValue(seed: number, x: number, y: number, cell: number, salt: number): number {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    let best = Infinity;
    let value = 0;
    for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
            const gx = cx + i;
            const gy = cy + j;
            const px = (gx + tileHash(seed, gx, gy, salt * 7 + 1)) * cell;
            const py = (gy + tileHash(seed, gx, gy, salt * 7 + 2)) * cell;
            const d = (x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2;
            if (d < best) {
                best = d;
                value = tileHash(seed, gx, gy, salt * 7 + 3);
            }
        }
    }
    return value;
}

export function wander(seed: number, x: number, salt: number, span = 4): number {
    const cell = Math.floor(x / span);
    const t = x / span - cell;
    const smooth = t * t * (3 - 2 * t);
    return tileHash(seed, cell, 0, salt) * (1 - smooth) + tileHash(seed, cell + 1, 0, salt) * smooth;
}

export type Weighted = { name: string; weight: number };

export function pickWeighted(entries: readonly Weighted[], value: number): string | null {
    if (entries.length === 0) return null;
    const total = entries.reduce((a, e) => a + e.weight, 0);
    let at = value * total;
    for (const e of entries) {
        at -= e.weight;
        if (at < 0) return e.name;
    }
    return entries[entries.length - 1].name;
}
