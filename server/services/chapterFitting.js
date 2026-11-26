/**
 * Chapter fitting — pure functions over chapters + the scene list.
 *
 * Three separate notions of "how many scenes does this chapter have" existed
 * before this module, and they disagreed:
 *
 *   1. `chapter.sceneCount` — a stored counter incremented on append. Nothing
 *      ever decremented it, because the repair loop in `deleteScene` looked the
 *      chapter up via `sceneIds`, which the desktop server never populates (it
 *      only maintains `sceneCount` and `sceneRange`). So the counter drifted
 *      upward forever.
 *   2. `end - start + 1` — range arithmetic, used by `shouldAutoSeal`. Counts
 *      the gaps left behind by deleted scenes as if those scenes still existed.
 *   3. The number of scenes that actually exist inside the range.
 *
 * (3) is the truth, and it is the only one this module reports. Everything that
 * asks "how full is this chapter" — the card badge, the auto-seal threshold,
 * the delete gate — goes through here.
 *
 * Pure by construction: no file I/O, no locks. Callers read the index and the
 * chapters, pass them in, and persist whatever comes back.
 */

/** Scenes per chapter. The single definition — the UI badge, the auto-seal
 *  threshold and the refit chunk size all read this one number. */
export const CHAPTER_SCENE_TARGET = 25;

/** Parse a scene id ("026", 26, "26") to a number. Null when unparseable. */
export function parseSceneNum(sceneId) {
    const n = parseInt(sceneId, 10);
    return Number.isFinite(n) ? n : null;
}

/** Format a scene number back to the canonical zero-padded id. */
export function formatSceneId(num) {
    return String(num).padStart(3, '0');
}

/**
 * The sorted, de-duplicated list of scene numbers that actually exist.
 *
 * Sorted rather than as-stored: refit chunks this list positionally, so an
 * out-of-order index (restore, import, interrupted append) would otherwise
 * produce chapters whose ranges overlap.
 */
export function sceneNumbersFromIndex(indexEntries) {
    const seen = new Set();
    for (const e of indexEntries ?? []) {
        const n = parseSceneNum(e?.sceneId);
        if (n !== null) seen.add(n);
    }
    return Array.from(seen).sort((a, b) => a - b);
}

/** How many of `sceneNums` fall inside the inclusive range [startId, endId]. */
export function countScenesInRange(sceneNums, startId, endId) {
    const start = parseSceneNum(startId);
    const end = parseSceneNum(endId);
    if (start === null || end === null) return 0;
    let count = 0;
    for (const n of sceneNums) {
        if (n >= start && n <= end) count++;
    }
    return count;
}

// ─── Chapter ids ────────────────────────────────────────────────────────────

/**
 * The next free chapter number: one past the highest already used.
 *
 * Highest-used rather than `chapters.length + 1`, for the same reason
 * `getNextSceneNumber` scans for a max. Length only works while the array is
 * append-only, and it is not: `merge` splices two chapters into one, the
 * rollback cascade filters chapters out, and chapter delete removes them. After
 * any of those, length + 1 names a chapter that already exists — and chapter
 * ids are referenced by divergence entries, timeline events, pinned-chapter
 * settings and the prompts themselves, so a reused id silently merges two
 * chapters' history. A gap in the sequence costs nothing.
 *
 * `split` produces sibling ids (CH02A / CH02B) which both parse to 2 here. That
 * is intentional: the max only needs to exceed every numeric prefix.
 */
export function nextChapterNumber(chapters) {
    let highest = 0;
    for (const ch of chapters ?? []) {
        const match = /^CH(\d+)/.exec(ch?.chapterId ?? '');
        if (!match) continue;
        const n = parseInt(match[1], 10);
        if (Number.isFinite(n) && n > highest) highest = n;
    }
    return highest + 1;
}

/** Format a chapter number as a canonical chapter id. */
export function formatChapterId(num) {
    return `CH${String(num).padStart(2, '0')}`;
}

// ─── Honest counts ──────────────────────────────────────────────────────────

/**
 * Recompute every chapter's `sceneCount` from the scenes that actually exist.
 *
 * Non-destructive: ranges are left exactly as they are, so this is safe to run
 * on every read. A brand-new empty chapter carries a placeholder range like
 * [026, 026] marking where its first scene will land — trimming that to "the
 * scenes it contains" would erase the placeholder. Ranges are only rewritten by
 * `computeRefit`, which the user triggers deliberately.
 *
 * Returns the same array identity-wise where nothing changed, so callers can
 * skip the write when no chapter drifted.
 */
export function hydrateChapters(chapters, sceneNums) {
    let changed = false;
    const hydrated = (chapters ?? []).map(ch => {
        const count = countScenesInRange(sceneNums, ch?.sceneRange?.[0], ch?.sceneRange?.[1]);
        if (ch?.sceneCount === count) return ch;
        changed = true;
        return { ...ch, sceneCount: count };
    });
    return { chapters: hydrated, changed };
}

/**
 * Repair chapters after a scene was deleted.
 *
 * Recomputes counts, drops the dead id from `sceneIds` (empty on desktop, but
 * populated on saves that originated elsewhere), and marks any chapter that
 * actually lost a scene `invalidated` — its summary now describes prose that no
 * longer exists, which is what the per-chapter Repair button is for.
 *
 * Deliberately does NOT unseal. The previous implementation did, and that was a
 * latent hazard: the append path takes the FIRST chapter without `sealedAt` as
 * the open one, so unsealing a chapter in the middle of the book would have
 * sent new scenes into it while the real trailing chapter sat idle. Marking it
 * invalidated communicates the same "needs regenerating" without moving where
 * the story is being written.
 *
 * Boundaries are left alone — reflowing is `computeRefit`, and it only runs
 * when the user asks.
 */
export function repairChaptersAfterSceneDelete(chapters, sceneNums, deletedSceneId) {
    const deleted = parseSceneNum(deletedSceneId);
    let changed = false;

    const repaired = (chapters ?? []).map(ch => {
        const count = countScenesInRange(sceneNums, ch?.sceneRange?.[0], ch?.sceneRange?.[1]);
        const storedIds = ch?.sceneIds ?? [];
        const keptIds = deleted === null
            ? storedIds
            : storedIds.filter(id => parseSceneNum(id) !== deleted);

        const countMoved = ch?.sceneCount !== count;
        const idsMoved = keptIds.length !== storedIds.length;
        if (!countMoved && !idsMoved) return ch;

        changed = true;
        const next = { ...ch, sceneCount: count };
        if (idsMoved) next.sceneIds = keptIds;
        // Only a chapter that actually lost a scene has a stale summary. A
        // chapter whose stored counter was merely wrong gets corrected quietly.
        if (idsMoved || (countMoved && count < (ch?.sceneCount ?? 0))) {
            next.invalidated = true;
        }
        return next;
    });

    return { chapters: repaired, changed };
}

/**
 * Whether a chapter holds nothing worth keeping — the gate for deletion.
 *
 * Deliberately not keyed on `sealedAt`: a chapter with no scenes and no written
 * prose has no historical record to protect, sealed or not. Deliberately not
 * keyed on `sceneIds` either, since that array is empty on every desktop
 * chapter and would make this vacuously true.
 *
 * Expects a hydrated chapter — `sceneCount` must be the real count, or this
 * reports a drifted chapter as non-empty forever.
 */
export function isChapterEmpty(chapter) {
    if (!chapter) return false;
    if ((chapter.sceneCount ?? 0) > 0) return false;
    if ((chapter.sceneIds ?? []).length > 0) return false;
    const hasProse = [chapter.summary, chapter.synopsis]
        .some(v => typeof v === 'string' && v.trim().length > 0);
    return !hasProse;
}

// ─── Refit ──────────────────────────────────────────────────────────────────

/**
 * Reflow chapter boundaries so every chapter holds exactly `size` scenes, with
 * the remainder left open at the end.
 *
 * Chapters on desktop are windows over the scene list, not containers of it —
 * no prose moves, no embeddings change (archive vectors are keyed by scene id,
 * which refit never touches). Only the [start, end] pairs are rewritten.
 *
 * Gaps are absorbed: chunking the *existing* scene numbers means a chapter that
 * lost a scene to deletion simply reaches one scene further to stay full, so
 * its range may span more numbers than it holds scenes.
 *
 * The trailing chapter is always left open, even when it happens to be exactly
 * full — that guarantees exactly one open chapter for the append path to find,
 * and auto-seal closes it on the next turn.
 *
 * Regeneration is suffix-only. Chapters before the first boundary change keep
 * their windows and their summaries untouched; only those from `firstChangedIndex`
 * onward are marked `invalidated`. Deleting a scene in the newest chapter
 * therefore costs nothing to re-summarize.
 *
 * @returns {{
 *   chapters: object[],
 *   firstChangedIndex: number,   // -1 when nothing moved
 *   changedCount: number,        // chapters needing regeneration
 *   sceneToChapter: Map<number, string>,  // scene number -> owning chapter id
 *   removedChapterIds: string[],
 * }}
 */
export function computeRefit(chapters, sceneNums, size = CHAPTER_SCENE_TARGET) {
    const existing = chapters ?? [];

    const chunks = [];
    for (let i = 0; i < sceneNums.length; i += size) {
        chunks.push(sceneNums.slice(i, i + size));
    }
    // No scenes at all: leave the chapter list exactly as it is. There is
    // nothing to fit, and wiping placeholders would strand the append path.
    if (chunks.length === 0) {
        return {
            chapters: existing,
            firstChangedIndex: -1,
            changedCount: 0,
            sceneToChapter: new Map(),
            removedChapterIds: [],
        };
    }

    const fitted = [];
    const sceneToChapter = new Map();
    let nextNum = nextChapterNumber(existing);

    const blankChapter = () => {
        const num = nextNum++;
        return {
            chapterId: formatChapterId(num),
            title: `Chapter ${num}`,
            sceneIds: [],
            summary: '',
            keywords: [],
            npcs: [],
            majorEvents: [],
            unresolvedThreads: [],
            tone: '',
            themes: [],
        };
    };

    // When the scenes divide evenly, the final chunk is a complete chapter and
    // belongs sealed — the open chapter is then a separate empty placeholder
    // after it, which is exactly the steady state the append path produces. Only
    // a partial final chunk is itself the open chapter.
    const lastChunkFull = chunks[chunks.length - 1].length === size;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const isTrailingPartial = i === chunks.length - 1 && !lastChunkFull;

        const next = {
            ...(existing[i] ?? blankChapter()),
            sceneRange: [formatSceneId(chunk[0]), formatSceneId(chunk[chunk.length - 1])],
            sceneCount: chunk.length,
        };

        if (isTrailingPartial) {
            delete next.sealedAt;
        } else if (!next.sealedAt) {
            next.sealedAt = Date.now();
        }

        for (const n of chunk) sceneToChapter.set(n, next.chapterId);
        fitted.push(next);
    }

    // Evenly-divided: keep (or add) the empty open chapter that marks where the
    // next scene lands. Reusing the one already there matters — recreating it
    // would churn its id and report a change on a campaign that is already
    // correctly fitted.
    if (lastChunkFull) {
        const nextSceneId = formatSceneId(sceneNums[sceneNums.length - 1] + 1);
        const currentTail = existing[chunks.length];
        const reusable = currentTail && (currentTail.sceneCount ?? 0) === 0 && !currentTail.sealedAt;
        const tail = { ...(reusable ? currentTail : blankChapter()), sceneRange: [nextSceneId, nextSceneId], sceneCount: 0 };
        delete tail.sealedAt;
        fitted.push(tail);
    }

    // Find the first chapter whose window actually moved. Everything before it
    // is byte-identical and keeps its summary.
    let firstChangedIndex = -1;
    for (let i = 0; i < fitted.length; i++) {
        const before = existing[i];
        const after = fitted[i];
        const moved = !before
            || before.sceneRange?.[0] !== after.sceneRange[0]
            || before.sceneRange?.[1] !== after.sceneRange[1]
            || Boolean(before.sealedAt) !== Boolean(after.sealedAt);
        if (moved) { firstChangedIndex = i; break; }
    }

    if (firstChangedIndex >= 0) {
        for (let i = firstChangedIndex; i < fitted.length; i++) {
            fitted[i] = { ...fitted[i], invalidated: true };
        }
    }

    // Chapters past what the fit produced hold no scenes — leftovers from when
    // the list shrank.
    const removedChapterIds = existing.slice(fitted.length).map(c => c?.chapterId).filter(Boolean);

    return {
        chapters: fitted,
        firstChangedIndex,
        changedCount: firstChangedIndex < 0 ? 0 : fitted.length - firstChangedIndex,
        sceneToChapter,
        removedChapterIds,
    };
}

/**
 * Repoint records that remember which chapter a scene belonged to.
 *
 * Divergence entries and timeline events both carry a `chapterId` stamped when
 * they were extracted. Refit can move a scene into a different chapter, and a
 * stale `chapterId` would attribute the fact to the wrong chapter in the
 * payload — silently, since nothing validates it.
 *
 * `sceneField` differs by record type: divergence entries key on `sceneRef`,
 * timeline events on `sceneId`.
 */
export function repointChapterIds(records, sceneToChapter, sceneField) {
    let repointed = 0;
    const out = (records ?? []).map(rec => {
        const n = parseSceneNum(rec?.[sceneField]);
        if (n === null) return rec;
        const owner = sceneToChapter.get(n);
        if (!owner || rec.chapterId === owner) return rec;
        repointed++;
        return { ...rec, chapterId: owner };
    });
    return { records: out, repointed };
}
