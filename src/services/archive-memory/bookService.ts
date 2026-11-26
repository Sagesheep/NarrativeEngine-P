/**
 * Book persistence + orchestration (the pure logic is in bookEngine.ts).
 */
import type { ArchiveBook, ArchiveChapter, EndpointConfig, ProviderConfig } from '../../types';
import { api } from '../llm/apiClient';
import { BOOK_AUTO_CLOSE_CHAPTERS, makeBook, summarizeBook, unbookedSealed, proposeBookBreaks, chaptersInBook } from './bookEngine';

type Provider = ProviderConfig | EndpointConfig;

/**
 * Close a book ending at `throughChapterId`: every sealed chapter after the last
 * book, up to and including it. Returns the updated book list, or null when
 * there is nothing to bind (no such unbooked chapter).
 */
export async function closeBookThrough(
    campaignId: string,
    throughChapterId: string,
    provider: Provider | undefined,
    era?: string,
): Promise<ArchiveBook[] | null> {
    const chapters = await api.chapters.list(campaignId);
    const books = await api.books.list(campaignId, chapters);
    const candidates = unbookedSealed(chapters, books);
    const endAt = candidates.findIndex(c => c.chapterId === throughChapterId);
    if (endAt < 0) return null;
    const group = candidates.slice(0, endAt + 1);
    // A new book inherits the previous book's era unless one is given.
    const bookEra = era ?? books[books.length - 1]?.era;
    const summary = provider ? await summarizeBook(provider, group, bookEra) : null;
    const next = [...books, makeBook(books, group, summary, bookEra)];
    await api.books.save(campaignId, next);
    return next;
}

/** After a seal: bind a book once BOOK_AUTO_CLOSE_CHAPTERS sealed chapters sit outside one. */
export async function autoCloseBookIfDue(campaignId: string, provider: Provider | undefined): Promise<ArchiveBook[] | null> {
    const chapters = await api.chapters.list(campaignId);
    const books = await api.books.list(campaignId, chapters);
    const candidates = unbookedSealed(chapters, books);
    if (candidates.length < BOOK_AUTO_CLOSE_CHAPTERS) return null;
    return closeBookThrough(campaignId, candidates[BOOK_AUTO_CLOSE_CHAPTERS - 1].chapterId, provider);
}

/** "Build Books" step 1: the AI's proposed book ends for chapters not yet in a book. */
export async function proposeBooksForExisting(campaignId: string, provider: Provider | undefined): Promise<{ candidates: ArchiveChapter[]; breaks: string[] }> {
    const chapters = await api.chapters.list(campaignId);
    const books = await api.books.list(campaignId, chapters);
    const candidates = unbookedSealed(chapters, books);
    return { candidates, breaks: await proposeBookBreaks(provider, candidates) };
}

/** "Build Books" step 2: bind a book at each confirmed break, oldest first. */
export async function buildBooks(
    campaignId: string,
    breaks: string[],
    provider: Provider | undefined,
    onProgress: (done: number, total: number) => void,
    isActive: () => boolean,
): Promise<ArchiveBook[]> {
    let books = await api.books.list(campaignId);
    for (let i = 0; i < breaks.length; i++) {
        if (!isActive()) break;
        onProgress(i, breaks.length);
        books = (await closeBookThrough(campaignId, breaks[i], provider)) ?? books;
    }
    return books;
}

/** Rewrite one book's summary (after a failed call, or to refresh it). */
export async function regenerateBook(campaignId: string, bookId: string, provider: Provider): Promise<ArchiveBook[] | null> {
    const chapters = await api.chapters.list(campaignId);
    const books = await api.books.list(campaignId, chapters);
    const idx = books.findIndex(b => b.bookId === bookId);
    if (idx < 0) return null;
    const book = books[idx];
    const summary = await summarizeBook(provider, chaptersInBook(book, chapters), book.era);
    if (!summary) return null;
    const { summaryPending: _pending, ...rest } = book;
    const next = books.map((b, i) => i === idx ? { ...rest, ...summary } : b);
    await api.books.save(campaignId, next);
    return next;
}

/** Edit a book's era label / title by hand. */
export async function updateBook(campaignId: string, bookId: string, patch: Partial<Pick<ArchiveBook, 'era' | 'title'>>): Promise<ArchiveBook[]> {
    const books = await api.books.list(campaignId);
    const next = books.map(b => {
        if (b.bookId !== bookId) return b;
        const merged = { ...b, ...patch };
        if (!merged.era) delete merged.era;
        return merged;
    });
    await api.books.save(campaignId, next);
    return next;
}

/** Unbind the newest book (its chapters go back to being loose). Only the last can go — books stay contiguous. */
export async function removeLastBook(campaignId: string): Promise<ArchiveBook[]> {
    const books = await api.books.list(campaignId);
    const next = books.slice(0, -1);
    await api.books.save(campaignId, next);
    return next;
}
