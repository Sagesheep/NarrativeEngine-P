import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { GlossaryEntry } from '../../types';
import { buildMentionLookup, mentionPlugin, inlineNameBracketsPlugin, MENTION_PREFIX } from './mentionLookup';
import { MentionPreview } from './MentionPreview';
import { markedTextPlugin } from './markedTextPlugin';
import { useAppStore } from '../../store/useAppStore';

const EMPTY_GLOSSARY: GlossaryEntry[] = [];

/**
 * A line like `[**Marlow**]: "Brant."` has the shape of a Markdown link
 * reference definition, which the parser consumes and never renders, so the
 * line vanished. Story text never means one: escape the opening bracket so the
 * line renders as text. Lines inside fenced code blocks are left alone.
 */
export function escapeLinkDefinitions(text: string): string {
    let fence: string | null = null;
    return text.split('\n').map(line => {
        const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (open) {
            if (!fence) fence = open[1];
            else if (open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
            return line;
        }
        if (fence) return line;
        return line.replace(/^((?: {0,3}>)*[ \t]{0,3})\[(?=[^\]]*\]:)/, '$1\\[');
    }).join('\n');
}

/** Shared, display-only name matching; stored story text is never rewritten. */
export function MessageMarkdown({ content }: { content: string }) {
    const npcLedger = useAppStore(s => s.npcLedger);
    const locationLedger = useAppStore(s => s.locationLedger);
    const glossary = useAppStore(s => s.context.glossary ?? EMPTY_GLOSSARY);
    // Quotes and brackets are only marked up for the kinds the player picked a
    // colour for, so the default render is unchanged. Runs last: name links
    // inside a quote are already links, and the quote colour wraps their text.
    const dialogue = useAppStore(s => !!s.settings.storyTextColors?.dialogue);
    const single = useAppStore(s => !!s.settings.storyTextColors?.singleQuote);
    const bracket = useAppStore(s => !!s.settings.storyTextColors?.bracket);
    const lookup = useMemo(() => buildMentionLookup(npcLedger, locationLedger, glossary), [npcLedger, locationLedger, glossary]);
    const plugins = useMemo(
        () => [
            remarkGfm, inlineNameBracketsPlugin, mentionPlugin(lookup),
            ...(dialogue || single || bracket ? [markedTextPlugin({ dialogue, single, bracket })] : []),
        ],
        [lookup, dialogue, single, bracket],
    );
    const components = useMemo(() => ({
        a: ({ href, children }: { href?: string; children?: ReactNode }) => {
            const entry = href?.startsWith(MENTION_PREFIX)
                ? lookup?.entries.get(href.slice(MENTION_PREFIX.length))
                : undefined;
            if (entry) return <MentionPreview key={entry.id} entry={entry}>{children}</MentionPreview>;
            return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
        },
    }), [lookup]);
    return <ReactMarkdown remarkPlugins={plugins} components={components}>{escapeLinkDefinitions(content.replace(/<!--\s*MOVEMENT\b[\s\S]*?(?:-->|$)/gi, ''))}</ReactMarkdown>;
}
