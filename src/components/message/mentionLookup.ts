import type { GlossaryEntry, LocationEntry, NPCEntry } from '../../types';

export type MentionEntry = {
    id: string;
    name: string;
    category: string;
    description?: string;
    image?: string;
    portrait?: boolean;
};

export type MentionLookup = {
    re: RegExp;
    entries: Map<string, MentionEntry>;
    names: Map<string, string>;
};

/** Canonical names beat aliases, which beat inferred NPC first names.
 * Equally strong ambiguous names are left as prose rather than showing the wrong entry. */
export function buildMentionLookup(npcs: NPCEntry[], locations: LocationEntry[], glossary: GlossaryEntry[]): MentionLookup | null {
    const entries = new Map<string, MentionEntry>();
    const candidates = new Map<string, { id: string | null; priority: number }>();
    const addName = (name: string, id: string, priority: number) => {
        const key = name.trim().toLowerCase();
        if (!key) return;
        const previous = candidates.get(key);
        if (!previous || priority > previous.priority) candidates.set(key, { id, priority });
        else if (priority === previous.priority && previous.id !== id) candidates.set(key, { id: null, priority });
    };
    const add = (entry: MentionEntry, aliases: string, firstName?: string) => {
        if (!entry.name.trim()) return;
        entries.set(encodeURIComponent(entry.id), entry);
        addName(entry.name, entry.id, 3);
        for (const alias of aliases.split(',')) addName(alias, entry.id, 2);
        if (firstName && firstName.length >= 3) addName(firstName, entry.id, 1);
    };
    for (const npc of npcs) {
        if (npc.archived) continue;
        add({ id: `npc-${npc.id}`, name: npc.name, category: 'NPC', description: npc.appearance, image: npc.portrait, portrait: true }, npc.aliases ?? '', npc.name.split(/\s+/)[0]);
    }
    for (const location of locations) {
        if (location.knowledge === 'secret') continue;
        add({ id: `location-${location.id}`, name: location.name, category: 'Location', description: location.description, image: location.image }, location.aliases ?? '');
    }
    for (const item of glossary) {
        add({ id: `glossary-${item.id}`, name: item.name, category: item.category || 'Glossary', description: item.description, image: item.image }, item.aliases);
    }
    const names = new Map([...candidates].flatMap(([name, value]) => value.id ? [[name, value.id] as const] : []));
    const escaped = [...names.keys()].sort((a, b) => b.length - a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!escaped.length) return null;
    return { entries, names, re: new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])(${escaped.join('|')})(?![\\p{L}\\p{N}\\p{M}_])`, 'giu') };
}

// Work on parsed Markdown text nodes so links, images, code, and URLs stay intact.
type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };
export const MENTION_PREFIX = '#story-mention-';
function transformText(node: MarkdownNode, transform: (value: string) => MarkdownNode[]): void {
    if (['link', 'linkReference', 'image', 'imageReference', 'code', 'inlineCode', 'html', 'definition'].includes(node.type) || !node.children) return;
    node.children = node.children.flatMap(child => {
        if (child.type === 'text' && child.value) return transform(child.value);
        transformText(child, transform);
        return [child];
    });
}

/** Preserve the legacy [NPC Name] → bold display convention after parsing,
 * so bracketed names inside code or reference links cannot damage Markdown. */
export function inlineNameBracketsPlugin() {
    return (tree: MarkdownNode) => {
        // [**Name**] is already split into three nodes by the Markdown parser.
        const unwrapBold = (node: MarkdownNode) => {
            if (['link', 'linkReference', 'image', 'imageReference', 'code', 'inlineCode', 'html', 'definition'].includes(node.type) || !node.children) return;
            const children = node.children;
            for (let i = 1; i < children.length - 1; i++) {
                const [before, bold, after] = [children[i - 1], children[i], children[i + 1]];
                const name = bold.children?.map(child => child.value ?? '').join('') ?? '';
                if (before.type === 'text' && /\[\s*$/.test(before.value ?? '') && bold.type === 'strong' && after.type === 'text' && /^\s*\]/.test(after.value ?? '') && /^[A-Za-z][A-Za-z0-9 _.'-]*[A-Za-z0-9.]$/.test(name) && !['SURPRISE', 'ENCOUNTER', 'WORLD_EVENT'].some(tag => name.includes(tag))) {
                    before.value = before.value!.replace(/\[\s*$/, '');
                    after.value = after.value!.replace(/^\s*\]/, '');
                }
            }
            for (const child of children) unwrapBold(child);
        };
        unwrapBold(tree);
        transformText(tree, value => {
            const parts: MarkdownNode[] = [];
            let end = 0;
            const brackets = /\[\s*([A-Za-z][A-Za-z0-9 _.'-]*[A-Za-z0-9.])\s*\]/g;
            for (const match of value.matchAll(brackets)) {
                if (['SURPRISE', 'ENCOUNTER', 'WORLD_EVENT'].some(tag => match[1].includes(tag))) continue;
                const start = match.index!;
                if (start > end) parts.push({ type: 'text', value: value.slice(end, start) });
                parts.push({ type: 'strong', children: [{ type: 'text', value: match[1].trim() }] });
                end = start + match[0].length;
            }
            if (!end) return [{ type: 'text', value }];
            if (end < value.length) parts.push({ type: 'text', value: value.slice(end) });
            return parts;
        });
    };
}

export function mentionPlugin(lookup: MentionLookup | null) {
    return () => (tree: MarkdownNode) => {
        if (!lookup) return;
        transformText(tree, value => {
            const parts: MarkdownNode[] = [];
            let end = 0;
            for (const match of value.matchAll(lookup.re)) {
                const id = lookup.names.get(match[0].toLowerCase());
                if (!id) continue;
                const start = match.index!;
                if (start > end) parts.push({ type: 'text', value: value.slice(end, start) });
                parts.push({ type: 'link', url: MENTION_PREFIX + encodeURIComponent(id), children: [{ type: 'text', value: match[0] }] });
                end = start + match[0].length;
            }
            if (!end) return [{ type: 'text', value }];
            if (end < value.length) parts.push({ type: 'text', value: value.slice(end) });
            return parts;
        });
    };
}
