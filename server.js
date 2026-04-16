import express from 'express';
import cors from 'cors';
import { KeyVault } from './server/vault.js';
import { DATA_DIR, PUBLIC_ASSETS_DIR, ensureDirs } from './server/lib/fileStore.js';
import { createVaultRouter } from './server/routes/vault.js';
import { createSettingsRouter } from './server/routes/settings.js';
import { createCampaignsRouter } from './server/routes/campaigns.js';
import { createArchiveRouter } from './server/routes/archive.js';
import { createChaptersRouter } from './server/routes/chapters.js';
import { createTimelineRouter } from './server/routes/timeline.js';
import { createFactsRouter } from './server/routes/facts.js';
import { createBackupsRouter } from './server/routes/backups.js';
import { createAssetsRouter } from './server/routes/assets.js';
import { initDb } from './server/lib/vectorStore.js';
import { warmup as warmupEmbedder } from './server/lib/embedder.js';

const app = express();
const PORT = 3001;

// Initialize vault
const vault = new KeyVault(DATA_DIR);
ensureDirs();

// Auto-initialize vault with machine key if it doesn't exist
if (!vault.exists()) {
    vault.create({ presets: [] }, null);
    console.log('[Vault] Auto-created with machine key');
}
// Auto-unlock machine-key vaults on startup
if (!vault.isUnlocked()) {
    try {
        vault.unlock(null);
        console.log('[Vault] Auto-unlocked with machine key');
    } catch (e) {
        // Password-protected vault — frontend will prompt for password
        console.log('[Vault] Password-protected vault, manual unlock required');
    }
}

// ─── Middleware ───
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/assets/portraits', express.static(PUBLIC_ASSETS_DIR));

// ─── Vector Search Init ───
try {
    initDb();
} catch (err) {
    console.error('[VectorStore] Init failed:', err.message);
}
warmupEmbedder().catch(err => console.error('[Embedder] Warmup failed:', err.message));

// ─── Routes ───
app.use(createVaultRouter(vault));
app.use(createSettingsRouter());
app.use(createCampaignsRouter());
app.use(createArchiveRouter());
app.use(createChaptersRouter());
app.use(createTimelineRouter());
app.use(createFactsRouter());
app.use(createBackupsRouter());
app.use(createAssetsRouter());

// ─── Central Error Handler ───
app.use((err, _req, res, _next) => {
    console.error('[Server] Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ───
app.listen(PORT, () => {
    console.log(`[GM-Cockpit API] ✓ Running on http://localhost:${PORT}`);
    console.log(`[GM-Cockpit API]   Data dir: ${DATA_DIR}`);
});
