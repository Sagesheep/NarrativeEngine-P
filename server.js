import express from 'express';
import cors from 'cors';
import { KeyVault } from './server/vault.js';
import { DATA_DIR, CAMPAIGNS_DIR, PUBLIC_ASSETS_DIR, MODS_DIR, BUNDLED_MODS_DIR, APP_VERSION, ensureDirs } from './server/lib/fileStore.js';
import { createVaultRouter } from './server/routes/vault.js';
import { createSettingsRouter } from './server/routes/settings.js';
import { createCampaignsRouter } from './server/routes/campaigns.js';
import { createArchiveRouter } from './server/routes/archive.js';
import { createChaptersRouter } from './server/routes/chapters.js';
import { createTimelineRouter } from './server/routes/timeline.js';
import { createFactsRouter } from './server/routes/facts.js';
import { createBackupsRouter } from './server/routes/backups.js';
import { createAssetsRouter } from './server/routes/assets.js';
import { createOverworldRouter } from './server/routes/overworld.js';
import { createTransferRouter } from './server/routes/transfer.js';
import { createDivergenceRouter } from './server/routes/divergence.js';
import { createRulesRouter } from './server/routes/rules.js';
import { createLLMProxyRouter } from './server/routes/llmProxy.js';
import { createEmbeddingRouter } from './server/routes/embedding.js';
import { createTtsRouter } from './server/routes/tts.js';
import { createSceneImagesRouter } from './server/routes/sceneImages.js';
import { createModsRouter } from './server/routes/mods.js';
import { loadMods } from './server/lib/modLoader.js';
import { registerModTables } from './server/lib/modTableRegistry.js';
import { mountGenericTableRoutes, mountModTableRoutes, serverTableRegistry } from './server/lib/tableRegistry.js';
import { registerLocationTable } from './server/lib/locationTable.js';
import { initDb } from './server/lib/vectorStore.js';
import { warmup as warmupEmbedder } from './server/lib/embedder.js';
import { warmupTts } from './server/lib/tts.js';
import { serverError } from './server/lib/serverError.js';

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
// Restrict CORS to the only two legitimate origins:
//   - 'null'       → Electron production loads the frontend via file:// (origin "null")
//   - Vite dev URL → local development via http://localhost:5173
// Any other origin (e.g. a malicious website in the user's browser) is rejected,
// preventing cross-origin reads of /api/vault/keys and other sensitive endpoints.
const BIND_HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_ORIGINS = new Set(['null', 'http://localhost:5173']);
if (process.env.ALLOWED_ORIGINS) {
    process.env.ALLOWED_ORIGINS.split(',').forEach(o => ALLOWED_ORIGINS.add(o.trim()));
}
app.use(cors({
    origin(origin, cb) {
        // Allow same-origin requests (no Origin header) and allowlisted origins.
        if (!origin || ALLOWED_ORIGINS.has(origin)) return cb(null, true);
        return cb(null, false);
    },
    credentials: false,
}));
app.use(express.json({ limit: '500mb' }));
app.use('/assets/portraits', express.static(PUBLIC_ASSETS_DIR));
app.use('/assets/campaigns', express.static(CAMPAIGNS_DIR));

// ─── Vector Search Init ───
try {
    initDb();
} catch (err) {
    console.error('[VectorStore] Init failed:', err.message);
}
registerLocationTable(serverTableRegistry);
warmupEmbedder().catch(err => console.error('[Embedder] Warmup failed:', err.message));
warmupTts().catch(err => console.error('[TTS] Warmup failed:', err.message));

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
app.use(createOverworldRouter());
app.use(createTransferRouter());
app.use(createDivergenceRouter());
app.use(createRulesRouter());
app.use(createLLMProxyRouter());
app.use(createEmbeddingRouter());
app.use(createTtsRouter());
app.use(createSceneImagesRouter(vault));
app.use('/api/mods', createModsRouter({ modsDir: MODS_DIR, appVersion: APP_VERSION, bundledModsDir: BUNDLED_MODS_DIR }));

// Phase 6.4 — register mod tables ONCE AT BOOT, not only as a side effect of
// `GET /api/mods`. Every other route that needs to know a mod table exists —
// the dynamic GET/PUT pair, the campaign-file suffix set, the transfer bundle —
// was previously blind until something happened to list the mods. A server
// process that had never served that route exported campaigns with every mod
// table missing. The mods route still re-registers on each call (that is how an
// install takes effect without a restart); this is the floor beneath it.
registerModTablesAtBoot();
function registerModTablesAtBoot() {
    try {
        const result = loadMods(MODS_DIR, APP_VERSION, undefined, BUNDLED_MODS_DIR);
        registerModTables(serverTableRegistry, result.mods);
    } catch (err) {
        // `loadMods` never throws; belt-and-braces. A failure here must not
        // stop the server from starting — it only means mod tables wait for
        // the first `GET /api/mods`, which is the old behaviour.
        console.error('[mods] boot-time table registration failed:', err.message);
    }
}

// Generic table routes (WO-P5-03 Step 2.2). Mounted AFTER every bespoke router
// so a descriptor's generic GET/PUT pair can never shadow archive.js,
// chapters.js, timeline.js, facts.js, overworld.js, divergence.js, or
// campaigns.js. With no descriptors registered (today) this mounts nothing.
app.use(mountGenericTableRoutes());

// Mod table routes (WO-P5-05 Step 3). A single dynamic GET/PUT pair that looks
// up the registry at request time, so mod tables installed after server start
// are reachable without a restart. Unregistered name → 404 before any path is
// built (§2 defence #3). Mounted in its own /mod-tables/ namespace so it can
// never shadow a built-in route. With no mod tables registered, every request
// is a 404 — no file is touched.
app.use(mountModTableRoutes());

// ─── Central Error Handler ───
app.use((err, _req, res, _next) => {
    serverError(res, err, 'Server');
});

// ─── Start ───
app.listen(PORT, BIND_HOST, () => {
    console.log(`[GM-Cockpit API] ✓ Running on http://${BIND_HOST}:${PORT}`);
    console.log(`[GM-Cockpit API]   Data dir: ${DATA_DIR}`);
});
