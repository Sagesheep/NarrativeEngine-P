import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '../..');
const DATA_DIR = path.join(projectRoot, 'data');
const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns');

const { initDb, storeArchiveEmbedding, storeLoreEmbedding } = await import('../lib/vectorStore.js');
const { embedText, embedBatch, buildArchiveText, buildLoreText, warmup } = await import('../lib/embedder.js');

function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

async function migrate() {
    console.log('[Migration] Starting embedding migration...');
    console.log('[Migration] Warming up embedding model...');
    await warmup();

    initDb();

    const files = fs.readdirSync(CAMPAIGNS_DIR);
    const archiveIndexFiles = files.filter(f => f.endsWith('.archive.index.json') && !f.endsWith('.bak'));
    const loreFiles = files.filter(f => f.endsWith('.lore.json') && !f.endsWith('.bak'));

    let totalScenes = 0;
    let totalLore = 0;

    for (const file of archiveIndexFiles) {
        const campaignId = file.replace('.archive.index.json', '');
        const fp = path.join(CAMPAIGNS_DIR, file);
        const entries = readJson(fp);
        if (!Array.isArray(entries) || entries.length === 0) continue;

        console.log(`[Migration] Campaign ${campaignId}: ${entries.length} archive scenes`);

        const texts = entries.map(e => buildArchiveText(e));
        const embeddings = await embedBatch(texts, 10, 100);

        for (let i = 0; i < entries.length; i++) {
            storeArchiveEmbedding(campaignId, entries[i].sceneId, embeddings[i]);
        }
        totalScenes += entries.length;
    }

    for (const file of loreFiles) {
        const campaignId = file.replace('.lore.json', '');
        const fp = path.join(CAMPAIGNS_DIR, file);
        const chunks = readJson(fp);
        if (!Array.isArray(chunks) || chunks.length === 0) continue;

        console.log(`[Migration] Campaign ${campaignId}: ${chunks.length} lore chunks`);

        const texts = chunks.map(c => buildLoreText(c));
        const embeddings = await embedBatch(texts, 10, 100);

        for (let i = 0; i < chunks.length; i++) {
            storeLoreEmbedding(campaignId, chunks[i].id, embeddings[i]);
        }
        totalLore += chunks.length;
    }

    console.log(`\n[Migration] Complete: ${totalScenes} scenes, ${totalLore} lore chunks embedded.`);
}

migrate().catch(err => {
    console.error('[Migration] Failed:', err);
    process.exit(1);
});
