import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { NPCEntry, LocationEntry } from '../../types';
import { useAppStore } from '../../store/useAppStore';

// WO-J: NPC names arrive wrapped in [Name] / [**Name**] brackets so the ledger detector
// can read them out of the raw content. Render them as inline **bold** markdown instead of
// literal bracketed text, so the name flows inside the surrounding paragraph. The brackets
// only live in the display copy; the raw stored content the detector reads is untouched.
const NAME_BRACKET_RE = /\[\*{0,2}\s*([A-Za-z][A-Za-z0-9 _.'-]*[A-Za-z0-9.])\s*\*{0,2}\](?!\()/g;

function looksLikeSystemTag(s: string): boolean {
    return s.includes(':') || s.includes('SURPRISE') || s.includes('ENCOUNTER') || s.includes('WORLD_EVENT');
}

function inlineNameBrackets(text: string): string {
    return text.replace(/<!--\s*MOVEMENT\b[\s\S]*?(?:-->|$)/gi, '').replace(NAME_BRACKET_RE, (full, inner: string) =>
        looksLikeSystemTag(inner) ? full : `**${inner.trim()}**`
    );
}

// ── NPC and location hover-thumbnail wiring ──────────────────────────────────────────────
// Wrap known NPC and location names (by name + alias, case-insensitive, whole-word) in
// markdown link syntax `[Name](#npc-p-{id})` so react-markdown parses them. The
// custom `a` renderer below turns those sentinel-href links into hover thumbnails
// instead of real anchors. We split on code fences / inline code / existing links
// to avoid mangling code or nested links.
type NameLookup = {
    re: RegExp;
    entries: Map<string, { id: string; name: string; portrait: string; description?: string; isLocation?: boolean }>;
    nameToId: Map<string, string>;
};

function buildNameLookup(npcs: NPCEntry[], locations: LocationEntry[]): NameLookup | null {
    const ledger: Array<Pick<NPCEntry, 'id' | 'name' | 'aliases' | 'portrait' | 'archived'> & { description?: string; isLocation?: boolean }> = [
        ...npcs.map(npc => ({ ...npc, id: 'npc-' + encodeURIComponent(npc.id) })),
        ...locations.map(location => ({ id: 'location-' + encodeURIComponent(location.id), name: location.name, aliases: location.aliases, portrait: location.image, description: location.description, isLocation: true })),
    ];
    const withPortrait = ledger.filter(n => n.portrait && !n.archived);
    if (withPortrait.length === 0) return null;

    const entries = new Map<string, { id: string; name: string; portrait: string; description?: string; isLocation?: boolean }>();
    const nameToId = new Map<string, string>();
    for (const npc of withPortrait) {
        entries.set(npc.id, { id: npc.id, name: npc.name, portrait: npc.portrait!, description: npc.description, isLocation: npc.isLocation });
        const explicitVariants = [npc.name, ...(npc.aliases ? npc.aliases.split(',').map(s => s.trim()).filter(Boolean) : [])];
        // Auto-index the first token of multi-word names (e.g. "Rin" from "Rin Holmes")
        // so recurring NPCs get highlighted by their first name in prose. Skip tokens
        // shorter than 3 chars to limit false-positive common-word matches.
        const firstName = npc.name.split(/\s+/)[0]?.trim();
        const autoVariants = !npc.isLocation && firstName && firstName.length >= 3 ? [firstName] : [];
        const variants = [...explicitVariants, ...autoVariants];
        for (const v of variants) {
            const key = v.toLowerCase();
            // Longer names win — only set if not already present (we sort names desc below).
            if (v && !nameToId.has(key)) nameToId.set(key, npc.id);
        }
    }
    // Sort names by length descending so "Captain Aldric" matches before "Aldric".
    const names = [...nameToId.keys()].sort((a, b) => b.length - a.length);
    if (names.length === 0) return null;
    const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    // Lookbehind/lookahead on a non-letter boundary. Chromium (Electron) supports lookbehind.
    const re = new RegExp(`(?<![A-Za-z])(${escaped.join('|')})(?![A-Za-z])`, 'gi');
    return { re, entries, nameToId };
}

function wrapNames(text: string, lookup: NameLookup): string {
    const replaceInSegment = (s: string) =>
        s.replace(lookup.re, (_full, name: string) => {
            const id = lookup.nameToId.get(name.toLowerCase());
            if (!id) return name;
            return `[${name}](#npc-p-${id})`;
        });

    // Split out fenced code blocks (```...```) — don't touch their contents.
    return text.split(/(```[\s\S]*?```)/g).map((segment, i) => {
        if (i % 2 === 1) return segment; // inside a code fence
        // Split out inline code (`...`) — don't touch.
        return segment.split(/(`[^`]+`)/g).map((seg2, j) => {
            if (j % 2 === 1) return seg2; // inside inline code
            // Split out existing markdown links [text](url) — don't touch.
            return seg2.split(/(\[[^\]]*\]\([^)]*\))/g).map((seg3, k) => {
                if (k % 2 === 1) return seg3; // inside an existing link
                return replaceInSegment(seg3);
            }).join('');
        }).join('');
    }).join('');
}

/**
 * Message prose renderer — markdown with NPC and location previews:
 * bracket names inlined to bold, ledger names wrapped as hover-thumbnail chips.
 * Reads both ledgers from the store directly (no prop threading needed).
 */
export function MessageMarkdown({ content }: { content: string }) {
    const npcLedger = useAppStore(s => s.npcLedger);
    const locationLedger = useAppStore(s => s.locationLedger);
    const nameLookup = useMemo(() => buildNameLookup(npcLedger, locationLedger), [npcLedger, locationLedger]);

    // react-markdown custom `a` renderer: sentinel-href NPC links become hover chips.
    const mdComponents = useMemo(() => ({
        a: ({ href, children }: { href?: string; children?: ReactNode }) => {
            if (!href || !href.startsWith('#npc-p-')) {
                // Default anchor rendering for real links.
                return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
            }
            const id = href.slice('#npc-p-'.length);
            const npc = nameLookup?.entries.get(id);
            if (!npc) return <>{children}</>;
            if (npc.isLocation) return <LocationNameChip name={npc.name} image={npc.portrait} description={npc.description}>{children}</LocationNameChip>;
            return <NpcNameChip name={npc.name} portrait={npc.portrait}>{children}</NpcNameChip>;
        },
    }), [nameLookup]);

    let out = inlineNameBrackets(content);
    if (nameLookup) out = wrapNames(out, nameLookup);
    return <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{out}</ReactMarkdown>;
}

/**
 * Inline NPC-name chip that shows a reduced portrait thumbnail on hover.
 * Renders as bold-styled text (matching the bracket→**bold** display transform);
 * hovering reveals a small 96px portrait card. Purely display — the name stays
 * in the document flow and is selectable.
 */
function NpcNameChip({ name, portrait, children }: { name: string; portrait: string; children: ReactNode }) {
    return (
        <span className="relative inline-block group/npc text-terminal font-bold cursor-help">
            {children}
            <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-50 opacity-0 group-hover/npc:opacity-100 transition-opacity duration-150">
                <span className="block bg-void-darker border border-terminal/40 rounded shadow-lg p-1 w-[96px]">
                    <img
                        src={portrait}
                        alt={name}
                        className="w-full aspect-[3/4] object-cover object-top rounded"
                        loading="lazy"
                        draggable={false}
                    />
                    <span className="block text-[9px] text-center text-text-dim uppercase tracking-wider truncate mt-0.5">{name}</span>
                </span>
            </span>
        </span>
    );
}

function LocationNameChip({ name, image, description, children }: { name: string; image: string; description?: string; children: ReactNode }) {
    return (
        <span tabIndex={0} className="relative inline-block group/location text-terminal font-bold cursor-help outline-offset-2">
            {children}
            <span className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-1 z-50 opacity-0 group-hover/location:opacity-100 group-focus/location:opacity-100 transition-opacity duration-150">
                <span className="block bg-void-darker border border-terminal/40 rounded shadow-lg p-2 w-64 max-w-[80vw]">
                    <img src={image} alt={name} className="w-full aspect-video object-contain rounded" loading="lazy" draggable={false} />
                    <span className="block text-xs text-terminal mt-1">{name}</span>
                    {description && <span className="block text-[11px] font-normal text-text-dim leading-relaxed mt-1 whitespace-normal line-clamp-4">{description}</span>}
                </span>
            </span>
        </span>
    );
}
