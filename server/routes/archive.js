import fs from 'fs';
import { Router } from 'express';
import {
    readJson, writeJson, ensureDirs,
    archivePath, archiveIndexPath, chaptersPath, entitiesPath, timelinePath,
    getNextSceneNumber, createDefaultChapter,
} from '../lib/fileStore.js';
import {
    extractIndexKeywords, extractNPCNames, estimateImportance,
    extractKeywordStrengths, extractNPCStrengths, extractWitnessesHeuristic,
    extractTimelineEventsRegex,
} from '../lib/nlp.js';
import { extractWitnessesLLM, extractTimelineEventsLLM } from '../services/llmProxy.js';
import { normalizeEntityName } from '../lib/entityResolution.js';
import { embedText, buildArchiveText, buildLoreText } from '../lib/embedder.js';
import { storeArchiveEmbedding, storeLoreEmbedding, searchArchive, searchLore } from '../lib/vectorStore.js';
import { wrapAsync } from '../lib/asyncHandler.js';

export function createArchiveRouter() {
    const router = Router();

    // Pre-assign next scene number — called by client BEFORE sending to AI
    router.get('/api/campaigns/:id/archive/next-scene', wrapAsync((req, res) => {
        const next = getNextSceneNumber(req.params.id);
        const padded = String(next).padStart(3, '0');
        res.json({ sceneNumber: next, sceneId: padded });
    }));

    // Append a scene (user + assistant exchange) — also writes index entry
    router.post('/api/campaigns/:id/archive', wrapAsync(async (req, res) => {
        ensureDirs();
        const { userContent, assistantContent, importance: clientImportance, utilityConfig } = req.body;
        const fp = archivePath(req.params.id);
        const idxp = archiveIndexPath(req.params.id);
        const sceneNum = getNextSceneNumber(req.params.id);
        const sceneId = String(sceneNum).padStart(3, '0');
        const timestamp = Date.now();
        const timestampStr = new Date(timestamp).toLocaleString();

        // Write lossless scene to .archive.md
        const entry = [
            `## SCENE ${sceneId}`,
            `*${timestampStr}*`,
            '',
            `**[USER]**`,
            userContent,
            '',
            `**[GM]**`,
            assistantContent,
            '',
            '---',
            '',
        ].join('\n');
        fs.appendFileSync(fp, entry, 'utf-8');

        // Build and append index entry to .archive.index.json
        const combinedText = `${userContent}\n${assistantContent}`;
        const keywords = extractIndexKeywords(combinedText);
        const npcNames = extractNPCNames(assistantContent);
        let witnessResult = null;
        if (utilityConfig?.endpoint && npcNames.length > 0) {
            witnessResult = await extractWitnessesLLM(npcNames, userContent, assistantContent, utilityConfig);
        }
        const { witnesses, mentioned: npcOnlyMentioned } = witnessResult || extractWitnessesHeuristic(npcNames, userContent, assistantContent);
        const indexEntry = {
            sceneId,
            timestamp,
            keywords,
            keywordStrengths: extractKeywordStrengths(combinedText, keywords),
            npcsMentioned: npcOnlyMentioned,
            witnesses,
            npcStrengths: extractNPCStrengths(assistantContent, [...npcOnlyMentioned, ...witnesses]),
            importance: (typeof clientImportance === 'number' && clientImportance >= 1 && clientImportance <= 10)
                ? clientImportance
                : estimateImportance(combinedText),
            userSnippet: userContent.slice(0, 120),
        };
        const existing = readJson(idxp, []);
        existing.push(indexEntry);
        writeJson(idxp, existing);

        embedText(buildArchiveText(indexEntry))
            .then(embedding => storeArchiveEmbedding(req.params.id, sceneId, embedding))
            .catch(err => console.error('[Archive] Embedding failed:', err.message));

        // Extract timeline events (LLM with regex fallback) and append to timeline store
        const entitiesFile = entitiesPath(req.params.id);
        const knownEntities = readJson(entitiesFile, []);
        const allEntityNames = [
            ...npcNames,
            ...knownEntities.map(e => e.name),
            ...knownEntities.flatMap(e => e.aliases)
        ];
        const uniqueEntityNames = [...new Set(allEntityNames.map(n => n.toLowerCase()))]
            .map(lower => allEntityNames.find(n => n.toLowerCase() === lower) || lower);

        // Determine which chapter this scene belongs to
        const chaptersList = readJson(chaptersPath(req.params.id), []);
        const openChapterForTimeline = chaptersList.find(c => !c.sealedAt) || chaptersList[chaptersList.length - 1];
        const currentChapterId = openChapterForTimeline?.chapterId || 'CH01';

        let newEvents = null;
        if (utilityConfig?.endpoint && npcNames.length > 0) {
            newEvents = await extractTimelineEventsLLM(uniqueEntityNames, combinedText, sceneId, currentChapterId, utilityConfig);
        }

        if (newEvents === null) {
            newEvents = extractTimelineEventsRegex(npcNames, combinedText, sceneId, currentChapterId);
        } else {
            for (const ev of newEvents) {
                ev.subject = normalizeEntityName(ev.subject, knownEntities);
                ev.object = normalizeEntityName(ev.object, knownEntities);
            }
        }

        if (newEvents.length > 0) {
            const tp = timelinePath(req.params.id);
            const existingEvents = readJson(tp, []);
            const maxId = existingEvents.reduce((max, e) => {
                const num = parseInt(e.id.replace('tl_', ''), 10);
                return num > max ? num : max;
            }, 0);
            let idCounter = maxId + 1;
            for (const ev of newEvents) {
                existingEvents.push({
                    id: `tl_${String(idCounter++).padStart(4, '0')}`,
                    ...ev,
                });
            }
            writeJson(tp, existingEvents);
        }

        // Update entity registry
        const updatedEntities = [...knownEntities];
        for (const name of npcNames) {
            const canonical = normalizeEntityName(name, updatedEntities);
            if (canonical === name && !updatedEntities.some(e =>
                e.name.toLowerCase() === name.toLowerCase()
            )) {
                updatedEntities.push({
                    id: `ent_${String(updatedEntities.length + 1).padStart(4, '0')}`,
                    name,
                    type: 'npc',
                    aliases: [],
                    firstSeen: sceneId,
                });
            }
        }
        writeJson(entitiesFile, updatedEntities);

        // --- NEW: Chapter Auto-Lifecycle ---
        const cp = chaptersPath(req.params.id);
        let chapters = readJson(cp, []);
        let openChapter = chapters.find(c => !c.sealedAt);

        if (!openChapter) {
            // Create new open chapter if none exists
            const nextNum = chapters.length + 1;
            openChapter = createDefaultChapter(
                `CH${String(nextNum).padStart(2, '0')}`,
                `Chapter ${nextNum}`,
                sceneId,
                1,
            );
            chapters.push(openChapter);
        } else {
            // Update existing open chapter
            openChapter.sceneRange[1] = sceneId;
            openChapter.sceneCount++;
        }
        writeJson(cp, chapters);

        res.json({ ok: true, sceneNumber: sceneNum, sceneId });
    }));

    // Clear archive (.archive.md and .archive.index.json)
    router.delete('/api/campaigns/:id/archive', wrapAsync((req, res) => {
        const id = req.params.id;
        const files = [
            archivePath(id),
            archiveIndexPath(id),
            chaptersPath(id),
            timelinePath(id),
        ];
        for (const f of files) {
            if (fs.existsSync(f)) fs.unlinkSync(f);
        }
        res.json({ ok: true, chaptersCleared: true });
    }));

    // Get current scene count
    router.get('/api/campaigns/:id/archive', wrapAsync((req, res) => {
        const fp = archivePath(req.params.id);
        if (!fs.existsSync(fp)) return res.json({ exists: false, sceneCount: 0 });
        const nextScene = getNextSceneNumber(req.params.id);
        res.json({ exists: true, sceneCount: nextScene - 1 });
    }));

    // ═══════════════════════════════════════════
    //  Archive Index & Scene Retrieval (Tier 4)
    // ═══════════════════════════════════════════

    // Return the full .archive.index.json for client-side retrieval
    router.get('/api/campaigns/:id/archive/index', wrapAsync((req, res) => {
        const entries = readJson(archiveIndexPath(req.params.id), []);
        res.json(entries);
    }));

    // Fetch full verbatim scenes by comma-separated scene IDs
    router.get('/api/campaigns/:id/archive/scenes', wrapAsync((req, res) => {
        const fp = archivePath(req.params.id);
        if (!fs.existsSync(fp)) return res.json([]);
        const idsParam = req.query.ids || '';
        const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
        if (ids.length === 0) return res.json([]);

        const raw = fs.readFileSync(fp, 'utf-8');
        // Split on ## SCENE boundaries
        const sceneBlocks = raw.split(/^(?=## SCENE )/m);
        const result = [];
        for (const block of sceneBlocks) {
            const match = block.match(/^## SCENE (\d+)/);
            if (!match) continue;
            const sceneId = match[1].padStart(3, '0');
            if (ids.includes(sceneId)) {
                result.push({ sceneId, content: block.trim() });
            }
        }
        res.json(result);
    }));

    // Rollback: remove all scenes >= sceneId from .archive.md and .archive.index.json
    router.delete('/api/campaigns/:id/archive/scenes-from/:sceneId', wrapAsync((req, res) => {
        const fp = archivePath(req.params.id);
        const idxp = archiveIndexPath(req.params.id);
        const fromId = req.params.sceneId.padStart(3, '0');
        const fromNum = parseInt(fromId, 10);

        // Trim .archive.md
        if (fs.existsSync(fp)) {
            const raw = fs.readFileSync(fp, 'utf-8');
            const sceneBlocks = raw.split(/^(?=## SCENE )/m);
            const kept = sceneBlocks.filter(block => {
                const match = block.match(/^## SCENE (\d+)/);
                if (!match) return true; // keep preamble if any
                return parseInt(match[1], 10) < fromNum;
            });
            fs.writeFileSync(fp, kept.join(''), 'utf-8');
        }

        // Trim .archive.index.json
        if (fs.existsSync(idxp)) {
            const entries = readJson(idxp, []);
            const kept = entries.filter(e => parseInt(e.sceneId, 10) < fromNum);
            writeJson(idxp, kept);
        }

        // Trim timeline from this scene onwards
        const tlp = timelinePath(req.params.id);
        if (fs.existsSync(tlp)) {
            const timeline = readJson(tlp, []);
            const keptTimeline = timeline.filter(e => parseInt(e.sceneId, 10) < fromNum);
            writeJson(tlp, keptTimeline);
        }

        // --- NEW: Chapter Rollback Cascade ---
        const cp = chaptersPath(req.params.id);
        let chaptersRepaired = false;
        if (fs.existsSync(cp)) {
            let chapters = readJson(cp, []);
            const originalCount = chapters.length;

            // 1. Filter out chapters fully ahead of rollback point
            chapters = chapters.filter(ch => parseInt(ch.sceneRange[0], 10) < fromNum);

            // 2. Repair chapters spanning the rollback point
            for (const ch of chapters) {
                const endNum = parseInt(ch.sceneRange[1], 10);
                if (endNum >= fromNum) {
                    ch.sceneRange[1] = String(fromNum - 1).padStart(3, '0');
                    ch.invalidated = true;
                    delete ch.sealedAt; // unseal — summary no longer valid
                    ch.sceneCount = fromNum - parseInt(ch.sceneRange[0], 10);
                    chaptersRepaired = true;
                }
            }

            if (chapters.length !== originalCount) chaptersRepaired = true;

            // 3. Ensure an open chapter exists starting at fromNum - 1 (if archive not empty)
            const openChapter = chapters.find(ch => !ch.sealedAt);
            if (!openChapter) {
                const nextNum = chapters.length + 1;
                chapters.push(createDefaultChapter(
                    `CH${String(nextNum).padStart(2, '0')}`,
                    `Chapter ${nextNum}`,
                    fromId,
                ));
                chaptersRepaired = true;
            }

            writeJson(cp, chapters);
        }

        res.json({
            ok: true,
            removedFrom: fromId,
            chaptersRepaired,
            condenserResetRecommended: true
        });
    }));

    // Open archive in OS default app
    router.get('/api/campaigns/:id/archive/open', wrapAsync((req, res) => {
        const fp = archivePath(req.params.id);
        if (!fs.existsSync(fp)) {
            return res.status(404).json({ error: 'No archive yet' });
        }
        // Windows: start; macOS: open; Linux: xdg-open
        const cmd = process.platform === 'win32' ? 'start ""'
            : process.platform === 'darwin' ? 'open' : 'xdg-open';

        import('child_process').then(({ exec }) => {
            exec(`${cmd} "${fp}"`, (err) => {
                if (err) return res.status(500).json({ error: 'Failed to open archive' });
                res.json({ ok: true });
            });
        });
    }));

    router.post('/api/campaigns/:id/archive/semantic-candidates', wrapAsync(async (req, res) => {
        const { query, limit } = req.body;
        if (!query?.trim()) return res.json({ sceneIds: [] });
        const embedding = await embedText(query);
        const results = searchArchive(req.params.id, embedding, limit || 20);
        console.log(`[VectorStore] archive candidates for "${query.slice(0, 50)}": [${results.map(r => r.sceneId).join(', ')}]`);
        res.json({ sceneIds: results.map(r => r.sceneId) });
    }));

    router.post('/api/campaigns/:id/lore/semantic-candidates', wrapAsync(async (req, res) => {
        const { query, limit } = req.body;
        if (!query?.trim()) return res.json({ loreIds: [] });
        const embedding = await embedText(query);
        const results = searchLore(req.params.id, embedding, limit || 15);
        console.log(`[VectorStore] lore candidates for "${query.slice(0, 50)}": [${results.map(r => r.loreId).join(', ')}]`);
        res.json({ loreIds: results.map(r => r.loreId) });
    }));

    return router;
}
