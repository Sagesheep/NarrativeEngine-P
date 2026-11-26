import type { ArchiveChapter, ProviderConfig, EndpointConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import { parseChapterSummaryOutput } from '../saveFile/chapterSummary';

// ─── Synopsis Backfill (WO-07) ───
//
// User-triggered generation of missing `synopsis` for already-sealed chapters.
// Decision D4: no surprise token spend — the loop only runs when the player
// clicks the backfill button, never automatically.
//
// Source material is the chapter's existing `title` + `summary` + `majorEvents`
// (not the full scene text), so each call is trivially cheap. WO-06 owns the
// seal-time path; this is a separate backfill for chapters sealed before WO-06
// or whose seal produced no synopsis.

export type SynopsisBackfillResult = {
    synopsis?: string;
    abstractTitle?: string;
    literalTitle?: string;
};

export type BackfillChapterOutcome = {
    chapterId: string;
    ok: boolean;
    result?: SynopsisBackfillResult;
    error?: string;
};

export type BackfillRunResult = {
    patched: BackfillChapterOutcome[];
    skipped: string[];
    aborted: boolean;
};

function buildSynopsisPrompt(chapter: ArchiveChapter): string {
    // Trivial source: title + summary + majorEvents only. Keeps the call cheap.
    // Defensive: old campaigns may have non-string `summary` (null, undefined,
    // object) from buggy seals, manual edits, or pre-WO-06 schemas — the type
    // says required string but runtime loads raw JSON with no validation.
    const majorEvents = (chapter.majorEvents ?? []).filter(Boolean);
    const summary = typeof chapter.summary === 'string' ? chapter.summary : '';
    return [
        'You are a TTRPG campaign archivist. Generate a synopsis for an already-sealed chapter.',
        '',
        `CHAPTER TITLE: ${chapter.title || 'Untitled'}`,
        `CHAPTER SUMMARY: ${summary || '(no summary recorded)'}`,
        `MAJOR EVENTS: ${majorEvents.length > 0 ? majorEvents.map(e => `- ${e}`).join('\n') : '(none recorded)'}`,
        '',
        'OUTPUT FORMAT — respond with a JSON object containing only these three fields:',
        '{',
        '    "literalTitle": "Concrete factual title, e.g. The Battle at Locust Town",',
        '    "abstractTitle": "Thematic title, e.g. Old Wounds",',
        '    "synopsis": "1-2 sentences, ultra-high-level, past tense, covering only this chapter"',
        '}',
        '',
        'RULES:',
        '1. Synopsis is past tense and covers ONLY this chapter — no foreshadowing, no callbacks.',
        '2. LiteralTitle is the concrete "what literally happened" label.',
        '3. AbstractTitle is the thematic label — what the chapter is "about" at a human level.',
        '4. Output ONLY the JSON object — no prose, no markdown fences.',
    ].join('\n');
}

export function parseSynopsisBackfillOutput(raw: string): SynopsisBackfillResult | null {
    // Reuse WO-06's parseChapterSummaryOutput: it already validates the three
    // optional fields, trims whitespace, coerces empty/wrong-type to undefined,
    // and is the canonical "is this synopsis-shaped?" judge. We project down
    // to the three fields we care about.
    const parsed = parseChapterSummaryOutput(raw);
    if (!parsed) return null;
    const out: SynopsisBackfillResult = {};
    if (parsed.synopsis) out.synopsis = parsed.synopsis;
    if (parsed.abstractTitle) out.abstractTitle = parsed.abstractTitle;
    if (parsed.literalTitle) out.literalTitle = parsed.literalTitle;
    return out;
}

export async function generateChapterSynopsis(
    provider: ProviderConfig | EndpointConfig,
    chapter: ArchiveChapter,
): Promise<SynopsisBackfillResult | null> {
    const prompt = buildSynopsisPrompt(chapter);
    const raw = await llmCall(provider, prompt, {
        priority: 'low',
        maxTokens: 400,
        trackingLabel: 'synopsis-backfill',
        timeoutMs: AI_CALL_TIMEOUT_MS,
    });
    return parseSynopsisBackfillOutput(raw);
}

export function chaptersNeedingSynopsis(chapters: ArchiveChapter[]): ArchiveChapter[] {
    // Sealed chapters (sealedAt set) lacking a non-empty `synopsis`. Open or
    // invalidated chapters are skipped — backfill is for the historical record.
    return chapters.filter(c => {
        if (typeof c.sealedAt !== 'number') return false;
        if (c.invalidated) return false;
        if (typeof c.synopsis !== 'string') return true;
        return c.synopsis.trim() === '';
    });
}

export type BackfillRunOptions = {
    chapters: ArchiveChapter[];
    provider: ProviderConfig | EndpointConfig;
    patch: (chapterId: string, fields: SynopsisBackfillResult) => Promise<void>;
    isActive: () => boolean;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number, chapterId: string) => void;
};

export async function backfillChapterSynopses(opts: BackfillRunOptions): Promise<BackfillRunResult> {
    const { chapters, provider, patch, isActive, signal, onProgress } = opts;
    const targets = chaptersNeedingSynopsis(chapters);
    const patched: BackfillChapterOutcome[] = [];
    const skipped: string[] = [];

    for (let i = 0; i < targets.length; i++) {
        // Abort on unmount or campaign switch — leave already-patched chapters
        // patched, stop cleanly. No rollback: PATCHes already hit the server.
        if (signal?.aborted) {
            return { patched, skipped, aborted: true };
        }
        if (!isActive()) {
            return { patched, skipped, aborted: true };
        }

        const chapter = targets[i];
        onProgress?.(i, targets.length, chapter.chapterId);

        // Skip chapters with no usable summary — synopsis is 1-2 sentences
        // derived from the summary; without it the call would hallucinate.
        // Defensive: `summary` may be non-string (null/undefined/object) in old
        // campaigns — treat anything that isn't a non-empty string as "missing".
        const summaryStr = typeof chapter.summary === 'string' ? chapter.summary : '';
        if (!summaryStr || summaryStr.trim() === '') {
            skipped.push(chapter.chapterId);
            continue;
        }

        try {
            const result = await generateChapterSynopsis(provider, chapter);
            // Re-check guard after the await — campaign may have switched mid-call.
            if (signal?.aborted || !isActive()) {
                return { patched, skipped, aborted: true };
            }
            if (!result || (result.synopsis === undefined && result.abstractTitle === undefined && result.literalTitle === undefined)) {
                patched.push({ chapterId: chapter.chapterId, ok: false, error: 'parse-empty' });
                continue;
            }
            await patch(chapter.chapterId, result);
            patched.push({ chapterId: chapter.chapterId, ok: true, result });
        } catch (err) {
            if (signal?.aborted || !isActive()) {
                return { patched, skipped, aborted: true };
            }
            const msg = err instanceof Error ? err.message : String(err);
            patched.push({ chapterId: chapter.chapterId, ok: false, error: msg });
        }
    }

    onProgress?.(targets.length, targets.length, targets[targets.length - 1]?.chapterId ?? '');
    return { patched, skipped, aborted: false };
}