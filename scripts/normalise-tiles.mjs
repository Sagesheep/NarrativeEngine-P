#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

export const ART_PIXELS_PER_TILE = 32;
export const OUTPUT_SCALE = 4;
export const MAX_PALETTE = 48;
export const SEAM_PIXEL_TOLERANCE = 48;
export const SEAM_MISMATCH_LIMIT = 0.2;
export const FOOTPRINT_MIN_FILL = 0.5;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KINDS = ['floor', 'decal', 'difficult', 'hazard', 'cover', 'wall'];
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:@([1-9][0-9]?)x([1-9][0-9]?)(?:\+([0-9]))?)?$/;
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    return pb <= pc ? b : c;
}

export function decodePng(buffer) {
    if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG file');
    let pos = 8;
    let header = null;
    let palette = null;
    let transparency = null;
    const data = [];
    while (pos + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(pos);
        const type = buffer.toString('latin1', pos + 4, pos + 8);
        const body = buffer.subarray(pos + 8, pos + 8 + length);
        pos += 12 + length;
        if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colorType: body[9], interlace: body[12] };
        else if (type === 'PLTE') palette = body;
        else if (type === 'tRNS') transparency = body;
        else if (type === 'IDAT') data.push(body);
        else if (type === 'IEND') break;
    }
    if (!header || data.length === 0) throw new Error('PNG has no image data');
    const { width, height, depth, colorType } = header;
    if (header.interlace !== 0) throw new Error('interlaced PNG is not supported');
    const channels = CHANNELS[colorType];
    if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
    const depthOk = colorType === 3 || colorType === 0 ? [1, 2, 4, 8, 16].includes(depth) : depth === 8 || depth === 16;
    if (!depthOk || (colorType === 3 && depth === 16)) throw new Error(`unsupported PNG bit depth ${depth}`);
    if (colorType === 3 && !palette) throw new Error('PNG palette missing');
    if (width < 1 || height < 1 || width * height > 64 * 1024 * 1024) throw new Error('PNG dimensions out of range');
    const bits = channels * depth;
    const stride = Math.ceil((width * bits) / 8);
    const step = Math.max(1, bits >> 3);
    const raw = inflateSync(Buffer.concat(data));
    if (raw.length < (stride + 1) * height) throw new Error('PNG data is truncated');
    const lines = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const src = y * (stride + 1) + 1;
        const dst = y * stride;
        for (let i = 0; i < stride; i++) {
            const left = i >= step ? lines[dst + i - step] : 0;
            const up = y > 0 ? lines[dst - stride + i] : 0;
            const upLeft = y > 0 && i >= step ? lines[dst - stride + i - step] : 0;
            let predictor = 0;
            if (filter === 1) predictor = left;
            else if (filter === 2) predictor = up;
            else if (filter === 3) predictor = (left + up) >> 1;
            else if (filter === 4) predictor = paeth(left, up, upLeft);
            else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`);
            lines[dst + i] = (raw[src + i] + predictor) & 0xff;
        }
    }
    const rgba = new Uint8Array(width * height * 4);
    const sample = (row, index) => {
        if (depth === 8) return row[index];
        if (depth === 16) return row[index * 2];
        const perByte = 8 / depth;
        const byte = row[Math.floor(index / perByte)];
        const shift = 8 - depth * ((index % perByte) + 1);
        return (byte >> shift) & ((1 << depth) - 1);
    };
    for (let y = 0; y < height; y++) {
        const row = lines.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            if (colorType === 3) {
                const index = sample(row, x);
                rgba[o] = palette[index * 3] ?? 0;
                rgba[o + 1] = palette[index * 3 + 1] ?? 0;
                rgba[o + 2] = palette[index * 3 + 2] ?? 0;
                rgba[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
            } else if (colorType === 0 || colorType === 4) {
                const raw8 = sample(row, x * channels);
                const grey = depth < 8 ? Math.round((raw8 * 255) / ((1 << depth) - 1)) : raw8;
                rgba[o] = grey;
                rgba[o + 1] = grey;
                rgba[o + 2] = grey;
                rgba[o + 3] = colorType === 4 ? sample(row, x * channels + 1) : 255;
            } else {
                rgba[o] = sample(row, x * channels);
                rgba[o + 1] = sample(row, x * channels + 1);
                rgba[o + 2] = sample(row, x * channels + 2);
                rgba[o + 3] = colorType === 6 ? sample(row, x * channels + 3) : 255;
            }
        }
    }
    return { width, height, rgba };
}

export function encodePng({ width, height, rgba }) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const stride = width * 4;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
    }
    return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export function parseTileName(fileName) {
    const base = basename(fileName, extname(fileName));
    const match = NAME.exec(base);
    if (!match) return null;
    const w = match[1] === undefined ? 1 : Number(match[1]);
    const h = match[2] === undefined ? 1 : Number(match[2]);
    const up = match[3] === undefined ? 0 : Number(match[3]);
    return { base, prop: match[1] !== undefined, w, h, up, tilesWide: w, tilesHigh: h + up };
}

export function reduceToGrid(image, cols, rows) {
    const rgba = new Uint8Array(cols * rows * 4);
    for (let cy = 0; cy < rows; cy++) {
        const y0 = Math.floor((cy * image.height) / rows);
        const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * image.height) / rows));
        for (let cx = 0; cx < cols; cx++) {
            const x0 = Math.floor((cx * image.width) / cols);
            const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * image.width) / cols));
            let total = 0;
            let opaque = 0;
            const buckets = new Map();
            for (let y = y0; y < y1; y++) {
                for (let x = x0; x < x1; x++) {
                    const i = (y * image.width + x) * 4;
                    total++;
                    if (image.rgba[i + 3] < 128) continue;
                    opaque++;
                    const r = image.rgba[i];
                    const g = image.rgba[i + 1];
                    const b = image.rgba[i + 2];
                    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
                    const entry = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
                    entry.n++;
                    entry.r += r;
                    entry.g += g;
                    entry.b += b;
                    buckets.set(key, entry);
                }
            }
            if (opaque * 2 < total || buckets.size === 0) continue;
            let bestKey = -1;
            let best = null;
            for (const [key, entry] of buckets) {
                if (!best || entry.n > best.n || (entry.n === best.n && key < bestKey)) {
                    best = entry;
                    bestKey = key;
                }
            }
            const o = (cy * cols + cx) * 4;
            rgba[o] = Math.round(best.r / best.n);
            rgba[o + 1] = Math.round(best.g / best.n);
            rgba[o + 2] = Math.round(best.b / best.n);
            rgba[o + 3] = 255;
        }
    }
    return { width: cols, height: rows, rgba };
}

export function scaleUp(grid, factor = OUTPUT_SCALE) {
    const width = grid.width * factor;
    const height = grid.height * factor;
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const s = (Math.floor(y / factor) * grid.width + Math.floor(x / factor)) * 4;
            rgba.set(grid.rgba.subarray(s, s + 4), (y * width + x) * 4);
        }
    }
    return { width, height, rgba };
}

export function countStray(image) {
    let n = 0;
    for (let i = 3; i < image.rgba.length; i += 4) if (image.rgba[i] > 0 && image.rgba[i] < 255) n++;
    return n;
}

export function toHex(r, g, b) {
    return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

export function parseHex(text) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(text).trim());
    if (!match) return null;
    const v = parseInt(match[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function colourCounts(grid, into = new Map()) {
    for (let i = 0; i < grid.rgba.length; i += 4) {
        if (grid.rgba[i + 3] === 0) continue;
        const key = (grid.rgba[i] << 16) | (grid.rgba[i + 1] << 8) | grid.rgba[i + 2];
        into.set(key, (into.get(key) ?? 0) + 1);
    }
    return into;
}

export function buildPalette(counts, max = MAX_PALETTE) {
    const entries = [...counts].sort((a, b) => a[0] - b[0]).map(([key, n]) => ({ key, n, c: [(key >> 16) & 255, (key >> 8) & 255, key & 255] }));
    if (entries.length <= max) return entries.map(e => e.c);
    let boxes = [entries];
    while (boxes.length < max) {
        let pick = -1;
        let pickRange = -1;
        let pickChannel = 0;
        boxes.forEach((box, index) => {
            if (box.length < 2) return;
            for (let ch = 0; ch < 3; ch++) {
                const values = box.map(e => e.c[ch]);
                const range = Math.max(...values) - Math.min(...values);
                if (range > pickRange) {
                    pickRange = range;
                    pick = index;
                    pickChannel = ch;
                }
            }
        });
        if (pick < 0) break;
        const box = [...boxes[pick]].sort((a, b) => a.c[pickChannel] - b.c[pickChannel] || a.key - b.key);
        const half = box.reduce((s, e) => s + e.n, 0) / 2;
        let acc = 0;
        let cut = 1;
        for (let i = 0; i < box.length - 1; i++) {
            acc += box[i].n;
            cut = i + 1;
            if (acc >= half) break;
        }
        boxes = [...boxes.slice(0, pick), box.slice(0, cut), box.slice(cut), ...boxes.slice(pick + 1)];
    }
    const out = [];
    const seen = new Set();
    for (const box of boxes) {
        const total = box.reduce((s, e) => s + e.n, 0);
        const c = [0, 1, 2].map(ch => Math.round(box.reduce((s, e) => s + e.c[ch] * e.n, 0) / total));
        const key = toHex(c[0], c[1], c[2]);
        if (!seen.has(key)) {
            seen.add(key);
            out.push(c);
        }
    }
    return out;
}

export function snapToPalette(grid, palette) {
    const rgba = new Uint8Array(grid.rgba);
    if (palette.length === 0) return { ...grid, rgba };
    for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] === 0) continue;
        let best = 0;
        let bestD = Infinity;
        for (let p = 0; p < palette.length; p++) {
            const dr = rgba[i] - palette[p][0];
            const dg = rgba[i + 1] - palette[p][1];
            const db = rgba[i + 2] - palette[p][2];
            const d = dr * dr + dg * dg + db * db;
            if (d < bestD) {
                bestD = d;
                best = p;
            }
        }
        rgba[i] = palette[best][0];
        rgba[i + 1] = palette[best][1];
        rgba[i + 2] = palette[best][2];
    }
    return { ...grid, rgba };
}

export function countOffPalette(grid, palette) {
    const known = new Set(palette.map(c => (c[0] << 16) | (c[1] << 8) | c[2]));
    let n = 0;
    for (const key of colourCounts(grid).keys()) if (!known.has(key)) n++;
    return n;
}

function pixelDistance(grid, a, b) {
    const dr = grid.rgba[a] - grid.rgba[b];
    const dg = grid.rgba[a + 1] - grid.rgba[b + 1];
    const db = grid.rgba[a + 2] - grid.rgba[b + 2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
}

export function seamReport(grid, tolerance = SEAM_PIXEL_TOLERANCE, limit = SEAM_MISMATCH_LIMIT) {
    const { width, height } = grid;
    let horizontal = 0;
    for (let y = 0; y < height; y++) if (pixelDistance(grid, (y * width) * 4, (y * width + width - 1) * 4) > tolerance) horizontal++;
    let vertical = 0;
    for (let x = 0; x < width; x++) if (pixelDistance(grid, x * 4, ((height - 1) * width + x) * 4) > tolerance) vertical++;
    const horizontalMismatch = horizontal / height;
    const verticalMismatch = vertical / width;
    return { horizontalMismatch, verticalMismatch, seamless: horizontalMismatch <= limit && verticalMismatch <= limit };
}

export function footprintFill(grid, name) {
    const top = name.up * ART_PIXELS_PER_TILE;
    let filled = 0;
    let total = 0;
    for (let y = top; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            total++;
            if (grid.rgba[(y * grid.width + x) * 4 + 3] === 255) filled++;
        }
    }
    return total === 0 ? 0 : filled / total;
}

export function isInside(child, parent) {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function kindOf(relPath, name) {
    const folder = relPath.split(/[\\/]/).slice(0, -1).reverse().find(part => KINDS.includes(part));
    if (folder) return folder;
    if (name.prop) return 'cover';
    return /-[abc]$/.test(name.base) ? 'floor' : 'tile';
}

export function walkPngs(dir, base = dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkPngs(full, base));
        else if (entry.isFile() && extname(entry.name).toLowerCase() === '.png') out.push(relative(base, full));
    }
    return out;
}

export function readPalette(file) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : data?.colors;
    if (!Array.isArray(list)) throw new Error('palette file must be a list of #rrggbb colours or { "colors": [...] }');
    const out = [];
    for (const item of list) {
        const c = parseHex(item);
        if (!c) throw new Error(`bad palette colour ${JSON.stringify(item)}`);
        out.push(c);
    }
    return out;
}

function loadGrid(inputDir, relPath) {
    const name = parseTileName(relPath.split(/[\\/]/).pop());
    if (!name) return { skip: 'name does not parse (expected name, name-a, or name@WxH+U)' };
    let image;
    try {
        image = decodePng(readFileSync(join(inputDir, relPath)));
    } catch (error) {
        return { skip: `cannot read PNG: ${error.message}` };
    }
    const minW = name.tilesWide * ART_PIXELS_PER_TILE;
    const minH = name.tilesHigh * ART_PIXELS_PER_TILE;
    const proportional = Math.abs(image.width * name.tilesHigh - image.height * name.tilesWide) <= 0.01 * Math.max(image.width * name.tilesHigh, image.height * name.tilesWide);
    if (!proportional || image.width < minW || image.height < minH) {
        return { skip: `size ${image.width}x${image.height} does not fit ${name.tilesWide}x${name.tilesHigh} tiles (same proportions, at least ${minW}x${minH})` };
    }
    return { name, image, grid: reduceToGrid(image, minW, minH) };
}

export function extractPalette(inputDir, log = console.log) {
    const counts = new Map();
    let used = 0;
    for (const relPath of walkPngs(inputDir)) {
        const loaded = loadGrid(inputDir, relPath);
        if (loaded.skip) {
            log(`skip ${relPath.replace(/\\/g, '/')}: ${loaded.skip}`);
            continue;
        }
        colourCounts(loaded.grid, counts);
        used++;
    }
    return { colors: buildPalette(counts).map(c => toHex(c[0], c[1], c[2])), images: used };
}

export function normaliseFolder(inputDir, outputDir, palette, log = console.log) {
    const input = resolve(inputDir);
    const output = resolve(outputDir);
    if (isInside(output, input)) throw new Error('refusing to write into the input folder');
    let written = 0;
    let skipped = 0;
    for (const relPath of walkPngs(input)) {
        const loaded = loadGrid(input, relPath);
        const shown = relPath.replace(/\\/g, '/');
        if (loaded.skip) {
            skipped++;
            log(`skip ${shown}: ${loaded.skip}`);
            continue;
        }
        const { name, image, grid } = loaded;
        const kind = kindOf(relPath, name);
        const parts = [shown,`${image.width}x${image.height} -> ${grid.width}x${grid.height} art px`];
        parts.push(`stray alpha ${countStray(image)}`);
        if (palette) parts.push(`off-palette ${countOffPalette(grid, palette)}`);
        const seamKinds = kind === 'floor' || (kind === 'wall' && !name.prop);
        if (seamKinds) {
            const seam = seamReport(grid);
            parts.push(`seamless ${seam.seamless ? 'yes' : 'NO'} (h ${(seam.horizontalMismatch * 100).toFixed(0)}% v ${(seam.verticalMismatch * 100).toFixed(0)}%)`);
        }
        if (name.prop) {
            const fill = footprintFill(grid, name);
            parts.push(`footprint ${(fill * 100).toFixed(0)}% filled${fill < FOOTPRINT_MIN_FILL ? ' (LOW)' : ''}`);
        }
        const final = palette ? snapToPalette(grid, palette) : grid;
        const target = join(output, relPath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, encodePng(scaleUp(final)));
        written++;
        log(parts.join(' | '));
    }
    log(`done: ${written} written, ${skipped} skipped`);
    return { written, skipped };
}

const USAGE = 'usage: node scripts/normalise-tiles.mjs <input-folder> <output-folder> [--palette <file>] [--extract-palette <file>]';

export function parseArgs(argv) {
    const positional = [];
    let palette = null;
    let extract = null;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--palette' || arg === '--extract-palette') {
            const value = argv[++i];
            if (!value || value.startsWith('--')) throw new Error(`${arg} needs a file`);
            if (arg === '--palette') palette = value;
            else extract = value;
        } else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
        else positional.push(arg);
    }
    return { input: positional[0] ?? null, output: positional[1] ?? null, palette, extract };
}

export function main(argv, log = console.log) {
    try {
        const args = parseArgs(argv);
        if (!args.input || (!args.output && !args.extract)) throw new Error(USAGE);
        if (!statSync(args.input).isDirectory()) throw new Error(`${args.input} is not a folder`);
        if (args.extract) {
            if (isInside(args.extract, args.input)) throw new Error('refusing to write into the input folder');
            const result = extractPalette(args.input, log);
            mkdirSync(dirname(resolve(args.extract)), { recursive: true });
            writeFileSync(args.extract, `${JSON.stringify({ colors: result.colors }, null, 2)}\n`);
            log(`palette: ${result.colors.length} colours from ${result.images} images -> ${args.extract}`);
            return 0;
        }
        const palette = args.palette ? readPalette(args.palette) : null;
        normaliseFolder(args.input, args.output, palette, log);
        return 0;
    } catch (error) {
        log(error.message);
        return 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
