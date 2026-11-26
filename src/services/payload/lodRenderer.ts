// ─────────────────────────────────────────────────────────────────────────────
// WO-08 — Pure LOD (Level-of-Detail) renderer for sealed chapters.
//
// Renders sealed ArchiveChapters as either "summary" or "synopsis" tier text
// (D1: there is NO chapter-level full tier — the verbatim window IS the full tier,
// owned by history.ts). Output is byte-identical for identical inputs so it can
// live in the cached prompt prefix: no Date, no random, no Map-iteration-order
// dependence. No witness filter: chapter summaries are the narrator's recap, so
// they never depend on who is on stage. (The filter this replaced compared
// witness names against NPC ids, which kept only chapters holding a scene with no
// witness data, and a cast-dependent block would also break the cached prefix.)
//
// Wiring (WO-09) and budget integration with the rest of the payload are out of
// scope here — this module is pure and synchronous.
// ─────────────────────────────────────────────────────────────────────────────

import type { ArchiveChapter, ArchiveIndexEntry, ChatMessage } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';

export type LodTier = 'summary' | 'synopsis' | 'dropped';

export interface LodConfig {
    /** How many of the most-recent eligible chapters (by effective age) render as `summary`. */
    summaryChapters: number;
    /** Subtracted from position-from-end when any scene in the chapter has importance ≥ 8. */
    importanceBonus: number;
}

export interface LodRenderInput {
    chapters: ArchiveChapter[];
    archiveIndex: ArchiveIndexEntry[];
    /** Index into `messages` of the last condensed message; -1 means "nothing condensed yet". */
    condensedUpToIndex: number;
    messages: ChatMessage[];
    /** Soft cap on rendered output tokens. The cascade demotes/drops oldest first. */
    budgetTokens: number;
    config: LodConfig;
}

export interface LodRenderResult {
    text: string;
    tokens: number;
    tierByChapterId: Record<string, LodTier>;
}

const DEFAULT_CONFIG: LodConfig = { summaryChapters: 7, importanceBonus: 2 };

/**
 * Numeric scene id ("001" → 1). Returns -1 on parse failure so callers can
 * fall back to a conservative comparison.
 */
function sceneNum(id: string): number {
    const n = parseInt(id, 10);
    return Number.isFinite(n) ? n : -1;
}

/**
 * "Has condensed scenes" check: a sealed chapter is eligible once any of its
 * scenes is behind the condensed boundary.
 *
 * history.ts drops everything up to `condensedUpToIndex`, so a chapter whose
 * opening scenes are condensed while its last scenes are still verbatim would
 * otherwise have its condensed part in neither place. This used to require the
 * whole chapter to be behind the boundary, which left up to a chapter's worth of
 * the most recent past unsummarised (scenes 551–570 of a 576-scene campaign).
 * The cost is that the chapter's last few scenes also appear verbatim.
 *
 * Primary mapping: WO-F stamps `sceneId` on committed assistant messages, so the
 * highest stamped scene at or below the boundary is the last condensed scene. If
 * no message at or below the boundary carries a sceneId (pre-WO-F saves), the
 * lowest stamped scene after the boundary bounds it instead; with no stamps at
 * all, refuse (safer to omit than to guess).
 */
function hasCondensedScenes(
    chapter: ArchiveChapter,
    messages: ChatMessage[],
    condensedUpToIndex: number,
): boolean {
    if (condensedUpToIndex < 0) return false; // nothing condensed

    const chapterEnd = sceneNum(chapter.sceneRange[1]);
    const chapterStart = sceneNum(chapter.sceneRange[0]);
    if (chapterEnd < 0 || chapterStart < 0) return false;

    let maxStampedScene = -1;
    for (let i = 0; i <= condensedUpToIndex && i < messages.length; i++) {
        const sid = messages[i].sceneId;
        if (sid) {
            const n = sceneNum(sid);
            if (n > maxStampedScene) maxStampedScene = n;
        }
    }

    if (maxStampedScene >= 0) {
        return chapterStart <= maxStampedScene;
    }

    // Fallback: no condensed message carries a sceneId. The first scene after the
    // boundary is the lowest scene id stamped on a later message.
    let minPostBoundaryScene = Number.POSITIVE_INFINITY;
    for (let i = condensedUpToIndex + 1; i < messages.length; i++) {
        const sid = messages[i].sceneId;
        if (sid) {
            const n = sceneNum(sid);
            if (n >= 0 && n < minPostBoundaryScene) minPostBoundaryScene = n;
        }
    }
    if (Number.isFinite(minPostBoundaryScene)) {
        return chapterStart < minPostBoundaryScene;
    }
    // No scene correspondence available anywhere — refuse.
    return false;
}

/**
 * Effective age = position-from-end − importanceBonus (if any scene in the
 * chapter has importance ≥ 8 in the archive index). Lower effective age =
 * "newer" for the summary-tier selection. We use chapter.sceneRange[1] as the
 * chapter's recency key (the end scene number) — higher = newer.
 */
function effectiveAge(
    chapter: ArchiveChapter,
    archiveIndex: ArchiveIndexEntry[],
    eligibleOrdered: ArchiveChapter[],
    importanceBonus: number,
): number {
    // position-from-end: 0 for the newest eligible chapter, 1 for the prior, …
    const idx = eligibleOrdered.indexOf(chapter);
    const positionFromEnd = eligibleOrdered.length - 1 - idx;

    const hasHighImportanceScene = chapter.sceneIds.some(sid => {
        const entry = archiveIndex.find(e => e.sceneId === sid);
        if (!entry) return false;
        // Chapter-level importance is not aggregated on the index entry — check
        // the per-scene `importance` field AND any event with importance ≥ 8.
        if (typeof entry.importance === 'number' && entry.importance >= 8) return true;
        if (entry.events) {
            for (const ev of entry.events) {
                if (ev.importance >= 8) return true;
            }
        }
        return false;
    });

    return positionFromEnd - (hasHighImportanceScene ? importanceBonus : 0);
}

function renderSummary(chapter: ArchiveChapter): string {
    return `Chapter ${chapter.chapterId} — ${chapter.title}\n${chapter.summary}`;
}

function renderSynopsis(chapter: ArchiveChapter): string {
    const title = chapter.literalTitle ?? chapter.title;
    const body = chapter.synopsis ?? firstSentence(chapter.summary) ?? chapter.title;
    return `Chapter ${chapter.chapterId} — ${title}\n${body}`;
}

/** First sentence of `summary`, or null if the summary is empty/whitespace. */
function firstSentence(summary: string): string | null {
    if (!summary || !summary.trim()) return null;
    const match = summary.match(/^[^.!?]*[.!?]?/);
    const s = match ? match[0].trim() : summary.trim();
    return s.length > 0 ? s : null;
}

/**
 * Pure synchronous LOD renderer. See file header for the rules and the
 * invariant contract (determinism, dedup rule, budget cascade).
 */
export function renderLodChapters(input: LodRenderInput): LodRenderResult {
    const config = input.config ?? DEFAULT_CONFIG;
    const { chapters, archiveIndex, condensedUpToIndex, messages, budgetTokens } = input;

    // 1. Eligibility: sealed chapters with at least one condensed scene.
    const sealed = chapters.filter(c => c.sealedAt !== undefined && !c.invalidated);

    const eligible = sealed.filter(c => hasCondensedScenes(c, messages, condensedUpToIndex));

    // 2. Order oldest → newest by end-scene number (stable on ties by chapterId).
    const ordered = eligible.slice().sort((a, b) => {
        const ae = sceneNum(a.sceneRange[1]);
        const be = sceneNum(b.sceneRange[1]);
        if (ae !== be) return ae - be;
        return a.chapterId.localeCompare(b.chapterId);
    });

    // 3. Tier assignment: newest `summaryChapters` by effective age → summary;
    //    rest → synopsis. Build effective-age once per chapter.
    const effectiveAges = new Map<string, number>();
    for (const ch of ordered) {
        effectiveAges.set(ch.chapterId, effectiveAge(ch, archiveIndex, ordered, config.importanceBonus));
    }
    // Newest = lowest effective age. Tie-break by chapterId for determinism.
    const byEffectiveAge = ordered.slice().sort((a, b) => {
        const diff = effectiveAges.get(a.chapterId)! - effectiveAges.get(b.chapterId)!;
        if (diff !== 0) return diff;
        return a.chapterId.localeCompare(b.chapterId);
    });
    const summarySet = new Set(byEffectiveAge.slice(0, config.summaryChapters).map(c => c.chapterId));

    const tierByChapterId: Record<string, LodTier> = {};
    for (const ch of ordered) {
        tierByChapterId[ch.chapterId] = summarySet.has(ch.chapterId) ? 'summary' : 'synopsis';
    }

    // 4. Render in oldest→newest order (stable output). Rendered text per chapter
    //    is fixed regardless of tier-promotion/demotion — only the SET of chapters
    //    in each tier changes during the budget cascade.
    const renderChapterText = (ch: ArchiveChapter): string =>
        tierByChapterId[ch.chapterId] === 'summary' ? renderSummary(ch) : renderSynopsis(ch);

    let text = ordered.map(renderChapterText).join('\n\n');
    let tokens = countTokens(text);

    // 5. Budget cascade — demote oldest summary → synopsis one at a time.
    //    `ordered` is oldest→newest, so the first summary-tier chapter in that
    //    order is the OLDEST summary chapter (the one to demote first).
    if (tokens > budgetTokens) {
        for (let i = 0; i < ordered.length && tokens > budgetTokens; i++) {
            const ch = ordered[i];
            if (tierByChapterId[ch.chapterId] === 'summary') {
                tierByChapterId[ch.chapterId] = 'synopsis';
                text = ordered.map(renderChapterText).join('\n\n');
                tokens = countTokens(text);
            }
        }
    }

    // 6. Budget cascade — drop oldest synopsis → 'dropped' one at a time.
    //    We re-render with the surviving (non-dropped) chapters in order.
    if (tokens > budgetTokens) {
        for (let i = 0; i < ordered.length && tokens > budgetTokens; i++) {
            const ch = ordered[i];
            if (tierByChapterId[ch.chapterId] === 'synopsis') {
                tierByChapterId[ch.chapterId] = 'dropped';
                const surviving = ordered.filter(c => tierByChapterId[c.chapterId] !== 'dropped');
                text = surviving.map(renderChapterText).join('\n\n');
                tokens = countTokens(text);
            }
        }
    }

    return { text, tokens, tierByChapterId };
}