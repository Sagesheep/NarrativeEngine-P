const GRAD3: [number, number][] = [
    [1, 1], [-1, 1], [1, -1], [-1, -1],
    [1, 0], [-1, 0], [0, 1], [0, -1],
];

function buildPermutationTable(seed: number): Uint8Array {
    const perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;

    let s = seed | 0;
    for (let i = 255; i > 0; i--) {
        s = (s * 1664525 + 1013904223) | 0;
        const j = ((s >>> 0) % (i + 1));
        [p[i], p[j]] = [p[j], p[i]];
    }

    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    return perm;
}

function fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
    return a + t * (b - a);
}

function grad2(hash: number, x: number, y: number): number {
    const g = GRAD3[hash & 7];
    return g[0] * x + g[1] * y;
}

export function createNoiseGenerator(seed: number) {
    const perm = buildPermutationTable(seed);

    function noise2D(x: number, y: number): number {
        const X = Math.floor(x) & 255;
        const Y = Math.floor(y) & 255;

        const xf = x - Math.floor(x);
        const yf = y - Math.floor(y);

        const u = fade(xf);
        const v = fade(yf);

        const aa = perm[perm[X] + Y];
        const ab = perm[perm[X] + Y + 1];
        const ba = perm[perm[X + 1] + Y];
        const bb = perm[perm[X + 1] + Y + 1];

        return lerp(
            lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u),
            lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u),
            v,
        );
    }

    function fbm(x: number, y: number, octaves: number = 4, lacunarity: number = 2, gain: number = 0.5): number {
        let sum = 0;
        let amp = 1;
        let freq = 1;
        let maxAmp = 0;

        for (let i = 0; i < octaves; i++) {
            sum += noise2D(x * freq, y * freq) * amp;
            maxAmp += amp;
            amp *= gain;
            freq *= lacunarity;
        }

        return sum / maxAmp;
    }

    return { noise2D, fbm };
}
