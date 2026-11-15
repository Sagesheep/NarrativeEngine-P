import { createContext } from 'react';

declare const __COMBAT_PIXEL__: string | undefined;

export const PIXEL_FOLDERS = ['floor', 'decal', 'difficult', 'hazard', 'cover', 'wall'] as const;

export type PixelFolder = typeof PIXEL_FOLDERS[number];

export type PixelProp = { name: string; file: string; w: number; h: number; up: number };

export type PixelCatalog = {
    floors: ReadonlyMap<string, readonly string[]>;
    decals: readonly string[];
    difficult: readonly string[];
    hazard: readonly string[];
    covers: readonly PixelProp[];
    walls: readonly PixelProp[];
    fills: readonly string[];
    rejected: readonly string[];
};

export type ParsedPixelName =
    | { kind: 'floor'; base: string; file: string }
    | { kind: 'overlay'; folder: 'decal' | 'difficult' | 'hazard'; name: string; file: string }
    | { kind: 'prop'; folder: 'cover' | 'wall'; prop: PixelProp }
    | { kind: 'fill'; name: string; file: string };

const WORD = '[a-z0-9]+(?:-[a-z0-9]+)*';
const PLAIN = new RegExp(`^(${WORD})$`);
const PROP = new RegExp(`^(${WORD})@([1-9][0-9]?)x([1-9][0-9]?)(?:\\+([0-9]))?$`);
const FLOOR_VARIANT = new RegExp(`^(${WORD})-([abc])$`);

export const MAX_PROP_SPAN = 16;

export function parsePixelName(folder: PixelFolder, file: string): ParsedPixelName | null {
    if (folder === 'floor') {
        const variant = FLOOR_VARIANT.exec(file);
        if (variant) return { kind: 'floor', base: variant[1], file };
        return PLAIN.test(file) ? { kind: 'floor', base: file, file } : null;
    }
    if (folder === 'decal' || folder === 'difficult' || folder === 'hazard') {
        return PLAIN.test(file) ? { kind: 'overlay', folder, name: file, file } : null;
    }
    const prop = PROP.exec(file);
    if (prop) {
        const w = Number(prop[2]);
        const h = Number(prop[3]);
        const up = prop[4] === undefined ? 0 : Number(prop[4]);
        if (w > MAX_PROP_SPAN || h > MAX_PROP_SPAN) return null;
        return { kind: 'prop', folder, prop: { name: prop[1], file, w, h, up } };
    }
    if (!PLAIN.test(file)) return null;
    if (folder === 'wall') return { kind: 'fill', name: file, file };
    return { kind: 'prop', folder, prop: { name: file, file, w: 1, h: 1, up: 0 } };
}

export function emptyPixelCatalog(): PixelCatalog {
    return { floors: new Map(), decals: [], difficult: [], hazard: [], covers: [], walls: [], fills: [], rejected: [] };
}

export function buildPixelCatalog(raw: Partial<Record<PixelFolder, readonly string[]>>): PixelCatalog {
    const floors = new Map<string, string[]>();
    const decals: string[] = [];
    const difficult: string[] = [];
    const hazard: string[] = [];
    const covers: PixelProp[] = [];
    const walls: PixelProp[] = [];
    const fills: string[] = [];
    const rejected: string[] = [];
    for (const folder of PIXEL_FOLDERS) {
        for (const file of raw[folder] ?? []) {
            const parsed = typeof file === 'string' ? parsePixelName(folder, file) : null;
            if (!parsed) {
                rejected.push(`${folder}/${String(file)}`);
                continue;
            }
            if (parsed.kind === 'floor') floors.set(parsed.base, [...(floors.get(parsed.base) ?? []), parsed.file]);
            else if (parsed.kind === 'fill') fills.push(parsed.file);
            else if (parsed.kind === 'prop') (parsed.folder === 'cover' ? covers : walls).push(parsed.prop);
            else if (parsed.folder === 'decal') decals.push(parsed.file);
            else if (parsed.folder === 'difficult') difficult.push(parsed.file);
            else hazard.push(parsed.file);
        }
    }
    for (const list of floors.values()) list.sort();
    return { floors, decals, difficult, hazard, covers, walls, fills, rejected };
}

export function parsePixelManifest(raw: unknown): PixelCatalog {
    let data: unknown = raw;
    if (typeof raw === 'string') {
        try {
            data = JSON.parse(raw);
        } catch {
            return emptyPixelCatalog();
        }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyPixelCatalog();
    const record = data as Record<string, unknown>;
    const lists: Partial<Record<PixelFolder, string[]>> = {};
    for (const folder of PIXEL_FOLDERS) {
        const list = record[folder];
        if (Array.isArray(list)) lists[folder] = list.filter((n): n is string => typeof n === 'string');
    }
    return buildPixelCatalog(lists);
}

export function hasAnyPixel(catalog: PixelCatalog): boolean {
    return catalog.floors.size + catalog.decals.length + catalog.difficult.length + catalog.hazard.length
        + catalog.covers.length + catalog.walls.length + catalog.fills.length > 0;
}

export function pixelPath(folder: PixelFolder, file: string): string {
    return `${folder}/${file}`;
}

export function pixelUrl(path: string): string {
    const slash = path.indexOf('/');
    const folder = path.slice(0, slash);
    const file = path.slice(slash + 1);
    return `${import.meta.env.BASE_URL}assets/combat/pixel/${folder}/${file}.png`;
}

export function withoutPixelPaths(catalog: PixelCatalog, failed: ReadonlySet<string>): PixelCatalog {
    if (failed.size === 0) return catalog;
    const dead = (folder: PixelFolder, file: string) => failed.has(pixelPath(folder, file));
    const floors = new Map<string, readonly string[]>();
    for (const [base, files] of catalog.floors) {
        const left = files.filter(f => !dead('floor', f));
        if (left.length > 0) floors.set(base, left);
    }
    return {
        floors,
        decals: catalog.decals.filter(f => !dead('decal', f)),
        difficult: catalog.difficult.filter(f => !dead('difficult', f)),
        hazard: catalog.hazard.filter(f => !dead('hazard', f)),
        covers: catalog.covers.filter(p => !dead('cover', p.file)),
        walls: catalog.walls.filter(p => !dead('wall', p.file)),
        fills: catalog.fills.filter(f => !dead('wall', f)),
        rejected: catalog.rejected,
    };
}

let cached: PixelCatalog | null = null;

export function availablePixel(): PixelCatalog {
    if (!cached) {
        cached = parsePixelManifest(typeof __COMBAT_PIXEL__ === 'undefined' ? undefined : __COMBAT_PIXEL__);
        if (cached.rejected.length > 0) console.warn(`Combat pixel art: ignored files that do not parse: ${cached.rejected.join(', ')}`);
    }
    return cached;
}

export const PixelCatalogContext = createContext<PixelCatalog>(availablePixel());
