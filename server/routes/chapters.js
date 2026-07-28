import { Router } from 'express';
import { readJson, writeJson, chaptersPath, archiveIndexPath, getNextSceneNumber, createDefaultChapter } from '../lib/fileStore.js';
import { withCampaignLock } from '../lib/writeLock.js';
import { wrapAsync } from '../lib/asyncHandler.js';
import {
    sceneNumbersFromIndex, hydrateChapters, isChapterEmpty,
    nextChapterNumber, formatChapterId,
} from '../services/chapterFitting.js';
import { refitChapters, previewRefitChapters } from '../services/archiveService.js';

/**
 * Read the chapters with their `sceneCount` recomputed from the scenes that
 * actually exist, persisting the correction when it drifted.
 *
 * Every handler that decides anything from a count goes through here. The
 * stored counter is only ever incremented on append — before this it could
 * claim 25 for a chapter holding 23, which is what made "is this chapter
 * empty?" unanswerable.
 */
function readHydratedChapters(campaignId) {
    const cp = chaptersPath(campaignId);
    const stored = readJson(cp, []);
    const sceneNums = sceneNumbersFromIndex(readJson(archiveIndexPath(campaignId), []));
    const { chapters, changed } = hydrateChapters(stored, sceneNums);
    if (changed) writeJson(cp, chapters);
    return chapters;
}

export function createChaptersRouter() {
    const router = Router();

    // ═══════════════════════════════════════════
    //  Chapters (Tier 4.5)
    // ═══════════════════════════════════════════

    router.get('/api/campaigns/:id/archive/chapters', wrapAsync((req, res) => {
        res.json(readHydratedChapters(req.params.id));
    }));

    router.put('/api/campaigns/:id/archive/chapters', wrapAsync(async (req, res) => {
        if (!Array.isArray(req.body)) {
            return res.status(400).json({ error: 'Expected an array of chapters' });
        }
        await withCampaignLock(req.params.id, () => {
            writeJson(chaptersPath(req.params.id), req.body);
        });
        res.json(req.body);
    }));

    // Create is locked because it is a read-modify-write on a shared file. Two
    // rapid clicks on "New" used to arrive concurrently, both read the same
    // list, both derive the same id, and the second write clobbered the first —
    // the double-click bug the UI's disabled-button guard could never fully
    // close from the client side.
    router.post('/api/campaigns/:id/archive/chapters', wrapAsync(async (req, res) => {
        const newChapter = await withCampaignLock(req.params.id, () => {
            const cp = chaptersPath(req.params.id);
            const existing = readJson(cp, []);

            const nextNum = nextChapterNumber(existing);
            const nextScene = getNextSceneNumber(req.params.id);

            const chapter = createDefaultChapter(
                formatChapterId(nextNum),
                req.body.title || `Chapter ${nextNum}`,
                String(nextScene).padStart(3, '0'),
            );

            existing.push(chapter);
            writeJson(cp, existing);
            return chapter;
        });
        res.json(newChapter);
    }));

    router.patch('/api/campaigns/:id/archive/chapters/:chapterId', wrapAsync(async (req, res) => {
        const result = await withCampaignLock(req.params.id, () => {
            const cp = chaptersPath(req.params.id);
            const existing = readJson(cp, []);
            const idx = existing.findIndex(c => c.chapterId === req.params.chapterId);
            if (idx === -1) return null;

            const allowed = [
                'title', 'summary', 'keywords', 'npcs',
                'majorEvents', 'unresolvedThreads', 'tone', 'themes', 'invalidated',
                'sceneIds',
                // WO-06: optional synopsis/title-variant fields. Persistence rides
                // the existing ...result.summary spread in postTurnPipeline.ts.
                'synopsis', 'abstractTitle', 'literalTitle'
            ];
            for (const key of allowed) {
                if (req.body[key] !== undefined) {
                    existing[idx][key] = req.body[key];
                }
            }

            writeJson(cp, existing);
            return existing[idx];
        });

        if (!result) return res.status(404).json({ error: 'Chapter not found' });
        res.json(result);
    }));

    // DELETE /api/campaigns/:id/archive/chapters/:chapterId — remove an empty chapter
    //
    // Only ever removes a chapter that holds nothing: no scenes, no summary, no
    // synopsis. A chapter with scenes is entangled with the archive prose, the
    // vector index, the timeline and the divergence register — removing it as a
    // simple list splice would strand all of that. The operation that removes a
    // chapter *and* its scenes correctly already exists: `rollbackToScene`.
    router.delete('/api/campaigns/:id/archive/chapters/:chapterId', wrapAsync(async (req, res) => {
        const result = await withCampaignLock(req.params.id, () => {
            const cp = chaptersPath(req.params.id);
            const chapters = readHydratedChapters(req.params.id);
            const idx = chapters.findIndex(c => c.chapterId === req.params.chapterId);
            if (idx === -1) return { status: 404, body: { error: 'Chapter not found' } };

            const chapter = chapters[idx];
            if (!isChapterEmpty(chapter)) {
                return {
                    status: 409,
                    body: {
                        error: 'Chapter is not empty',
                        sceneCount: chapter.sceneCount ?? 0,
                        hint: 'Only chapters with no scenes and no summary can be deleted. To remove a chapter that has scenes, roll back to its first scene.',
                    },
                };
            }

            chapters.splice(idx, 1);
            writeJson(cp, chapters);
            return { status: 200, body: { ok: true, deletedChapterId: chapter.chapterId, chapters } };
        });

        res.status(result.status).json(result.body);
    }));

    // GET .../chapters/refit/preview — what a refit would cost, without doing it
    router.get('/api/campaigns/:id/archive/chapters/refit/preview', wrapAsync((req, res) => {
        res.json(previewRefitChapters(req.params.id));
    }));

    // POST .../chapters/refit — reflow boundaries to 25 scenes each
    router.post('/api/campaigns/:id/archive/chapters/refit', wrapAsync(async (req, res) => {
        res.json(await refitChapters(req.params.id));
    }));

    // POST /api/campaigns/:id/archive/chapters/seal — Manual seal trigger
    router.post('/api/campaigns/:id/archive/chapters/seal', wrapAsync(async (req, res) => {
        const result = await withCampaignLock(req.params.id, () => {
            const cp = chaptersPath(req.params.id);
            const existing = readJson(cp, []);
            const openChapter = existing.find(c => !c.sealedAt);

            if (!openChapter) return null;

            // Seal the open chapter
            const sealed = {
                ...openChapter,
                sealedAt: Date.now(),
            };

            // Update title if provided
            if (req.body.title) {
                sealed.title = req.body.title;
            }

            // Determine next scene number
            const lastScene = parseInt(sealed.sceneRange[1], 10);
            const nextScene = String(lastScene + 1).padStart(3, '0');

            // Create new open chapter
            const nextChapterNum = nextChapterNumber(existing);
            const newOpen = createDefaultChapter(
                formatChapterId(nextChapterNum),
                'Open Chapter',
                nextScene,
            );

            // Replace open chapter with sealed, add new open chapter
            const openIdx = existing.findIndex(c => c.chapterId === openChapter.chapterId);
            existing[openIdx] = sealed;
            existing.push(newOpen);

            writeJson(cp, existing);
            return { sealedChapter: sealed, newOpenChapter: newOpen };
        });

        if (!result) return res.status(400).json({ error: 'No open chapter to seal' });
        res.json(result);
    }));

    // POST /api/campaigns/:id/archive/chapters/merge — Merge two adjacent chapters
    router.post('/api/campaigns/:id/archive/chapters/merge', wrapAsync(async (req, res) => {
        const { chapterIdA, chapterIdB } = req.body;

        const result = await withCampaignLock(req.params.id, () => {
            const cp = chaptersPath(req.params.id);
            const existing = readJson(cp, []);

            const idxA = existing.findIndex(c => c.chapterId === chapterIdA);
            const idxB = existing.findIndex(c => c.chapterId === chapterIdB);

            if (idxA === -1 || idxB === -1) {
                return { status: 404, body: { error: 'One or both chapters not found' } };
            }

            // Validate adjacency by array position
            const isAdjacent = Math.abs(idxA - idxB) === 1;
            if (!isAdjacent) {
                return { status: 400, body: { error: 'Chapters must be adjacent to merge' } };
            }

            const firstIdx = Math.min(idxA, idxB);
            const secondIdx = Math.max(idxA, idxB);

            const chapterA = existing[firstIdx];
            const chapterB = existing[secondIdx];

            // Merged chapter
            const merged = {
                ...chapterA,
                title: `${chapterA.title} & ${chapterB.title}`,
                sceneRange: [chapterA.sceneRange[0], chapterB.sceneRange[1]],
                sceneCount: (chapterA.sceneCount || 0) + (chapterB.sceneCount || 0),
                keywords: Array.from(new Set([...(chapterA.keywords || []), ...(chapterB.keywords || [])])),
                npcs: Array.from(new Set([...(chapterA.npcs || []), ...(chapterB.npcs || [])])),
                invalidated: true,
                summary: `[MERGED] ${chapterA.summary}\n\n${chapterB.summary}`,
            };

            // Remove the two old ones, insert the merged one
            existing.splice(firstIdx, 2, merged);

            writeJson(cp, existing);
            return { status: 200, body: merged };
        });

        res.status(result.status).json(result.body);
    }));

    // POST /api/campaigns/:id/archive/chapters/:chapterId/split — Split a chapter at a scene
    router.post('/api/campaigns/:id/archive/chapters/:chapterId/split', wrapAsync(async (req, res) => {
        const { atSceneId } = req.body;

        const result = await withCampaignLock(req.params.id, () => {
            const cp = chaptersPath(req.params.id);
            const existing = readJson(cp, []);

            const idx = existing.findIndex(c => c.chapterId === req.params.chapterId);
            if (idx === -1) return { status: 404, body: { error: 'Chapter not found' } };

            const chapter = existing[idx];
            const startNum = parseInt(chapter.sceneRange[0], 10);
            const endNum = parseInt(chapter.sceneRange[1], 10);
            const splitNum = parseInt(atSceneId, 10);

            if (splitNum <= startNum || splitNum > endNum) {
                return { status: 400, body: { error: 'Split point must be within chapter range (excluding start)' } };
            }

            const chapterA = {
                ...chapter,
                chapterId: `${chapter.chapterId}A`,
                sceneRange: [chapter.sceneRange[0], String(splitNum - 1).padStart(3, '0')],
                sceneCount: splitNum - startNum,
                invalidated: true,
            };

            const chapterB = {
                ...chapter,
                chapterId: `${chapter.chapterId}B`,
                sceneRange: [String(splitNum).padStart(3, '0'), chapter.sceneRange[1]],
                sceneCount: endNum - splitNum + 1,
                invalidated: true,
            };

            // Replace original with the two new halves
            existing.splice(idx, 1, chapterA, chapterB);

            writeJson(cp, existing);
            return { status: 200, body: { chapterA, chapterB } };
        });

        res.status(result.status).json(result.body);
    }));

    return router;
}
