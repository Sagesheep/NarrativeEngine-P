import { describe, it, expect } from 'vitest';
import {
    CHAPTER_SCENE_TARGET,
    sceneNumbersFromIndex,
    countScenesInRange,
    nextChapterNumber,
    formatChapterId,
    hydrateChapters,
    repairChaptersAfterSceneDelete,
    isChapterEmpty,
    computeRefit,
    repointChapterIds,
} from '../services/chapterFitting.js';

const pad = (n) => String(n).padStart(3, '0');
const idx = (nums) => nums.map(n => ({ sceneId: pad(n) }));

const chapter = (id, start, end, extra = {}) => ({
    chapterId: id,
    title: `Chapter ${id}`,
    sceneRange: [pad(start), pad(end)],
    sceneIds: [],
    summary: '',
    keywords: [],
    npcs: [],
    majorEvents: [],
    unresolvedThreads: [],
    tone: '',
    themes: [],
    sceneCount: end - start + 1,
    ...extra,
});

describe('sceneNumbersFromIndex', () => {
    it('sorts and de-duplicates', () => {
        const entries = [{ sceneId: '003' }, { sceneId: '001' }, { sceneId: '003' }];
        expect(sceneNumbersFromIndex(entries)).toEqual([1, 3]);
    });

    it('skips unparseable and missing ids', () => {
        const entries = [{ sceneId: '002' }, { sceneId: 'abc' }, {}, null];
        expect(sceneNumbersFromIndex(entries)).toEqual([2]);
    });

    it('tolerates a missing index', () => {
        expect(sceneNumbersFromIndex(undefined)).toEqual([]);
    });
});

describe('countScenesInRange', () => {
    it('counts scenes that exist, not the width of the range', () => {
        // 010 was deleted — the range still spans 25 numbers but holds 24 scenes.
        const nums = sceneNumbersFromIndex(idx([...Array(25)].map((_, i) => i + 1).filter(n => n !== 10)));
        expect(countScenesInRange(nums, '001', '025')).toBe(24);
    });

    it('returns 0 for an unparseable range', () => {
        expect(countScenesInRange([1, 2, 3], undefined, '003')).toBe(0);
    });
});

describe('nextChapterNumber', () => {
    it('is one past the highest used, not the array length', () => {
        expect(nextChapterNumber([chapter('CH01', 1, 25), chapter('CH03', 26, 50)])).toBe(4);
    });

    it('does not collide after a merge shortens the array', () => {
        // The live bug: merge splices two chapters into one, so length + 1 named
        // CH03 — which still existed.
        const afterMerge = [chapter('CH01', 1, 50), chapter('CH03', 51, 75)];
        expect(formatChapterId(nextChapterNumber(afterMerge))).toBe('CH04');
    });

    it('does not collide after a delete in the middle', () => {
        const afterDelete = [chapter('CH01', 1, 25), chapter('CH03', 51, 75)];
        expect(formatChapterId(nextChapterNumber(afterDelete))).toBe('CH04');
    });

    it('clears split siblings, which share a numeric prefix', () => {
        const afterSplit = [chapter('CH01', 1, 25), chapter('CH02A', 26, 30), chapter('CH02B', 31, 50)];
        expect(nextChapterNumber(afterSplit)).toBe(3);
    });

    it('starts at 1 for an empty list', () => {
        expect(nextChapterNumber([])).toBe(1);
        expect(nextChapterNumber(undefined)).toBe(1);
    });
});

describe('hydrateChapters', () => {
    it('corrects a counter that drifted after deletions', () => {
        const nums = sceneNumbersFromIndex(idx([1, 2, 3]));
        const stored = [chapter('CH01', 1, 5)]; // claims 5, holds 3
        const { chapters, changed } = hydrateChapters(stored, nums);
        expect(changed).toBe(true);
        expect(chapters[0].sceneCount).toBe(3);
    });

    it('reports no change when counts already match', () => {
        const nums = sceneNumbersFromIndex(idx([1, 2, 3]));
        const stored = [chapter('CH01', 1, 3)];
        const { changed } = hydrateChapters(stored, nums);
        expect(changed).toBe(false);
    });

    it('leaves a new empty chapter its placeholder range', () => {
        // createDefaultChapter marks where the first scene will land as [s, s].
        // Trimming that to "scenes it contains" would erase the placeholder.
        const nums = sceneNumbersFromIndex(idx([1, 2, 3]));
        const stored = [chapter('CH02', 4, 4, { sceneCount: 0 })];
        const { chapters } = hydrateChapters(stored, nums);
        expect(chapters[0].sceneRange).toEqual(['004', '004']);
        expect(chapters[0].sceneCount).toBe(0);
    });
});

describe('repairChaptersAfterSceneDelete', () => {
    it('recomputes the count and flags the summary stale', () => {
        const nums = sceneNumbersFromIndex(idx([2]));
        const stored = [chapter('CH01', 1, 2, { sealedAt: 1, sceneIds: ['001', '002'] })];
        const { chapters, changed } = repairChaptersAfterSceneDelete(stored, nums, '001');
        expect(changed).toBe(true);
        expect(chapters[0].sceneCount).toBe(1);
        expect(chapters[0].sceneIds).toEqual(['002']);
        expect(chapters[0].invalidated).toBe(true);
    });

    it('does not unseal — that would move where new scenes get written', () => {
        const nums = sceneNumbersFromIndex(idx([2]));
        const stored = [chapter('CH01', 1, 2, { sealedAt: 1234, sceneIds: ['001', '002'] })];
        const { chapters } = repairChaptersAfterSceneDelete(stored, nums, '001');
        expect(chapters[0].sealedAt).toBe(1234);
    });

    it('works on desktop chapters, which never populate sceneIds', () => {
        const nums = sceneNumbersFromIndex(idx([2, 3]));
        const stored = [chapter('CH01', 1, 3, { sealedAt: 1 })]; // sceneIds: []
        const { chapters, changed } = repairChaptersAfterSceneDelete(stored, nums, '001');
        expect(changed).toBe(true);
        expect(chapters[0].sceneCount).toBe(2);
        expect(chapters[0].invalidated).toBe(true);
    });

    it('leaves untouched chapters alone', () => {
        const nums = sceneNumbersFromIndex(idx([1, 2, 30]));
        const stored = [
            chapter('CH01', 1, 2, { sealedAt: 1 }),
            chapter('CH02', 30, 30, { sceneCount: 1 }),
        ];
        const { chapters } = repairChaptersAfterSceneDelete(stored, nums, '031');
        expect(chapters[0]).toBe(stored[0]);
        expect(chapters[1]).toBe(stored[1]);
    });

    it('corrects an inflated counter quietly, without flagging the summary', () => {
        // Drift from before the repair existed: the count was wrong, but no
        // scene was lost in this operation, so the summary is still accurate.
        const nums = sceneNumbersFromIndex(idx([1, 2, 3]));
        const stored = [chapter('CH01', 1, 3, { sceneCount: 2, sealedAt: 1 })];
        const { chapters, changed } = repairChaptersAfterSceneDelete(stored, nums, '099');
        expect(changed).toBe(true);
        expect(chapters[0].sceneCount).toBe(3);
        expect(chapters[0].invalidated).toBeUndefined();
    });
});

describe('isChapterEmpty', () => {
    it('is true for a fresh chapter', () => {
        expect(isChapterEmpty(chapter('CH02', 26, 26, { sceneCount: 0 }))).toBe(true);
    });

    it('is false when it holds scenes', () => {
        expect(isChapterEmpty(chapter('CH01', 1, 25))).toBe(false);
    });

    it('is false when it has a summary but no scenes', () => {
        const ch = chapter('CH02', 26, 26, { sceneCount: 0, summary: 'Something happened.' });
        expect(isChapterEmpty(ch)).toBe(false);
    });

    it('is false when it has a synopsis but no scenes', () => {
        const ch = chapter('CH02', 26, 26, { sceneCount: 0, synopsis: 'A synopsis.' });
        expect(isChapterEmpty(ch)).toBe(false);
    });

    it('ignores sealedAt — an empty sealed chapter has no record to protect', () => {
        const ch = chapter('CH02', 26, 26, { sceneCount: 0, sealedAt: Date.now() });
        expect(isChapterEmpty(ch)).toBe(true);
    });

    it('is not fooled by whitespace-only prose', () => {
        const ch = chapter('CH02', 26, 26, { sceneCount: 0, summary: '   \n  ' });
        expect(isChapterEmpty(ch)).toBe(true);
    });
});

describe('computeRefit', () => {
    it('reflows 25 / 23 / 25 into 25 / 25 / 23 with the last left open', () => {
        // CH02 lost scenes 030 and 040 to deletion, so it holds 23.
        const all = [...Array(75)].map((_, i) => i + 1).filter(n => n !== 30 && n !== 40);
        const nums = sceneNumbersFromIndex(idx(all));
        expect(nums.length).toBe(73);

        const stored = [
            chapter('CH01', 1, 25, { sealedAt: 1 }),
            chapter('CH02', 26, 50, { sealedAt: 2, sceneCount: 23 }),
            chapter('CH03', 51, 75, { sealedAt: 3 }),
        ];

        const { chapters, firstChangedIndex, changedCount } = computeRefit(stored, nums, CHAPTER_SCENE_TARGET);

        expect(chapters.map(c => c.sceneCount)).toEqual([25, 25, 23]);
        // CH01 is untouched, so regeneration starts at CH02.
        expect(firstChangedIndex).toBe(1);
        expect(changedCount).toBe(2);
        expect(chapters[0].invalidated).toBeUndefined();
        expect(chapters[1].invalidated).toBe(true);
        // The trailing chapter is reopened because it is no longer full.
        expect(chapters[2].sealedAt).toBeUndefined();
    });

    it('lets a full chapter reach past a gap to stay full', () => {
        const all = [...Array(75)].map((_, i) => i + 1).filter(n => n !== 30 && n !== 40);
        const nums = sceneNumbersFromIndex(idx(all));
        const stored = [chapter('CH01', 1, 25, { sealedAt: 1 }), chapter('CH02', 26, 50, { sealedAt: 2 })];

        const { chapters } = computeRefit(stored, nums, CHAPTER_SCENE_TARGET);
        // 25 scenes starting at 026 must span to 052, since 030 and 040 are gone.
        expect(chapters[1].sceneRange).toEqual(['026', '052']);
        expect(chapters[1].sceneCount).toBe(25);
    });

    it('leaves earlier chapters completely untouched', () => {
        const nums = sceneNumbersFromIndex(idx([...Array(60)].map((_, i) => i + 1)));
        const stored = [
            chapter('CH01', 1, 25, { sealedAt: 1, summary: 'first' }),
            chapter('CH02', 26, 50, { sealedAt: 2, summary: 'second' }),
            chapter('CH03', 51, 60, { sceneCount: 10 }),
        ];
        const { chapters, firstChangedIndex } = computeRefit(stored, nums, CHAPTER_SCENE_TARGET);
        expect(firstChangedIndex).toBe(-1);
        expect(chapters[0].summary).toBe('first');
        expect(chapters[1].summary).toBe('second');
    });

    it('creates chapters when the scene list outgrows them', () => {
        const nums = sceneNumbersFromIndex(idx([...Array(60)].map((_, i) => i + 1)));
        const stored = [chapter('CH01', 1, 25, { sealedAt: 1 })];
        const { chapters } = computeRefit(stored, nums, CHAPTER_SCENE_TARGET);
        expect(chapters).toHaveLength(3);
        expect(chapters.map(c => c.sceneCount)).toEqual([25, 25, 10]);
        // New ids clear every number already in use.
        expect(chapters[1].chapterId).toBe('CH02');
        expect(chapters[2].chapterId).toBe('CH03');
    });

    it('keeps the empty open chapter that marks where the next scene lands', () => {
        const nums = sceneNumbersFromIndex(idx([...Array(25)].map((_, i) => i + 1)));
        const stored = [
            chapter('CH01', 1, 25, { sealedAt: 1 }),
            chapter('CH02', 26, 26, { sceneCount: 0 }),
        ];
        const { chapters, removedChapterIds, firstChangedIndex } = computeRefit(stored, nums, CHAPTER_SCENE_TARGET);
        expect(chapters).toHaveLength(2);
        expect(chapters[1].chapterId).toBe('CH02');
        expect(removedChapterIds).toEqual([]);
        // Already correctly fitted — nothing to regenerate.
        expect(firstChangedIndex).toBe(-1);
    });

    it('drops leftover placeholders beyond the open chapter', () => {
        const nums = sceneNumbersFromIndex(idx([...Array(25)].map((_, i) => i + 1)));
        const stored = [
            chapter('CH01', 1, 25, { sealedAt: 1 }),
            chapter('CH02', 26, 26, { sceneCount: 0 }),
            chapter('CH03', 27, 27, { sceneCount: 0 }),
        ];
        const { chapters, removedChapterIds } = computeRefit(stored, nums, CHAPTER_SCENE_TARGET);
        expect(chapters).toHaveLength(2);
        expect(removedChapterIds).toEqual(['CH03']);
    });

    it('leaves the chapter list alone when there are no scenes', () => {
        const stored = [chapter('CH01', 1, 1, { sceneCount: 0 })];
        const { chapters, firstChangedIndex } = computeRefit(stored, [], CHAPTER_SCENE_TARGET);
        expect(chapters).toBe(stored);
        expect(firstChangedIndex).toBe(-1);
    });

    it('seals a full final chunk and adds an empty open chapter after it', () => {
        // Guarantees the append path always finds exactly one open chapter,
        // without reopening a chapter that is legitimately complete.
        const nums = sceneNumbersFromIndex(idx([...Array(50)].map((_, i) => i + 1)));
        const stored = [chapter('CH01', 1, 25, { sealedAt: 1 }), chapter('CH02', 26, 50, { sealedAt: 2 })];
        const { chapters } = computeRefit(stored, nums, CHAPTER_SCENE_TARGET);
        expect(chapters).toHaveLength(3);
        expect(chapters[1].sealedAt).toBe(2);
        expect(chapters[2].sceneCount).toBe(0);
        expect(chapters[2].sceneRange).toEqual(['051', '051']);
        expect(chapters.filter(c => !c.sealedAt)).toHaveLength(1);
    });

    it('is a no-op on a campaign that is already correctly fitted', () => {
        // The real shape a long campaign settles into: N full sealed chapters
        // plus an empty open one waiting for the next scene.
        const nums = sceneNumbersFromIndex(idx([...Array(50)].map((_, i) => i + 1)));
        const stored = [
            chapter('CH01', 1, 25, { sealedAt: 1 }),
            chapter('CH02', 26, 50, { sealedAt: 2 }),
            chapter('CH03', 51, 51, { sceneCount: 0 }),
        ];
        const { firstChangedIndex, changedCount, removedChapterIds } = computeRefit(stored, nums, CHAPTER_SCENE_TARGET);
        expect(firstChangedIndex).toBe(-1);
        expect(changedCount).toBe(0);
        expect(removedChapterIds).toEqual([]);
    });

    it('maps every scene to its owning chapter', () => {
        const nums = sceneNumbersFromIndex(idx([...Array(30)].map((_, i) => i + 1)));
        const stored = [chapter('CH01', 1, 30, { sceneCount: 30 })];
        const { sceneToChapter } = computeRefit(stored, nums, CHAPTER_SCENE_TARGET);
        expect(sceneToChapter.get(25)).toBe('CH01');
        expect(sceneToChapter.get(26)).toBe('CH02');
    });
});

describe('repointChapterIds', () => {
    it('restamps records whose scene moved to another chapter', () => {
        const sceneToChapter = new Map([[26, 'CH02']]);
        const entries = [{ id: 'e1', sceneRef: '026', chapterId: 'CH01' }];
        const { records, repointed } = repointChapterIds(entries, sceneToChapter, 'sceneRef');
        expect(repointed).toBe(1);
        expect(records[0].chapterId).toBe('CH02');
    });

    it('leaves records whose chapter did not change', () => {
        const sceneToChapter = new Map([[26, 'CH02']]);
        const entries = [{ id: 'e1', sceneRef: '026', chapterId: 'CH02' }];
        const { records, repointed } = repointChapterIds(entries, sceneToChapter, 'sceneRef');
        expect(repointed).toBe(0);
        expect(records[0]).toBe(entries[0]);
    });

    it('leaves records for scenes that are not in the map', () => {
        const { records, repointed } = repointChapterIds(
            [{ sceneId: '999', chapterId: 'CH01' }], new Map([[1, 'CH01']]), 'sceneId',
        );
        expect(repointed).toBe(0);
        expect(records[0].chapterId).toBe('CH01');
    });
});
