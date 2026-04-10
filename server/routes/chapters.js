import { Router } from 'express';
import { readJson, writeJson, chaptersPath, getNextSceneNumber } from '../lib/fileStore.js';

export function createChaptersRouter() {
    const router = Router();

    // ═══════════════════════════════════════════
    //  Chapters (Tier 4.5)
    // ═══════════════════════════════════════════

    router.get('/api/campaigns/:id/archive/chapters', (req, res) => {
        const chapters = readJson(chaptersPath(req.params.id), []);
        res.json(chapters);
    });

    router.post('/api/campaigns/:id/archive/chapters', (req, res) => {
        const cp = chaptersPath(req.params.id);
        const existing = readJson(cp, []);

        // Auto-assign ID: CH01, CH02, etc.
        const nextNum = existing.length + 1;
        const chapterId = `CH${String(nextNum).padStart(2, '0')}`;

        // Default scene range: starting from next available scene
        const nextScene = getNextSceneNumber(req.params.id);
        const nextSceneId = String(nextScene).padStart(3, '0');

        const newChapter = {
            chapterId,
            title: req.body.title || `Chapter ${nextNum}`,
            sceneRange: [nextSceneId, nextSceneId],
            summary: '',
            keywords: [],
            npcs: [],
            majorEvents: [],
            unresolvedThreads: [],
            tone: '',
            themes: [],
            sceneCount: 0,
            // sealedAt is undefined -> open chapter
        };

        existing.push(newChapter);
        writeJson(cp, existing);
        res.json(newChapter);
    });

    router.patch('/api/campaigns/:id/archive/chapters/:chapterId', (req, res) => {
        const cp = chaptersPath(req.params.id);
        const existing = readJson(cp, []);
        const idx = existing.findIndex(c => c.chapterId === req.params.chapterId);

        if (idx === -1) return res.status(404).json({ error: 'Chapter not found' });

        // Only allow editing title for now
        if (req.body.title !== undefined) {
            existing[idx].title = req.body.title;
        }

        writeJson(cp, existing);
        res.json(existing[idx]);
    });

    // POST /api/campaigns/:id/archive/chapters/seal — Manual seal trigger
    router.post('/api/campaigns/:id/archive/chapters/seal', (req, res) => {
        const cp = chaptersPath(req.params.id);
        const existing = readJson(cp, []);
        const openChapter = existing.find(c => !c.sealedAt);

        if (!openChapter) {
            return res.status(400).json({ error: 'No open chapter to seal' });
        }

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
        const nextChapterNum = existing.length + 1;
        const newOpen = {
            chapterId: `CH${String(nextChapterNum).padStart(2, '0')}`,
            title: 'Open Chapter',
            sceneRange: [nextScene, nextScene],
            summary: '',
            keywords: [],
            npcs: [],
            majorEvents: [],
            unresolvedThreads: [],
            tone: '',
            themes: [],
            sceneCount: 0,
        };

        // Replace open chapter with sealed, add new open chapter
        const openIdx = existing.findIndex(c => c.chapterId === openChapter.chapterId);
        existing[openIdx] = sealed;
        existing.push(newOpen);

        writeJson(cp, existing);
        res.json({ sealedChapter: sealed, newOpenChapter: newOpen });
    });

    // POST /api/campaigns/:id/archive/chapters/merge — Merge two adjacent chapters
    router.post('/api/campaigns/:id/archive/chapters/merge', (req, res) => {
        const { chapterIdA, chapterIdB } = req.body;
        const cp = chaptersPath(req.params.id);
        const existing = readJson(cp, []);

        const idxA = existing.findIndex(c => c.chapterId === chapterIdA);
        const idxB = existing.findIndex(c => c.chapterId === chapterIdB);

        if (idxA === -1 || idxB === -1) {
            return res.status(404).json({ error: 'One or both chapters not found' });
        }

        // Validate adjacency by array position
        const isAdjacent = Math.abs(idxA - idxB) === 1;
        if (!isAdjacent) {
            return res.status(400).json({ error: 'Chapters must be adjacent to merge' });
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
        res.json(merged);
    });

    // POST /api/campaigns/:id/archive/chapters/:chapterId/split — Split a chapter at a scene
    router.post('/api/campaigns/:id/archive/chapters/:chapterId/split', (req, res) => {
        const { atSceneId } = req.body;
        const cp = chaptersPath(req.params.id);
        const existing = readJson(cp, []);

        const idx = existing.findIndex(c => c.chapterId === req.params.chapterId);
        if (idx === -1) return res.status(404).json({ error: 'Chapter not found' });

        const chapter = existing[idx];
        const startNum = parseInt(chapter.sceneRange[0], 10);
        const endNum = parseInt(chapter.sceneRange[1], 10);
        const splitNum = parseInt(atSceneId, 10);

        if (splitNum <= startNum || splitNum > endNum) {
            return res.status(400).json({ error: 'Split point must be within chapter range (excluding start)' });
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
        res.json({ chapterA, chapterB });
    });

    return router;
}
