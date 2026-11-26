/**
 * Books — the level above chapters. A book is a run of sealed chapters with its
 * own summary, written from the chapter summaries (never raw scenes), so closing
 * one is a small AI call. Books are contiguous from the first scene: the next
 * book always starts at the first sealed chapter after the last book.
 *
 * Ported from NarrativeEngine-M. The recap is what books are for on desktop:
 * a 100-chapter campaign renders a handful of books plus the loose chapters
 * instead of a line per chapter. Recall stays on the scene vectors, so the
 * mobile book-shortlist step is not carried over.
 *
 * Pure except for the summarizer/proposer LLM calls; persistence lives in
 * bookService.ts.
 */
import type { ArchiveBook, ArchiveChapter, EndpointConfig, ProviderConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';

/** A book closes by itself once this many sealed chapters sit outside any book. */
export const BOOK_AUTO_CLOSE_CHAPTERS = 10;

/** How many of the newest books render as their full summary in the recap. */
export const RECAP_SUMMARY_BOOKS = 2;

type Provider = ProviderConfig | EndpointConfig;

const sceneNum = (id: string) => parseInt(id, 10);
const byStart = (a: { sceneRange: [string, string] }, b: { sceneRange: [string, string] }) =>
    sceneNum(a.sceneRange[0]) - sceneNum(b.sceneRange[0]);

export function nextBookId(books: ArchiveBook[]): string {
    let max = 0;
    for (const b of books) {
        const m = /^BK(\d+)/.exec(b.bookId);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `BK${String(max + 1).padStart(2, '0')}`;
}

/** The book a chapter belongs to: the one whose range holds its first scene. */
export function bookOf(chapter: { sceneRange: [string, string] }, books: ArchiveBook[]): ArchiveBook | undefined {
    const start = sceneNum(chapter.sceneRange[0]);
    return books.find(b => start >= sceneNum(b.sceneRange[0]) && start <= sceneNum(b.sceneRange[1]));
}

export function chaptersInBook(book: ArchiveBook, chapters: ArchiveChapter[]): ArchiveChapter[] {
    return chapters.filter(c => bookOf(c, [book]) !== undefined).sort(byStart);
}

/** Sealed chapters after the last book, oldest first — the next book's candidates. */
export function unbookedSealed(chapters: ArchiveChapter[], books: ArchiveBook[]): ArchiveChapter[] {
    const lastEnd = books.reduce((m, b) => Math.max(m, sceneNum(b.sceneRange[1])), 0);
    return chapters.filter(c => c.sealedAt && sceneNum(c.sceneRange[0]) > lastEnd).sort(byStart);
}

/**
 * Drop books that no longer match the chapters: a book with no chapters left (a
 * rollback or restore removed them), or one holding the chapter that is taking
 * new scenes (a rollback reopened it, so the book would keep growing). Later
 * books go with it, so books stay contiguous. An old chapter reopened by a single
 * scene delete does not dissolve its book.
 */
export function reconcileBooks(books: ArchiveBook[], chapters: ArchiveChapter[]): ArchiveBook[] {
    if (books.length === 0) return books;
    const ordered = [...books].sort(byStart);
    const growing = chapters.filter(c => !c.sealedAt).sort(byStart).pop();
    const kept: ArchiveBook[] = [];
    for (const book of ordered) {
        if (chaptersInBook(book, chapters).length === 0) break;
        if (growing && bookOf(growing, [book])) break;
        kept.push(book);
    }
    return kept.length === books.length ? books : kept;
}

export type BookSummary = Pick<ArchiveBook, 'title' | 'summary' | 'keywords' | 'npcs' | 'majorEvents' | 'unresolvedThreads'>;

function uniq(xs: string[]): string[] {
    return Array.from(new Set(xs.map(x => x.trim()).filter(Boolean)));
}

/** Build a book record over `chapters` (oldest first, all sealed). */
export function makeBook(books: ArchiveBook[], chapters: ArchiveChapter[], summary: BookSummary | null, era?: string): ArchiveBook {
    const sorted = [...chapters].sort(byStart);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const fallback: BookSummary = {
        title: `${first.title} – ${last.title}`,
        summary: sorted.map(c => `${c.chapterId} ${c.title}.`).join(' '),
        keywords: [],
        npcs: uniq(sorted.flatMap(c => c.npcs ?? [])).slice(0, 20),
        majorEvents: [],
        unresolvedThreads: last.unresolvedThreads ?? [],
    };
    return {
        bookId: nextBookId(books),
        sceneRange: [first.sceneRange[0], last.sceneRange[1]],
        ...(era?.trim() ? { era: era.trim() } : {}),
        ...(summary ?? fallback),
        createdAt: Date.now(),
        ...(summary ? {} : { summaryPending: true }),
    };
}

/** Strip think blocks and fences, then parse the outermost JSON object. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
    const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function chapterBlock(c: ArchiveChapter): string {
    const summary = typeof c.summary === 'string' ? c.summary.trim() : '';
    const events = (c.majorEvents ?? []).slice(0, 8).join('; ');
    const threads = (c.unresolvedThreads ?? []).join('; ');
    return [
        `${c.chapterId} [scenes ${c.sceneRange[0]}-${c.sceneRange[1]}] "${c.title}"`,
        summary || c.synopsis || '(no summary recorded)',
        events ? `Events: ${events}` : '',
        threads ? `Open threads: ${threads}` : '',
    ].filter(Boolean).join('\n');
}

export function buildBookSummaryPrompt(chapters: ArchiveChapter[], era?: string): string {
    const sorted = [...chapters].sort(byStart);
    return [
        'You are a TTRPG campaign archivist. Several chapters of a long campaign are being bound into one BOOK. Write the book\'s summary from the chapter summaries below.',
        '',
        'OUTPUT FORMAT — a single JSON object:',
        '{',
        '  "title": "2-5 word evocative book title",',
        '  "summary": "150-250 words: the arc of this book as a story — where it started, the turning points, how it ended, and how the main relationships changed",',
        '  "keywords": ["distinctive places, factions, artifacts, concepts"],',
        '  "npcs": ["every named character who mattered in this book"],',
        '  "majorEvents": ["8-12 plot-critical beats, oldest first"],',
        '  "unresolvedThreads": ["hooks still open at the END of the book — leave out ones a later chapter settled"]',
        '}',
        '',
        'Write for a GM who will read only this summary to recall the book. Concrete names and outcomes over mood.',
        'Output ONLY the JSON object — no prose, no markdown fences.',
        '',
        era?.trim() ? `ERA: ${era.trim()}\n` : '',
        `CHAPTERS (oldest first):\n\n${sorted.map(chapterBlock).join('\n\n')}`,
    ].join('\n');
}

export function parseBookSummary(raw: string, chapters: ArchiveChapter[]): BookSummary | null {
    const value = parseJsonObject(raw);
    if (!value) return null;
    const sorted = [...chapters].sort(byStart);
    const str = (v: unknown) => typeof v === 'string' ? v.trim() : '';
    const list = (v: unknown) => Array.isArray(v) ? uniq(v.filter((x): x is string => typeof x === 'string')) : [];
    const summary = str(value.summary);
    if (!summary) return null;
    return {
        title: str(value.title) || `${sorted[0].title} – ${sorted[sorted.length - 1].title}`,
        summary,
        keywords: list(value.keywords),
        npcs: list(value.npcs),
        majorEvents: list(value.majorEvents),
        unresolvedThreads: list(value.unresolvedThreads),
    };
}

/** Write a book summary from its chapters' summaries. Null on any failure. */
export async function summarizeBook(provider: Provider, chapters: ArchiveChapter[], era?: string): Promise<BookSummary | null> {
    if (chapters.length === 0) return null;
    try {
        const raw = await llmCall(provider, buildBookSummaryPrompt(chapters, era), {
            priority: 'low',
            temperature: 0.3,
            maxTokens: 3000,
            trackingLabel: 'book-summary',
            timeoutMs: AI_CALL_TIMEOUT_MS,
        });
        return parseBookSummary(raw, chapters);
    } catch (e) {
        console.warn('[Books] Summary failed:', e);
        return null;
    }
}

/**
 * "Build Books": where should existing chapters be split into books? Returns the
 * chapter ids that END a book, in order; every group is at most
 * BOOK_AUTO_CLOSE_CHAPTERS long. Falls back to fixed groups of that size.
 */
export async function proposeBookBreaks(provider: Provider | undefined, chapters: ArchiveChapter[]): Promise<string[]> {
    const sorted = [...chapters].filter(c => c.sealedAt).sort(byStart);
    if (sorted.length === 0) return [];
    let breaks: string[] = [];
    if (provider) {
        const prompt = [
            'You are a TTRPG campaign archivist. A long campaign\'s chapters are being grouped into BOOKS (like the volumes of a novel series). Choose where each book ends.',
            '',
            'OUTPUT FORMAT — a single JSON object:',
            '{"bookEnds":["CH07","CH15"]}',
            '',
            'RULES:',
            '- End a book at a real story break: an arc resolved, a time skip, a change of setting or era, a new status quo.',
            `- A book is 4 to ${BOOK_AUTO_CLOSE_CHAPTERS} chapters. Never more than ${BOOK_AUTO_CLOSE_CHAPTERS}.`,
            '- The last chapter listed may stay outside a book if its arc is still running: only list a book end there if the arc clearly ended.',
            'Output ONLY the JSON object.',
            '',
            `CHAPTERS (oldest first):\n${sorted.map(c => `${c.chapterId} "${c.title}": ${(typeof c.summary === 'string' ? c.summary : c.synopsis ?? '').trim().slice(0, 400)}`).join('\n')}`,
        ].join('\n');
        try {
            const raw = await llmCall(provider, prompt, {
                priority: 'low',
                temperature: 0.2,
                maxTokens: 800,
                trackingLabel: 'book-breaks',
                timeoutMs: AI_CALL_TIMEOUT_MS,
            });
            const value = parseJsonObject(raw);
            if (value && Array.isArray(value.bookEnds)) {
                breaks = value.bookEnds.filter((x): x is string => typeof x === 'string').map(x => x.trim().toUpperCase());
            }
        } catch (e) {
            console.warn('[Books] Break proposal failed, using fixed groups:', e);
        }
    }
    return enforceBreaks(sorted, breaks);
}

/** Keep valid, ordered breaks and split any group longer than the max. */
export function enforceBreaks(sorted: ArchiveChapter[], proposed: string[]): string[] {
    const wanted = new Set(proposed);
    const out: string[] = [];
    let run = 0;
    for (const c of sorted) {
        run++;
        if (wanted.has(c.chapterId) || run >= BOOK_AUTO_CLOSE_CHAPTERS) {
            out.push(c.chapterId);
            run = 0;
        }
    }
    return out;
}
