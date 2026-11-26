/**
 * WO-C §6 / §10.9 — in-test PNG chunk WRITER.
 *
 * No binary fixture files anywhere in the repo: every PNG a test needs is
 * assembled here from a signature, an IHDR stub, zero or more `tEXt` chunks and
 * an IEND. CRC fields are written as zeros — `parsePngCard` skips CRC
 * validation by design, so the bytes only have to be structurally right.
 *
 * Shared with the converter/wizard tests; keep it dependency-free.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 1x1 RGBA, bit depth 8, no interlace. Never decoded — only walked past. */
const IHDR_DATA = [
    0x00, 0x00, 0x00, 0x01, // width  = 1
    0x00, 0x00, 0x00, 0x01, // height = 1
    0x08, // bit depth
    0x06, // colour type (RGBA)
    0x00, // compression
    0x00, // filter
    0x00, // interlace
];

export type BuildCardPngOptions = {
    /** tEXt keyword carrying the base64 payload. Default `'chara'` (V2). */
    keyword?: 'chara' | 'ccv3';
    /**
     * Extra tEXt chunks written *before* the payload chunk, verbatim (NOT
     * base64-encoded for you). Use `encodeCardPayload` when the extra chunk
     * should itself hold a card — e.g. a `chara` chunk sitting ahead of a
     * `ccv3` one, to prove precedence is not just "last chunk wins".
     */
    extraText?: { keyword: string; text: string }[];
    /**
     * Cut the buffer short inside the payload chunk's data, so its declared
     * length runs past the end of the file (the `'truncated'` case).
     */
    truncateTail?: boolean;
};

/** A PNG carrying `payload` as JSON -> UTF-8 -> base64 in a tEXt chunk. */
export function buildCardPng(payload: unknown, opts: BuildCardPngOptions = {}): ArrayBuffer {
    const keyword = opts.keyword ?? 'chara';
    const parts: number[][] = [PNG_SIGNATURE, chunk('IHDR', IHDR_DATA)];

    for (const extra of opts.extraText ?? []) {
        parts.push(chunk('tEXt', textChunkData(extra.keyword, extra.text)));
    }

    // Offset at which the payload chunk's *data* begins, for truncateTail.
    const payloadDataStart = parts.reduce((sum, part) => sum + part.length, 0) + 8;
    parts.push(chunk('tEXt', textChunkData(keyword, encodeCardPayload(payload))));
    parts.push(chunk('IEND', []));

    const bytes = flatten(parts);
    // +2 so the chunk header is intact and the cut lands inside the data.
    const end = opts.truncateTail ? Math.min(payloadDataStart + 2, bytes.length) : bytes.length;
    return toArrayBuffer(bytes.slice(0, end));
}

/** A structurally valid PNG with no tEXt chunk at all (metadata stripped). */
export function buildPlainPng(): ArrayBuffer {
    return toArrayBuffer(flatten([PNG_SIGNATURE, chunk('IHDR', IHDR_DATA), chunk('IEND', [])]));
}

/** JSON -> UTF-8 bytes -> base64, the exact encoding ST writes into `chara`. */
export function encodeCardPayload(payload: unknown): string {
    const utf8 = new TextEncoder().encode(JSON.stringify(payload));
    let binary = '';
    for (const byte of utf8) binary += String.fromCharCode(byte);
    return btoa(binary);
}

/* ------------------------------------------------------------------ */

/** `[4-byte BE length][4-byte type][data][4-byte CRC]`, CRC left as zeros. */
function chunk(type: string, data: number[]): number[] {
    const length = data.length;
    return [
        (length >>> 24) & 0xff,
        (length >>> 16) & 0xff,
        (length >>> 8) & 0xff,
        length & 0xff,
        ...[0, 1, 2, 3].map((i) => type.charCodeAt(i) & 0xff),
        ...data,
        0,
        0,
        0,
        0,
    ];
}

/** tEXt payload: `keyword\0text`, both latin-1. */
function textChunkData(keyword: string, text: string): number[] {
    const out: number[] = [];
    for (const char of keyword) out.push(char.charCodeAt(0) & 0xff);
    out.push(0);
    for (const char of text) out.push(char.charCodeAt(0) & 0xff);
    return out;
}

function flatten(parts: number[][]): number[] {
    const out: number[] = [];
    for (const part of parts) out.push(...part);
    return out;
}

function toArrayBuffer(bytes: number[]): ArrayBuffer {
    const buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    return buffer;
}
