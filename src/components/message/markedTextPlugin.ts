/**
 * Marks quoted and bracketed story text in parsed Markdown so each kind can be
 * coloured (Settings → Story Text → Text colours). Display-only: stored text
 * is untouched. Bold and italic need no help here — Markdown already made them
 * <strong>/<em>, coloured straight from CSS.
 *
 * Kinds:
 *  - dialogue  "…" “…” „…“ «…» 「…」 『…』
 *  - single    '…' ‘…’
 *  - bracket   […]
 *
 * Quotes are not Markdown, so each paragraph's text is read as one string in
 * reading order — `"I told **you**!"` is one line of dialogue spread over three
 * nodes — the ranges are found on that string, then each text node is split
 * and the coloured runs wrapped in `<span class="story-…">`, nested inside any
 * bold/italic so the quote colour wins while bold keeps its weight. Where kinds
 * overlap the innermost wins (`"Go to [the gate]"` keeps the bracket colour).
 *
 * Rules that keep sloppy or ambiguous text from colouring too much:
 *  - Everything resets at each paragraph, heading and table cell.
 *  - An unclosed "…" colours to the end of its paragraph (speech running over
 *    several paragraphs, or text still streaming in). Unclosed '…' and […]
 *    colour nothing: a stray apostrophe or bracket is far more likely.
 *  - A single quote opens only after a space, line start or opening
 *    punctuation, and closes only before a space, punctuation or the end, so
 *    don't, Mara's and rock'n'roll never count.
 *  - A straight `"` right after a digit (6'2") is a measurement.
 *  - `[Name]`, which the app already shows as a bold name without brackets
 *    (inlineNameBracketsPlugin), still counts as bracketed text.
 *  - Code, inline code, raw HTML and images are never touched.
 */

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; data?: Record<string, unknown> };

export type MarkedKind = 'dialogue' | 'single' | 'bracket';
export type MarkedKinds = Partial<Record<MarkedKind, boolean>>;

export const MARKED_CLASS: Record<MarkedKind, string> = {
    dialogue: 'story-dialogue',
    single: 'story-single-quote',
    bracket: 'story-bracket',
};

/** Set by inlineNameBracketsPlugin on the bold it makes from `[Name]`. */
export const BRACKET_NAME_FLAG = 'storyBracketName';

/** Opening mark → the marks that close it. */
const DOUBLE_CLOSERS: Record<string, string> = {
    '"': '"',
    '“': '”', // “ ”
    '„': '“”', // „ “ (German) or „ ” (Polish)
    '«': '»', // « »  (» alone is not an opener: it doubles as an arrow)
    '「': '」', // 「 」
    '『': '』', // 『 』
};

const SKIP = new Set(['code', 'inlineCode', 'html', 'image', 'imageReference', 'definition', 'math', 'inlineMath']);
const BLOCKS = new Set(['paragraph', 'heading', 'tableCell']);

type Range = { start: number; end: number; kind: MarkedKind };

function doubleQuoteRanges(s: string): Range[] {
    const out: Range[] = [];
    let open = -1;
    let closer = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (open >= 0) {
            if (closer.includes(ch)) { out.push({ start: open, end: i + 1, kind: 'dialogue' }); open = -1; }
            continue;
        }
        const c = DOUBLE_CLOSERS[ch];
        if (!c || (ch === '"' && i > 0 && /\d/.test(s[i - 1]))) continue;
        open = i;
        closer = c;
    }
    if (open >= 0) out.push({ start: open, end: s.length, kind: 'dialogue' });
    return out;
}

const SINGLE_OPEN_BEFORE = /[\s([{"“„«—–-]/;
const SINGLE_CLOSE_AFTER = /[\s.,;:!?)\]}"”»—–-]/;

function singleQuoteRanges(s: string): Range[] {
    const out: Range[] = [];
    let open = -1;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch !== "'" && ch !== '‘' && ch !== '’') continue;
        const before = i === 0 ? ' ' : s[i - 1];
        const after = i + 1 >= s.length ? ' ' : s[i + 1];
        const canOpen = ch !== '’' && SINGLE_OPEN_BEFORE.test(before) && !/\s/.test(after);
        const canClose = ch !== '‘' && !/\s/.test(before) && SINGLE_CLOSE_AFTER.test(after);
        // A second opener restarts: same-mark quotes do not nest, and the
        // first was more likely a stray ('Tis, 'em) than an outer quote.
        if (canOpen) open = i;
        else if (canClose && open >= 0) { out.push({ start: open, end: i + 1, kind: 'single' }); open = -1; }
    }
    return out;
}

function bracketRanges(s: string): Range[] {
    const out: Range[] = [];
    const stack: number[] = [];
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '[') stack.push(i);
        else if (s[i] === ']' && stack.length) out.push({ start: stack.pop()!, end: i + 1, kind: 'bracket' });
    }
    return out;
}

/** Per-character kind; longer ranges paint first so the innermost wins. */
export function markKinds(s: string, kinds: MarkedKinds): (MarkedKind | null)[] {
    const ranges = [
        ...(kinds.dialogue ? doubleQuoteRanges(s) : []),
        ...(kinds.single ? singleQuoteRanges(s) : []),
        ...(kinds.bracket ? bracketRanges(s) : []),
    ].sort((a, b) => (b.end - b.start) - (a.end - a.start));
    const marks: (MarkedKind | null)[] = new Array(s.length).fill(null);
    for (const r of ranges) marks.fill(r.kind, r.start, r.end);
    return marks;
}

function wrap(kind: MarkedKind, value: string): MarkdownNode {
    return {
        type: 'storyMarked',
        data: { hName: 'span', hProperties: { className: [MARKED_CLASS[kind]] } },
        children: [{ type: 'text', value }],
    };
}

function markBlock(block: MarkdownNode, kinds: MarkedKinds): void {
    // Pass 1: the paragraph as one string, remembering where each text node starts.
    let text = '';
    const offsets = new Map<MarkdownNode, number>();
    const gather = (node: MarkdownNode) => {
        for (const child of node.children ?? []) {
            if (child.type === 'text' && child.value) { offsets.set(child, text.length); text += child.value; continue; }
            if (SKIP.has(child.type)) { text += '￼'; continue; } // an opaque, non-matching stand-in
            const bracketName = child.data?.[BRACKET_NAME_FLAG] === true;
            if (bracketName) text += '[';
            gather(child);
            if (bracketName) text += ']';
        }
    };
    gather(block);
    if (!text) return;
    const marks = markKinds(text, kinds);
    if (!marks.some(Boolean)) return;

    // Pass 2: split each text node into runs of one kind.
    const split = (node: MarkdownNode) => {
        if (!node.children) return;
        node.children = node.children.flatMap(child => {
            const start = offsets.get(child);
            if (start === undefined) {
                if (!SKIP.has(child.type)) split(child);
                return [child];
            }
            const value = child.value!;
            const parts: MarkdownNode[] = [];
            let runStart = 0;
            for (let i = 1; i <= value.length; i++) {
                if (i < value.length && marks[start + i] === marks[start + runStart]) continue;
                const piece = value.slice(runStart, i);
                const kind = marks[start + runStart];
                parts.push(kind ? wrap(kind, piece) : { type: 'text', value: piece });
                runStart = i;
            }
            return parts;
        });
    };
    split(block);
}

function walkBlocks(node: MarkdownNode, kinds: MarkedKinds): void {
    if (SKIP.has(node.type) || !node.children) return;
    if (BLOCKS.has(node.type)) { markBlock(node, kinds); return; }
    for (const child of node.children) walkBlocks(child, kinds);
}

/** Remark plugin factory; only the kinds passed in are marked. */
export function markedTextPlugin(kinds: MarkedKinds) {
    return () => (tree: MarkdownNode) => walkBlocks(tree, kinds);
}
