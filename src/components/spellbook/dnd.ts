import type { GlyphRef } from '@narrative/engine';

export const ABILITY_MIME = 'application/x-ne-ability';
export const SLOT_MIME = 'application/x-ne-slot';
export const GLYPH_MIME = 'application/x-ne-glyph';
export const SOCKET_MIME = 'application/x-ne-socket';

type Transfer = { types?: ArrayLike<string> | readonly string[]; getData?: (type: string) => string } | null | undefined;

export function carries(transfer: Transfer, mime: string): boolean {
    if (!transfer) return false;
    if (transfer.types && Array.from(transfer.types).includes(mime)) return true;
    return typeof transfer.getData === 'function' && transfer.getData(mime) !== '';
}

export function readTransfer(transfer: Transfer, mime: string): string | null {
    const value = transfer?.getData?.(mime);
    return value ? value : null;
}

export function encodeGlyph(glyph: GlyphRef): string {
    return JSON.stringify({ kind: glyph.kind, id: glyph.id });
}

export function parseGlyph(raw: string | null): GlyphRef | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<GlyphRef>;
        if ((value.kind === 'form' || value.kind === 'effect' || value.kind === 'augment') && typeof value.id === 'string') return value as GlyphRef;
    } catch {
        return null;
    }
    return null;
}
