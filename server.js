import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;

// ─── Data directory setup ───
const DATA_DIR = path.join(__dirname, 'data');
const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function ensureDirs() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CAMPAIGNS_DIR)) fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
}
ensureDirs();

// ─── Helpers ───
function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch { return fallback; }
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

// ─── Middleware ───
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ═══════════════════════════════════════════
//  Settings
// ═══════════════════════════════════════════

app.get('/api/settings', (_req, res) => {
    const settings = readJson(SETTINGS_FILE, {});
    res.json(settings);
});

app.put('/api/settings', (req, res) => {
    writeJson(SETTINGS_FILE, req.body);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
//  Campaigns
// ═══════════════════════════════════════════

app.get('/api/campaigns', (_req, res) => {
    ensureDirs();
    const files = fs.readdirSync(CAMPAIGNS_DIR).filter(f => f.endsWith('.json') && !f.includes('.state') && !f.includes('.lore') && !f.includes('.npcs'));
    const campaigns = files.map(f => readJson(path.join(CAMPAIGNS_DIR, f))).filter(Boolean);
    campaigns.sort((a, b) => (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0));
    res.json(campaigns);
});

app.get('/api/campaigns/:id', (req, res) => {
    const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.json`);
    const campaign = readJson(filePath);
    if (!campaign) return res.status(404).json({ error: 'Not found' });
    res.json(campaign);
});

app.put('/api/campaigns/:id', (req, res) => {
    ensureDirs();
    const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.json`);
    writeJson(filePath, req.body);
    res.json({ ok: true });
});

app.delete('/api/campaigns/:id', (req, res) => {
    const id = req.params.id;
    const files = [
        path.join(CAMPAIGNS_DIR, `${id}.json`),
        path.join(CAMPAIGNS_DIR, `${id}.state.json`),
        path.join(CAMPAIGNS_DIR, `${id}.lore.json`),
        path.join(CAMPAIGNS_DIR, `${id}.npcs.json`),
        path.join(CAMPAIGNS_DIR, `${id}.archive.md`),
    ];
    for (const f of files) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
//  Campaign State (context, messages, condenser)
// ═══════════════════════════════════════════

app.get('/api/campaigns/:id/state', (req, res) => {
    const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.state.json`);
    const state = readJson(filePath);
    if (!state) return res.status(404).json({ error: 'Not found' });
    res.json(state);
});

app.put('/api/campaigns/:id/state', (req, res) => {
    ensureDirs();
    const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.state.json`);
    writeJson(filePath, req.body);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
//  Lore Chunks
// ═══════════════════════════════════════════

app.get('/api/campaigns/:id/lore', (req, res) => {
    const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.lore.json`);
    const lore = readJson(filePath, []);
    res.json(lore);
});

app.put('/api/campaigns/:id/lore', (req, res) => {
    ensureDirs();
    const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.lore.json`);
    writeJson(filePath, req.body);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
//  NPC Ledger
// ═══════════════════════════════════════════

app.get('/api/campaigns/:id/npcs', (req, res) => {
    const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.npcs.json`);
    const npcs = readJson(filePath, []);
    res.json(npcs);
});

app.put('/api/campaigns/:id/npcs', (req, res) => {
    ensureDirs();
    const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.npcs.json`);
    writeJson(filePath, req.body);
    res.json({ ok: true });
});


// ═══════════════════════════════════════════
//  Archive (verbatim chat log)
// ═══════════════════════════════════════════

function archivePath(id) {
    return path.join(CAMPAIGNS_DIR, `${id}.archive.md`);
}

function getNextSceneNumber(id) {
    const fp = archivePath(id);
    if (!fs.existsSync(fp)) return 1;
    const content = fs.readFileSync(fp, 'utf-8');
    const matches = content.match(/^## SCENE (\d+)/gm);
    if (!matches || matches.length === 0) return 1;
    const last = matches[matches.length - 1];
    const num = parseInt(last.replace('## SCENE ', ''), 10);
    return num + 1;
}

// Append a scene (user + assistant exchange)
app.post('/api/campaigns/:id/archive', (req, res) => {
    ensureDirs();
    const { userContent, assistantContent } = req.body;
    const fp = archivePath(req.params.id);
    const sceneNum = getNextSceneNumber(req.params.id);
    const timestamp = new Date().toLocaleString();

    const entry = [
        `## SCENE ${String(sceneNum).padStart(3, '0')}`,
        `*${timestamp}*`,
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
    res.json({ ok: true, sceneNumber: sceneNum });
});

// Get current scene count
app.get('/api/campaigns/:id/archive', (req, res) => {
    const fp = archivePath(req.params.id);
    if (!fs.existsSync(fp)) return res.json({ exists: false, sceneCount: 0 });
    const nextScene = getNextSceneNumber(req.params.id);
    res.json({ exists: true, sceneCount: nextScene - 1 });
});

// ═══════════════════════════════════════════
//  Archive (Structured Tier 4 Memory)
// ═══════════════════════════════════════════

app.get('/api/campaigns/:id/archive/chunks', (req, res) => {
    const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.archive.json`);
    const chunks = readJson(filePath, []);
    res.json(chunks);
});

app.post('/api/campaigns/:id/archive/chunk', (req, res) => {
    ensureDirs();
    const filePath = path.join(CAMPAIGNS_DIR, `${req.params.id}.archive.json`);
    const chunks = readJson(filePath, []);
    chunks.push(req.body); // append the new ArchiveChunk
    writeJson(filePath, chunks);
    res.json({ ok: true });
});

// Open archive in OS default app
app.get('/api/campaigns/:id/archive/open', (req, res) => {
    const fp = archivePath(req.params.id);
    if (!fs.existsSync(fp)) {
        return res.status(404).json({ error: 'No archive yet' });
    }
    // Windows: start; macOS: open; Linux: xdg-open
    const cmd = process.platform === 'win32' ? 'start ""'
        : process.platform === 'darwin' ? 'open' : 'xdg-open';

    import('child_process').then(({ exec }) => {
        exec(`${cmd} "${fp}"`, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        });
    });
});

// ═══════════════════════════════════════════
//  Start
// ═══════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`[GM-Cockpit API] ✓ Running on http://localhost:${PORT}`);
    console.log(`[GM-Cockpit API]   Data dir: ${DATA_DIR}`);
});
