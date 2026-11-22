/**
 * Marks quoted dialogue in parsed Markdown so it can be coloured
 * (Settings → Story Text → Text colours). Display-only: stored text is untouched.
 *
 * Quotes are not Markdown, so this walks each paragraph's text in reading order
 * and keeps an "inside a quote" state across bold, italic and name links:
 * `"I told **you**!"` is one line of dialogue spread over three nodes. Each run
 * of quoted text is wrapped in `<span class="story-dialogue">`, nested inside
 * any bold/italic, so the dialogue colour wins and bold keeps its weight.
 *
 * Rules that keep a model's sloppy quoting from colouring a whole message:
 *  - State resets at every paragraph, heading and table cell. An unclosed
 *    quote colours to the end of its paragraph only. That is also right for
 *    speech running over several paragraphs (each opens without closing) and
 *    for text still streaming in.
 *  - Single quotes are ignored: they are almost always apostrophes.
 *  - A straight `"` right after a digit (6'2") is a measurement, not an opener.
 *  - Code, inline code and raw HTML are never touched.
 */

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; data?: Record<string, unknown> };

/** Opening mark → the marks that close it. */
const CLOSERS: Record<string, string> = {
    '"': '"',
    '“': '”', // “ ”
    '„': '“”', // „ “ (German) or „ ” (Polish)
    '«': '»', // « »  (» alone is not an opener: it doubles as an arrow)
    '「': '」', // 「 」
    '『': '』', // 『 』
};

const SKIP = new Set(['code', 'inlineCode', 'html', 'image', 'imageReference', 'definition', 'math', 'inlineMath']);
const BLOCKS = new Set(['paragraph', 'heading', 'tableCell']);

export const DIALOGUE_CLASS = 'story-dialogue';

function dialogueNode(value: string): MarkdownNode {
    return {
        type: 'storyDialogue',
        data: { hName: 'span', hProperties: { className: [DIALOGUE_CLASS] } },
        children: [{ type: 'text', value }],
    };
}

type QuoteState = { closer: string | null };

function splitText(value: string, state: QuoteState): MarkdownNode[] {
    const out: MarkdownNode[] = [];
    let start = 0;
    let inside = state.closer !== null;
    const flush = (end: number, quoted: boolean) => {
        if (end <= start) return;
        const piece = value.slice(start, end);
        out.push(quoted ? dialogueNode(piece) : { type: 'text', value: piece });
        start = end;
    };
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if (state.closer !== null) {
            if (state.closer.includes(ch)) {
                flush(i + 1, true); // the closing mark is part of the dialogue
                state.closer = null;
                inside = false;
            }
            continue;
        }
        const closer = CLOSERS[ch];
        if (!closer) continue;
        if (ch === '"' && i > 0 && /\d/.test(value[i - 1])) continue;
        flush(i, false);
        state.closer = closer;
        inside = true;
    }
    flush(value.length, inside);
    return out;
}

function walkInline(node: MarkdownNode, state: QuoteState): void {
    if (!node.children) return;
    node.children = node.children.flatMap(child => {
        if (child.type === 'text' && child.value) return splitText(child.value, state);
        if (!SKIP.has(child.type)) walkInline(child, state);
        return [child];
    });
}

function walkBlocks(node: MarkdownNode): void {
    if (SKIP.has(node.type) || !node.children) return;
    if (BLOCKS.has(node.type)) {
        walkInline(node, { closer: null });
        return;
    }
    for (const child of node.children) walkBlocks(child);
}

export function dialoguePlugin() {
    return (tree: MarkdownNode) => walkBlocks(tree);
}
