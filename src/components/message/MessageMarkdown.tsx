import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { GlossaryEntry } from '../../types';
import { buildMentionLookup, mentionPlugin, inlineNameBracketsPlugin, MENTION_PREFIX } from './mentionLookup';
import { MentionPreview } from './MentionPreview';
import { useAppStore } from '../../store/useAppStore';

const EMPTY_GLOSSARY: GlossaryEntry[] = [];

/** Shared, display-only name matching; stored story text is never rewritten. */
export function MessageMarkdown({ content }: { content: string }) {
    const npcLedger = useAppStore(s => s.npcLedger);
    const locationLedger = useAppStore(s => s.locationLedger);
    const glossary = useAppStore(s => s.context.glossary ?? EMPTY_GLOSSARY);
    const lookup = useMemo(() => buildMentionLookup(npcLedger, locationLedger, glossary), [npcLedger, locationLedger, glossary]);
    const plugins = useMemo(() => [remarkGfm, inlineNameBracketsPlugin, mentionPlugin(lookup)], [lookup]);
    const components = useMemo(() => ({
        a: ({ href, children }: { href?: string; children?: ReactNode }) => {
            const entry = href?.startsWith(MENTION_PREFIX)
                ? lookup?.entries.get(href.slice(MENTION_PREFIX.length))
                : undefined;
            if (entry) return <MentionPreview key={entry.id} entry={entry}>{children}</MentionPreview>;
            return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
        },
    }), [lookup]);
    return <ReactMarkdown remarkPlugins={plugins} components={components}>{content.replace(/<!--\s*MOVEMENT\b[\s\S]*?(?:-->|$)/gi, '')}</ReactMarkdown>;
}
