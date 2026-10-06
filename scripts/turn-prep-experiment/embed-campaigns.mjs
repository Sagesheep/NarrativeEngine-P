// Turn Prep Experiment — build scene and lore embeddings for specific campaigns.
// Same calls as server/scripts/migrateEmbeddings.js, scoped to the IDs given, because
// reindexEmbeddings only refreshes rows that already exist and a file-level campaign
// copy starts with none. Run while the app server is stopped or idle.
//
//   node scripts/turn-prep-experiment/embed-campaigns.mjs exp-c1-rebuilt exp-c1-raw

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIR = path.join(ROOT, 'data/campaigns');
const ids = process.argv.slice(2);
if (!ids.length) { console.error('usage: embed-campaigns.mjs <campaignId> [...]'); process.exit(2); }

const { initDb, storeArchiveEmbedding, storeLoreEmbedding, getEmbeddingStatus } = await import('../../server/lib/vectorStore.js');
const { embedBatch, buildScenePassages, buildLoreText, warmup } = await import('../../server/lib/embedder.js');
const { readSceneProse, sceneCastNames } = await import('../../server/services/archiveService.js');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

await warmup();
initDb();
for (const id of ids) {
    const started = Date.now();
    // Scenes as passages of their prose plus a cast card (one vector each), like the server.
    const prose = readSceneProse(id);
    const scenes = (readJson(path.join(DIR, `${id}.archive.index.json`)) ?? []).filter(e => prose.has(e.sceneId));
    const passagesById = scenes.map(e => buildScenePassages(prose.get(e.sceneId).userContent, prose.get(e.sceneId).assistantContent, sceneCastNames(e)));
    const sceneVecs = await embedBatch(passagesById.flat(), 10, 100);
    let at = 0;
    scenes.forEach((e, i) => { storeArchiveEmbedding(id, e.sceneId, sceneVecs.slice(at, at + passagesById[i].length)); at += passagesById[i].length; });
    const lore = readJson(path.join(DIR, `${id}.lore.json`)) ?? [];
    const loreVecs = await embedBatch(lore.map(c => buildLoreText(c)), 10, 100);
    lore.forEach((c, i) => storeLoreEmbedding(id, c.id, loreVecs[i]));
    console.log(`[embed] ${id}: ${scenes.length} scenes + ${lore.length} lore chunks in ${Math.round((Date.now() - started) / 1000)}s`,
        JSON.stringify(getEmbeddingStatus?.(id) ?? {}));
}
