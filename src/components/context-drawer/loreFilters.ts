import type { LoreChunk } from '../../types';

/**
 * Filter chips for the Lore tab: one per built-in category in use and one per
 * user folder. A folder is display-only sorting (`LoreChunk.folder`); it never
 * touches retrieval, unlike `category` (priority, rules budget) or `group`
 * (retrieval group competition).
 */
export type LoreFilterKind = 'category' | 'folder';

export type LoreFilterChip = {
    /** `category:<name>` or `folder:<lowercased name>`. */
    key: string;
    kind: LoreFilterKind;
    label: string;
    count: number;
};

/** Trim and collapse spaces; empty means "no folder". */
export function cleanFolder(value: string | undefined): string | undefined {
    const cleaned = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return cleaned || undefined;
}

const folderKey = (name: string) => `folder:${name.toLowerCase()}`;

export function categoryLabel(category: string): string {
    return category.replace(/_/g, ' ');
}

/** Chips sorted by label: folders first (the user's own sorting), then categories. */
export function buildLoreFilterChips(chunks: LoreChunk[]): LoreFilterChip[] {
    const folders = new Map<string, LoreFilterChip>();
    const categories = new Map<string, LoreFilterChip>();
    for (const chunk of chunks) {
        const folder = cleanFolder(chunk.folder);
        if (folder) {
            const key = folderKey(folder);
            const chip = folders.get(key);
            if (chip) chip.count++;
            else folders.set(key, { key, kind: 'folder', label: folder, count: 1 });
        }
        const category = chunk.category || 'misc';
        const key = `category:${category}`;
        const chip = categories.get(key);
        if (chip) chip.count++;
        else categories.set(key, { key, kind: 'category', label: categoryLabel(category), count: 1 });
    }
    const byLabel = (a: LoreFilterChip, b: LoreFilterChip) => a.label.localeCompare(b.label);
    return [...[...folders.values()].sort(byLabel), ...[...categories.values()].sort(byLabel)];
}

export function matchesLoreFilter(chunk: LoreChunk, key: string | null): boolean {
    if (!key) return true;
    if (key.startsWith('category:')) return (chunk.category || 'misc') === key.slice('category:'.length);
    const folder = cleanFolder(chunk.folder);
    return !!folder && folderKey(folder) === key;
}

/** Distinct folder names in use, for the editor's suggestions. */
export function folderNames(chunks: LoreChunk[]): string[] {
    return buildLoreFilterChips(chunks).filter(c => c.kind === 'folder').map(c => c.label);
}
