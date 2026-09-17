/** Native world metadata transport. Deliberately never writes ST character chunks. */
export const WORLD_PNG_KEY = 'narrative-world';
export const MAX_WORLD_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_WORLD_PAYLOAD_BYTES = 4 * 1024 * 1024;
const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

type Chunk = { type: string; data: Uint8Array; bytes: Uint8Array };

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function walkPng(bytes: Uint8Array): Chunk[] {
    if (bytes.length > MAX_WORLD_FILE_BYTES) throw new Error('World files must be smaller than 20 MB.');
    if (!SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error('This is not a PNG file.');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunks: Chunk[] = [];
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const size = view.getUint32(offset);
        const end = offset + 12 + size;
        if (end > bytes.length) throw new Error('The PNG is truncated or damaged.');
        const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
        const data = bytes.subarray(offset + 8, end - 4);
        if (chunks.length === 0 && (type !== 'IHDR' || size !== 13)) throw new Error('Invalid PNG header.');
        chunks.push({ type, data, bytes: bytes.subarray(offset, end) });
        if (type === 'IEND') {
            if (size !== 0 || end !== bytes.length) throw new Error('Invalid PNG ending.');
            return chunks;
        }
        offset = end;
    }
    throw new Error('The PNG is truncated or missing its ending.');
}

function keyword(chunk: Chunk): string {
    if (!['tEXt', 'iTXt', 'zTXt'].includes(chunk.type)) return '';
    const separator = chunk.data.indexOf(0);
    return separator < 0 ? '' : String.fromCharCode(...chunk.data.subarray(0, Math.min(separator, 80))).toLowerCase();
}

function textChunk(text: string): Uint8Array<ArrayBuffer> {
    const data = encoder.encode(`${WORLD_PNG_KEY}\0${text}`);
    const bytes = new Uint8Array(data.length + 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, data.length);
    bytes.set(encoder.encode('tEXt'), 4);
    bytes.set(data, 8);
    view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, bytes.length - 4)));
    return bytes;
}

export function encodeWorldPayload(value: unknown): string {
    const utf8 = encoder.encode(JSON.stringify(value));
    if (utf8.length > MAX_WORLD_PAYLOAD_BYTES) throw new Error('World data exceeds the 4 MB limit.');
    let binary = '';
    for (let i = 0; i < utf8.length; i += 8192) binary += String.fromCharCode(...utf8.subarray(i, i + 8192));
    return btoa(binary);
}

export function decodeWorldPayload(text: string): unknown {
    if (text.length > Math.ceil(MAX_WORLD_PAYLOAD_BYTES / 3) * 4) throw new Error('World data exceeds the 4 MB limit.');
    try {
        const binary = atob(text);
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        if (bytes.length > MAX_WORLD_PAYLOAD_BYTES) throw new Error();
        return JSON.parse(decoder.decode(bytes));
    } catch {
        throw new Error('The embedded world data is damaged.');
    }
}

/** null means a structurally valid PNG without native world data (try ST next). */
export function readWorldPng(bytes: Uint8Array): unknown | null {
    const matches = walkPng(bytes).filter(c => keyword(c) === WORLD_PNG_KEY);
    if (matches.length === 0) return null;
    if (matches.length !== 1 || matches[0].type !== 'tEXt') throw new Error('Ambiguous or unsupported world metadata.');
    const chunk = matches[0];
    const view = new DataView(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength);
    if (view.getUint32(chunk.bytes.length - 4) !== crc32(chunk.bytes.subarray(4, chunk.bytes.length - 4))) {
        throw new Error('The embedded world data failed its integrity check.');
    }
    const value = decodeWorldPayload(decoder.decode(chunk.data.subarray(chunk.data.indexOf(0) + 1)));
    if (value === null) throw new Error('The embedded world data is not a world object.');
    return value;
}

export function writeWorldPng(image: Uint8Array, value: unknown): Uint8Array<ArrayBuffer> {
    const chunks = walkPng(image);
    // Remove all textual metadata from a supplied cover, including old ST cards.
    const kept = chunks.filter(c => !['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(c.type));
    const payload = textChunk(encodeWorldPayload(value));
    const size = 8 + payload.length + kept.reduce((n, c) => n + c.bytes.length, 0);
    if (size > MAX_WORLD_FILE_BYTES) throw new Error('The resulting world PNG exceeds 20 MB.');
    const out = new Uint8Array(size);
    out.set(SIGNATURE);
    let offset = 8;
    for (const chunk of kept) {
        if (chunk.type === 'IEND') { out.set(payload, offset); offset += payload.length; }
        out.set(chunk.bytes, offset);
        offset += chunk.bytes.length;
    }
    return out;
}

/** Read ST metadata only as an input adapter; never included in exports. */
export function readSTWorldPng(bytes: Uint8Array): unknown {
    const chunks = walkPng(bytes);
    for (const key of ['ccv3', 'chara']) {
        const chunk = chunks.find(c => c.type === 'tEXt' && keyword(c) === key);
        if (chunk) return decodeWorldPayload(decoder.decode(chunk.data.subarray(chunk.data.indexOf(0) + 1)));
    }
    throw new Error('No world lore data in this PNG. Use the original exported file, not a screenshot.');
}
