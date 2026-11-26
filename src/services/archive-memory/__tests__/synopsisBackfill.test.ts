import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    parseSynopsisBackfillOutput,
    chaptersNeedingSynopsis,
    backfillChapterSynopses,
    type SynopsisBackfillResult,
} from '../synopsisBackfill';
import type { ArchiveChapter, EndpointConfig } from '../../../types';

vi.mock('../../../utils/llmCall', () => ({
    llmCall: vi.fn(),
}));

import { llmCall } from '../../../utils/llmCall';

const PROVIDER: EndpointConfig = { endpoint: 'http://x', apiKey: '', modelName: 'm' };

function chapter(over: Partial<ArchiveChapter> & { chapterId: string }): ArchiveChapter {
    return {
        chapterId: over.chapterId,
        title: over.title ?? 'Test Chapter',
        sceneRange: over.sceneRange ?? ['001', '010'],
        sceneIds: over.sceneIds ?? ['001'],
        summary: over.summary ?? 'A short summary.',
        keywords: over.keywords ?? [],
        npcs: over.npcs ?? [],
        majorEvents: over.majorEvents ?? [],
        unresolvedThreads: over.unresolvedThreads ?? [],
        tone: over.tone ?? 'mixed',
        themes: over.themes ?? [],
        sceneCount: over.sceneCount ?? 1,
        sealedAt: over.sealedAt,
        invalidated: over.invalidated,
        synopsis: over.synopsis,
        abstractTitle: over.abstractTitle,
        literalTitle: over.literalTitle,
    };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.mocked(llmCall).mockReset();
});

describe('parseSynopsisBackfillOutput â€” reuses WO-06 parse helper', () => {
    it('projects the three fields out of a valid JSON response', () => {
        const raw = JSON.stringify({
            literalTitle: 'The Battle at Locust Town',
            abstractTitle: 'Old Wounds',
            synopsis: 'The party fought bandits at Locust Town and won.',
        });

        const out = parseSynopsisBackfillOutput(raw);

        expect(out).toEqual({
            literalTitle: 'The Battle at Locust Town',
            abstractTitle: 'Old Wounds',
            synopsis: 'The party fought bandits at Locust Town and won.',
        });
    });

    it('trims whitespace from the three fields', () => {
        const raw = JSON.stringify({
            literalTitle: ' The Battle at Locust Town ',
            abstractTitle: '\tOld Wounds\n',
            synopsis: '  The party fought bandits at Locust Town and won.  ',
        });

        const out = parseSynopsisBackfillOutput(raw);

        expect(out?.synopsis).toBe('The party fought bandits at Locust Town and won.');
        expect(out?.abstractTitle).toBe('Old Wounds');
        expect(out?.literalTitle).toBe('The Battle at Locust Town');
    });

    it('omits fields that the LLM left out, without forcing them', () => {
        const raw = JSON.stringify({
            synopsis: 'Only a synopsis was produced.',
        });

        const out = parseSynopsisBackfillOutput(raw);

        expect(out).toEqual({ synopsis: 'Only a synopsis was produced.' });
    });

    it('returns null on garbage input', () => {
        expect(parseSynopsisBackfillOutput('not json at all')).toBeNull();
        expect(parseSynopsisBackfillOutput('')).toBeNull();
    });

    it('returns null when all three fields are missing/empty', () => {
        const raw = JSON.stringify({
            synopsis: '',
            abstractTitle: '   ',
            literalTitle: '',
        });

        const out = parseSynopsisBackfillOutput(raw);

        expect(out).toEqual({});
    });
});

describe('chaptersNeedingSynopsis â€” skip logic', () => {
    it('selects sealed chapters with no synopsis field', () => {
        const list: ArchiveChapter[] = [
            chapter({ chapterId: 'CH01', sealedAt: 1000 }),
            chapter({ chapterId: 'CH02', sealedAt: 2000, synopsis: 'Already has one.' }),
            chapter({ chapterId: 'CH03' }), // open, no sealedAt
        ];

        const targets = chaptersNeedingSynopsis(list);

        expect(targets.map(c => c.chapterId)).toEqual(['CH01']);
    });

    it('selects sealed chapters with an empty/whitespace synopsis', () => {
        const list: ArchiveChapter[] = [
            chapter({ chapterId: 'CH01', sealedAt: 1000, synopsis: '' }),
            chapter({ chapterId: 'CH02', sealedAt: 2000, synopsis: '   ' }),
            chapter({ chapterId: 'CH03', sealedAt: 3000, synopsis: 'real synopsis' }),
        ];

        const targets = chaptersNeedingSynopsis(list);

        expect(targets.map(c => c.chapterId).sort()).toEqual(['CH01', 'CH02']);
    });

    it('skips invalidated chapters even if they are sealed', () => {
        const list: ArchiveChapter[] = [
            chapter({ chapterId: 'CH01', sealedAt: 1000, invalidated: true }),
            chapter({ chapterId: 'CH02', sealedAt: 2000 }),
        ];

        const targets = chaptersNeedingSynopsis(list);

        expect(targets.map(c => c.chapterId)).toEqual(['CH02']);
    });

    it('skips open chapters (no sealedAt)', () => {
        const list: ArchiveChapter[] = [
            chapter({ chapterId: 'CH01' }),
            chapter({ chapterId: 'CH02', sealedAt: 1000 }),
        ];

        const targets = chaptersNeedingSynopsis(list);

        expect(targets.map(c => c.chapterId)).toEqual(['CH02']);
    });
});

describe('backfillChapterSynopses â€” sequential loop and abort', () => {
    it('patches each target sequentially and reports progress, in order', async () => {
        const list: ArchiveChapter[] = [
            chapter({ chapterId: 'CH01', sealedAt: 1000 }),
            chapter({ chapterId: 'CH02', sealedAt: 2000 }),
            chapter({ chapterId: 'CH03', sealedAt: 3000 }),
        ];
        const patched: Record<string, SynopsisBackfillResult> = {};
        const progress: string[] = [];

        // Return a different synopsis per chapter so we can confirm order.
        let call = 0;
        vi.mocked(llmCall).mockImplementation(async () => {
            call += 1;
            return JSON.stringify({
                synopsis: `s-${call}`,
                abstractTitle: `a-${call}`,
                literalTitle: `l-${call}`,
            });
        });

        const result = await backfillChapterSynopses({
            chapters: list,
            provider: PROVIDER,
            patch: async (id, fields) => { patched[id] = fields; },
            isActive: () => true,
            onProgress: (done, total, id) => { progress.push(`${done}/${total}:${id}`); },
        });

        expect(result.aborted).toBe(false);
        expect(result.patched).toHaveLength(3);
        expect(result.patched.map(p => p.chapterId)).toEqual(['CH01', 'CH02', 'CH03']);
        expect(result.patched.every(p => p.ok)).toBe(true);
        expect(patched['CH01'].synopsis).toBe('s-1');
        expect(patched['CH02'].synopsis).toBe('s-2');
        expect(patched['CH03'].synopsis).toBe('s-3');
        // Progress fires once per chapter with the running index and chapterId.
        expect(progress).toEqual(['0/3:CH01', '1/3:CH02', '2/3:CH03', '3/3:CH03']);
    });

    it('skips chapters with no summary (no LLM call made for them)', async () => {
        const list: ArchiveChapter[] = [
            chapter({ chapterId: 'CH01', sealedAt: 1000, summary: '' }),
            chapter({ chapterId: 'CH02', sealedAt: 2000, summary: 'has summary' }),
        ];

        let calls = 0;
        vi.mocked(llmCall).mockImplementation(async () => {
            calls += 1;
            return JSON.stringify({ synopsis: 's', abstractTitle: 'a', literalTitle: 'l' });
        });

        const result = await backfillChapterSynopses({
            chapters: list,
            provider: PROVIDER,
            patch: async () => {},
            isActive: () => true,
        });

        expect(calls).toBe(1); // only CH02
        expect(result.skipped).toEqual(['CH01']);
        expect(result.patched.map(p => p.chapterId)).toEqual(['CH02']);
    });

    it('regression: non-string summary (null/undefined/object from old campaigns) does not crash, skips the chapter', async () => {
        // Old campaigns may have chapters with non-string `summary` from buggy
        // seals, manual edits, or pre-WO-06 schemas. The type says required
        // string but runtime loads raw JSON with no validation. The backfill
        // must treat any non-string summary as "missing" and skip the chapter,
        // NOT crash with "TypeError: chapter.summary.trim is not a function".
        const list = [
            { ...chapter({ chapterId: 'CH01', sealedAt: 1000 }), summary: null as unknown as string },
            { ...chapter({ chapterId: 'CH02', sealedAt: 2000 }), summary: undefined as unknown as string },
            { ...chapter({ chapterId: 'CH03', sealedAt: 3000 }), summary: { weird: 'object' } as unknown as string },
            chapter({ chapterId: 'CH04', sealedAt: 4000, summary: 'valid summary' }),
        ];

        let calls = 0;
        vi.mocked(llmCall).mockImplementation(async () => {
            calls += 1;
            return JSON.stringify({ synopsis: 's', abstractTitle: 'a', literalTitle: 'l' });
        });

        // Must not throw.
        const result = await backfillChapterSynopses({
            chapters: list,
            provider: PROVIDER,
            patch: async () => {},
            isActive: () => true,
        });

        // The three non-string-summary chapters are skipped; only CH04 is sent to the LLM.
        expect(calls).toBe(1);
        expect(result.skipped).toEqual(['CH01', 'CH02', 'CH03']);
        expect(result.patched.map(p => p.chapterId)).toEqual(['CH04']);
    });

    it('aborts mid-run when isActive() turns false, leaving already-patched chapters patched', async () => {
        const list: ArchiveChapter[] = [
            chapter({ chapterId: 'CH01', sealedAt: 1000 }),
            chapter({ chapterId: 'CH02', sealedAt: 2000 }),
            chapter({ chapterId: 'CH03', sealedAt: 3000 }),
        ];

        let calls = 0;
        let stillActive = true;
        vi.mocked(llmCall).mockImplementation(async () => {
            calls += 1;
            // Flip the guard to "inactive" after the second call completes.
            if (calls === 2) stillActive = false;
            return JSON.stringify({ synopsis: 's', abstractTitle: 'a', literalTitle: 'l' });
        });

        const patched: string[] = [];

        const result = await backfillChapterSynopses({
            chapters: list,
            provider: PROVIDER,
            patch: async (id) => { patched.push(id); },
            isActive: () => stillActive,
        });

        // CH01 patched before the guard flipped. CH02's LLM call completed, but
        // the post-await re-check fires BEFORE the PATCH â€” so CH02 is dropped and
        // CH03 is never attempted. Already-patched CH01 stays patched.
        expect(result.aborted).toBe(true);
        expect(patched).toEqual(['CH01']);
        expect(calls).toBe(2);
    });

    it('aborts cleanly when AbortSignal fires, leaving already-patched chapters patched', async () => {
        const list: ArchiveChapter[] = [
            chapter({ chapterId: 'CH01', sealedAt: 1000 }),
            chapter({ chapterId: 'CH02', sealedAt: 2000 }),
            chapter({ chapterId: 'CH03', sealedAt: 3000 }),
        ];

        const ac = new AbortController();
        let calls = 0;
        vi.mocked(llmCall).mockImplementation(async () => {
            calls += 1;
            // Abort during CH02's call. The post-await re-check fires before the
            // PATCH, so CH02's call completed but its PATCH is dropped.
            if (calls === 2) ac.abort();
            return JSON.stringify({ synopsis: 's', abstractTitle: 'a', literalTitle: 'l' });
        });

        const patched: string[] = [];

        const result = await backfillChapterSynopses({
            chapters: list,
            provider: PROVIDER,
            patch: async (id) => { patched.push(id); },
            isActive: () => true,
            signal: ac.signal,
        });

        expect(result.aborted).toBe(true);
        expect(patched).toEqual(['CH01']);
    });

    it('records a per-chapter failure outcome without aborting the loop', async () => {
        const list: ArchiveChapter[] = [
            chapter({ chapterId: 'CH01', sealedAt: 1000 }),
            chapter({ chapterId: 'CH02', sealedAt: 2000 }),
        ];

        let calls = 0;
        vi.mocked(llmCall).mockImplementation(async () => {
            calls += 1;
            if (calls === 1) throw new Error('boom');
            return JSON.stringify({ synopsis: 's', abstractTitle: 'a', literalTitle: 'l' });
        });

        const result = await backfillChapterSynopses({
            chapters: list,
            provider: PROVIDER,
            patch: async () => {},
            isActive: () => true,
        });

        expect(result.aborted).toBe(false);
        expect(result.patched).toHaveLength(2);
        expect(result.patched[0]).toEqual({ chapterId: 'CH01', ok: false, error: 'boom' });
        expect(result.patched[1].ok).toBe(true);
    });

    it('records a parse-empty outcome when the LLM returns no usable fields', async () => {
        const list: ArchiveChapter[] = [
            chapter({ chapterId: 'CH01', sealedAt: 1000 }),
        ];

        vi.mocked(llmCall).mockResolvedValue('not json');

        const result = await backfillChapterSynopses({
            chapters: list,
            provider: PROVIDER,
            patch: async () => {},
            isActive: () => true,
        });

        expect(result.patched).toHaveLength(1);
        expect(result.patched[0].ok).toBe(false);
        expect(result.patched[0].error).toBe('parse-empty');
    });

    it('re-checks the guard after the LLM await and aborts if the campaign switched mid-call', async () => {
        const list: ArchiveChapter[] = [
            chapter({ chapterId: 'CH01', sealedAt: 1000 }),
        ];

        let stillActive = true;
        vi.mocked(llmCall).mockImplementation(async () => {
            stillActive = false; // campaign switched while the call was in flight
            return JSON.stringify({ synopsis: 's', abstractTitle: 'a', literalTitle: 'l' });
        });

        const patched: string[] = [];

        const result = await backfillChapterSynopses({
            chapters: list,
            provider: PROVIDER,
            patch: async (id) => { patched.push(id); },
            isActive: () => stillActive,
        });

        expect(result.aborted).toBe(true);
        expect(patched).toEqual([]); // post-await guard fired before the PATCH
    });

    it('no targets â†’ empty result, no LLM calls, no patch calls', async () => {
        const list: ArchiveChapter[] = [
            chapter({ chapterId: 'CH01', sealedAt: 1000, synopsis: 'already here' }),
        ];

        const result = await backfillChapterSynopses({
            chapters: list,
            provider: PROVIDER,
            patch: async () => { throw new Error('should not be called'); },
            isActive: () => true,
        });

        expect(result.aborted).toBe(false);
        expect(result.patched).toEqual([]);
        expect(result.skipped).toEqual([]);
        expect(vi.mocked(llmCall)).not.toHaveBeenCalled();
    });
});
