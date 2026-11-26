import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/llmCall', () => ({ llmCall: vi.fn() }));

import { llmCall } from '../../../utils/llmCall';
import {
    reconcileBooks, unbookedSealed, enforceBreaks, makeBook, nextBookId, bookOf, chaptersInBook,
    parseBookSummary, parseJsonObject, summarizeBook, proposeBookBreaks, BOOK_AUTO_CLOSE_CHAPTERS,
} from '../bookEngine';
import { renderLodChapters } from '../../payload/lodRenderer';
import type { ArchiveBook, ArchiveChapter, ChatMessage } from '../../../types';

const provider = { endpoint: 'http://x', apiKey: '', modelName: 'm' } as never;
const pad = (n: number) => String(n).padStart(3, '0');

function chapter(n: number, from: number, to: number, over: Partial<ArchiveChapter> = {}): ArchiveChapter {
    const id = `CH${String(n).padStart(2, '0')}`;
    return {
        chapterId: id, title: `Title ${id}`, sceneRange: [pad(from), pad(to)],
        sceneIds: Array.from({ length: to - from + 1 }, (_, i) => pad(from + i)),
        summary: `First of ${id}. Detail of ${id}.`, keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [],
        tone: '', themes: [], sceneCount: to - from + 1, sealedAt: 1, ...over,
    };
}
function book(id: string, from: number, to: number, over: Partial<ArchiveBook> = {}): ArchiveBook {
    return {
        bookId: id, title: `Book ${id}`, sceneRange: [pad(from), pad(to)], summary: `Opening of ${id}. Middle of ${id}.`,
        keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], createdAt: 0, ...over,
    };
}
/** Chapters of 5 scenes each: CH01 = 1-5, CH02 = 6-10, … the last one open. */
const run = (count: number, openLast = true) => Array.from({ length: count }, (_, i) =>
    chapter(i + 1, i * 5 + 1, i * 5 + 5, openLast && i === count - 1 ? { sealedAt: undefined } : {}));

beforeEach(() => {
    vi.mocked(llmCall).mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('book membership', () => {
    it('a chapter belongs to the book holding its first scene', () => {
        const books = [book('BK01', 1, 15)];
        expect(bookOf(chapter(2, 6, 10), books)?.bookId).toBe('BK01');
        expect(bookOf(chapter(4, 16, 20), books)).toBeUndefined();
    });

    it('a split chapter inside a book stays in it', () => {
        const books = [book('BK01', 1, 10)];
        const halves = [chapter(2, 6, 7, { chapterId: 'CH02A' }), chapter(2, 8, 10, { chapterId: 'CH02B' })];
        expect(chaptersInBook(books[0], [chapter(1, 1, 5), ...halves]).map(c => c.chapterId)).toEqual(['CH01', 'CH02A', 'CH02B']);
    });

    it('unbookedSealed is the sealed chapters after the last book, oldest first', () => {
        expect(unbookedSealed(run(6), [book('BK01', 1, 10)]).map(c => c.chapterId)).toEqual(['CH03', 'CH04', 'CH05']);
    });

    it('next book id is one past the highest', () => {
        expect(nextBookId([])).toBe('BK01');
        expect(nextBookId([book('BK01', 1, 5), book('BK03', 6, 10)])).toBe('BK04');
    });

    it('makeBook spans its chapters and falls back to a stand-in summary', () => {
        const b = makeBook([], run(3, false), null, 'P3 · 2009');
        expect(b).toMatchObject({ bookId: 'BK01', sceneRange: ['001', '015'], era: 'P3 · 2009', summaryPending: true });
        expect(b.summary).toContain('CH01 Title CH01.');
    });
});

describe('reconcileBooks', () => {
    it('keeps books whose chapters still exist (same array back)', () => {
        const books = [book('BK01', 1, 10), book('BK02', 11, 20)];
        expect(reconcileBooks(books, run(6))).toBe(books);
    });

    it('drops a book (and later ones) once rollback reopened a chapter in it', () => {
        // Rolled back to scene 8: CH02 reopened and takes new scenes; CH03+ deleted.
        const chapters = [chapter(1, 1, 5), chapter(2, 6, 7, { sealedAt: undefined })];
        expect(reconcileBooks([book('BK01', 1, 10), book('BK02', 11, 20)], chapters)).toEqual([]);
    });

    it('keeps a book when a single old scene delete reopened one of its chapters', () => {
        const chapters = run(6);
        chapters[1] = { ...chapters[1], sealedAt: undefined, invalidated: true };
        expect(reconcileBooks([book('BK01', 1, 10)], chapters).map(b => b.bookId)).toEqual(['BK01']);
    });

    it('drops books whose chapters are gone (archive cleared or older backup restored)', () => {
        expect(reconcileBooks([book('BK01', 1, 10), book('BK02', 11, 20)], run(3)).map(b => b.bookId)).toEqual(['BK01']);
        expect(reconcileBooks([book('BK01', 1, 10)], [])).toEqual([]);
    });
});

describe('enforceBreaks', () => {
    it('keeps proposed breaks in order and never lets a book exceed the max', () => {
        expect(enforceBreaks(run(25, false), ['CH04', 'CH99', 'CH20'])).toEqual(['CH04', 'CH14', 'CH20']);
        expect(BOOK_AUTO_CLOSE_CHAPTERS).toBe(10);
    });

    it('falls back to fixed groups with no proposal', () => {
        expect(enforceBreaks(run(21, false), [])).toEqual(['CH10', 'CH20']);
    });
});

describe('AI calls', () => {
    it('parses a summary wrapped in think tags and fences', () => {
        const raw = '<think>hmm {not json}</think>```json\n{"title":"The Siege","summary":"It began.","npcs":["Ana","Ana "," "]}\n```';
        expect(parseJsonObject(raw)).toMatchObject({ title: 'The Siege' });
        expect(parseBookSummary(raw, run(2, false))).toEqual({
            title: 'The Siege', summary: 'It began.', keywords: [], npcs: ['Ana'], majorEvents: [], unresolvedThreads: [],
        });
    });

    it('an empty summary is a failure, not a blank book', async () => {
        vi.mocked(llmCall).mockResolvedValue('{"title":"X","summary":""}');
        expect(await summarizeBook(provider, run(2, false))).toBeNull();
        vi.mocked(llmCall).mockImplementation(async () => { throw new Error('down'); });
        expect(await summarizeBook(provider, run(2, false))).toBeNull();
    });

    it('book breaks come from the AI, capped at the max; fixed groups when it fails', async () => {
        vi.mocked(llmCall).mockResolvedValue('{"bookEnds":["ch05","CH17"]}');
        expect(await proposeBookBreaks(provider, run(20, false))).toEqual(['CH05', 'CH15', 'CH17']);
        vi.mocked(llmCall).mockImplementation(async () => { throw new Error('down'); });
        expect(await proposeBookBreaks(provider, run(20, false))).toEqual(['CH10', 'CH20']);
        expect(await proposeBookBreaks(undefined, run(20, false))).toEqual(['CH10', 'CH20']);
    });
});

describe('recap with books', () => {
    /** One user + one scene-stamped GM message per scene. */
    function transcript(scenes: number): ChatMessage[] {
        const out: ChatMessage[] = [];
        for (let n = 1; n <= scenes; n++) {
            out.push({ id: `u${n}`, role: 'user', content: `p ${n}`, timestamp: 0 } as ChatMessage);
            out.push({ id: `a${n}`, role: 'assistant', content: `gm ${n}`, timestamp: 0, sceneId: pad(n) } as ChatMessage);
        }
        return out;
    }
    const chapters = run(8, false); // scenes 1-40
    const messages = transcript(45);
    const condensed = 40 * 2 - 1; // through scene 40
    const config = { summaryChapters: 7, importanceBonus: 0, summaryBooks: 2 };

    it('books replace their chapters; newest books in full, older as one line', () => {
        const books = [book('BK01', 1, 10, { era: 'P3' }), book('BK02', 11, 20), book('BK03', 21, 30)];
        const r = renderLodChapters({ chapters, books, archiveIndex: [], messages, condensedUpToIndex: condensed, budgetTokens: 100000, config });
        expect(r.tierByBookId).toEqual({ BK01: 'synopsis', BK02: 'summary', BK03: 'summary' });
        expect(r.tierByChapterId).toEqual({ CH07: 'summary', CH08: 'summary' });
        expect(r.text).toContain('Book BK01 — Book BK01 (P3)\nOpening of BK01.');
        expect(r.text).not.toContain('Middle of BK01');
        expect(r.text).toContain('Middle of BK03');
        expect(r.text).not.toContain('Chapter CH01');
        expect(r.text.indexOf('BK03')).toBeLessThan(r.text.indexOf('CH07'));
    });

    it('over budget, the oldest items are demoted and dropped first, books included', () => {
        const books = [book('BK01', 1, 10), book('BK02', 11, 20), book('BK03', 21, 30)];
        const full = renderLodChapters({ chapters, books, archiveIndex: [], messages, condensedUpToIndex: condensed, budgetTokens: 100000, config });
        const tight = renderLodChapters({ chapters, books, archiveIndex: [], messages, condensedUpToIndex: condensed, budgetTokens: Math.floor(full.tokens / 2), config });
        expect(tight.tokens).toBeLessThanOrEqual(Math.floor(full.tokens / 2));
        expect(tight.tierByBookId.BK01).toBe('dropped');
        expect(tight.tierByChapterId.CH08).not.toBe('dropped');
    });

    it('is identical without books to the chapter-only recap', () => {
        const a = renderLodChapters({ chapters, archiveIndex: [], messages, condensedUpToIndex: condensed, budgetTokens: 100000, config });
        const b = renderLodChapters({ chapters, books: [], archiveIndex: [], messages, condensedUpToIndex: condensed, budgetTokens: 100000, config });
        expect(b).toEqual(a);
        expect(Object.keys(a.tierByChapterId)).toHaveLength(8);
        expect(a.tierByBookId).toEqual({});
    });

    it('108 chapters bound into 10-chapter books render about a dozen items, not 108', () => {
        const many = run(108, false);
        const books: ArchiveBook[] = [];
        for (let i = 0; i + BOOK_AUTO_CLOSE_CHAPTERS <= many.length; i += BOOK_AUTO_CLOSE_CHAPTERS) {
            books.push(makeBook(books, many.slice(i, i + BOOK_AUTO_CLOSE_CHAPTERS), null));
        }
        const long = transcript(545);
        const r = renderLodChapters({ chapters: many, books, archiveIndex: [], messages: long, condensedUpToIndex: 540 * 2 - 1, budgetTokens: 1_000_000, config });
        expect(Object.keys(r.tierByBookId)).toHaveLength(10);
        expect(Object.keys(r.tierByChapterId)).toHaveLength(8);
    });
});
