import { createContext } from 'react';

declare const __COMBAT_GLYPHS__: string | undefined;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type GlyphArt = ReadonlySet<string>;

export function parseGlyphManifest(raw: unknown): GlyphArt {
    let data: unknown = raw;
    if (typeof raw === 'string') {
        try {
            data = JSON.parse(raw);
        } catch {
            return new Set();
        }
    }
    if (!Array.isArray(data)) return new Set();
    return new Set(data.filter((n): n is string => typeof n === 'string' && NAME.test(n)));
}

let cached: GlyphArt | null = null;

export function availableGlyphArt(): GlyphArt {
    if (!cached) cached = parseGlyphManifest(typeof __COMBAT_GLYPHS__ === 'undefined' ? undefined : __COMBAT_GLYPHS__);
    return cached;
}

export function glyphArtUrl(id: string): string {
    return `${import.meta.env.BASE_URL}assets/combat/glyphs/${id}.png`;
}

export const GlyphArtContext = createContext<GlyphArt>(availableGlyphArt());
