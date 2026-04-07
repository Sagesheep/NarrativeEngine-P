import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3001;

// ─── Data directory setup ───
const DATA_DIR = path.join(__dirname, 'data');
const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

function ensureDirs() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CAMPAIGNS_DIR)) fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
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
    try {
        // Write to a temp file first, then rename for atomicity (prevents partial writes on crash/disk-full)
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmp, filePath);
    } catch (err) {
        console.error(`[writeJson] Failed to write ${filePath}:`, err);
        throw err; // re-throw so callers can return 500
    }
}

function computeCampaignHash(id) {
    const fileNames = [
        `${id}.json`, `${id}.state.json`, `${id}.lore.json`, `${id}.npcs.json`,
        `${id}.archive.md`, `${id}.archive.index.json`, `${id}.archive.chapters.json`, `${id}.facts.json`,
    ];
    const hash = crypto.createHash('md5');
    for (const name of fileNames) {
        const fp = path.join(CAMPAIGNS_DIR, name);
        if (fs.existsSync(fp)) {
            hash.update(fs.readFileSync(fp, 'utf-8'));
        }
    }
    return hash.digest('hex');
}

function campaignFiles(id) {
    const names = [
        `${id}.json`, `${id}.state.json`, `${id}.lore.json`, `${id}.npcs.json`,
        `${id}.archive.md`, `${id}.archive.index.json`, `${id}.archive.chapters.json`, `${id}.facts.json`,
    ];
    return names.filter(n => fs.existsSync(path.join(CAMPAIGNS_DIR, n)));
}

function createBackup(id, opts = {}) {
    const { label = '', trigger = 'manual', isAuto = false } = opts;
    const now = Date.now();
    const hash = computeCampaignHash(id);

    if (isAuto) {
        const backupDir = path.join(BACKUPS_DIR, id);
        if (fs.existsSync(backupDir)) {
            const folders = fs.readdirSync(backupDir)
                .filter(f => fs.statSync(path.join(backupDir, f)).isDirectory())
                .sort()
                .reverse();
            for (const folder of folders) {
                const metaFile = path.join(backupDir, folder, 'meta.json');
                if (fs.existsSync(metaFile)) {
                    const meta = readJson(metaFile);
                    if (meta && meta.isAuto && meta.hash === hash) {
                        return { skipped: true };
                    }
                    break;
                }
            }
        }
    }

    const backupPath = path.join(BACKUPS_DIR, id, String(now));
    fs.mkdirSync(backupPath, { recursive: true });

    const files = campaignFiles(id);
    for (const name of files) {
        const src = path.join(CAMPAIGNS_DIR, name);
        const dst = path.join(backupPath, name);
        fs.copyFileSync(src, dst);
    }

    const campaignMeta = readJson(path.join(CAMPAIGNS_DIR, `${id}.json`), {});

    const meta = {
        timestamp: now,
        label,
        trigger,
        hash,
        fileCount: files.length,
        isAuto,
        campaignName: campaignMeta.name || 'Unknown',
    };
    writeJson(path.join(backupPath, 'meta.json'), meta);

    if (isAuto) {
        pruneAutoBackups(id, 10);
    }

    return { timestamp: now, hash, fileCount: files.length };
}

function pruneAutoBackups(id, keep) {
    const backupDir = path.join(BACKUPS_DIR, id);
    if (!fs.existsSync(backupDir)) return;

    const folders = fs.readdirSync(backupDir)
        .filter(f => fs.statSync(path.join(backupDir, f)).isDirectory())
        .map(f => {
            const meta = readJson(path.join(backupDir, f, 'meta.json'), {});
            return { folder: f, isAuto: meta.isAuto || false };
        })
        .filter(f => f.isAuto)
        .sort((a, b) => Number(b.folder) - Number(a.folder));

    for (let i = keep; i < folders.length; i++) {
        const dirToRemove = path.join(backupDir, folders[i].folder);
        fs.rmSync(dirToRemove, { recursive: true, force: true });
    }
}

/** Strip all apiKey values before writing to disk. Keys live in the browser's IndexedDB only. */
function stripApiKeys(body) {
    if (!body || typeof body !== 'object') return body;
    const stripped = JSON.parse(JSON.stringify(body)); // deep clone
    const settings = stripped.settings;
    if (settings && Array.isArray(settings.presets)) {
        for (const preset of settings.presets) {
            for (const section of ['storyAI', 'imageAI', 'summarizerAI']) {
                if (preset[section]) preset[section].apiKey = '';
            }
        }
    }
    return stripped;
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
    const sanitized = stripApiKeys(req.body);
    writeJson(SETTINGS_FILE, sanitized);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
//  Campaigns
// ═══════════════════════════════════════════

app.get('/api/campaigns', (_req, res) => {
    ensureDirs();
    const files = fs.readdirSync(CAMPAIGNS_DIR).filter(f =>
        f.endsWith('.json') &&
        !f.includes('.state') &&
        !f.includes('.lore') &&
        !f.includes('.npcs') &&
        !f.includes('.archive') &&
        !f.includes('.index')
    );
    const campaigns = files
        .map(f => {
            const data = readJson(path.join(CAMPAIGNS_DIR, f));
            if (data && data.id && data.name && data.id !== 'undefined' && data.id !== 'null') {
                return {
                    ...data,
                    lastPlayedAt: Number(data.lastPlayedAt) || 0
                };
            }
            return null;
        })
        .filter(c => c !== null);

    console.log(`[API] Returning ${campaigns.length} campaigns:`, campaigns.map(c => c.id).join(', '));
    campaigns.sort((a, b) => (Number(b.lastPlayedAt) || 0) - (Number(a.lastPlayedAt) || 0));
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
        path.join(CAMPAIGNS_DIR, `${id}.archive.index.json`),
        path.join(CAMPAIGNS_DIR, `${id}.facts.json`),
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
//  Archive (verbatim chat log + index)
// ═══════════════════════════════════════════

function archivePath(id) {
    return path.join(CAMPAIGNS_DIR, `${id}.archive.md`);
}

function archiveIndexPath(id) {
    return path.join(CAMPAIGNS_DIR, `${id}.archive.index.json`);
}

function chaptersPath(id) {
    return path.join(CAMPAIGNS_DIR, `${id}.archive.chapters.json`);
}

function factsPath(id) {
    return path.join(CAMPAIGNS_DIR, `${id}.facts.json`);
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

/**
 * Extract keywords from raw text for the archive index.
 * Captures: proper nouns (capitalised 3+ char words), quoted strings,
 * [MEMORABLE: ...] tags from the condenser.
 */
function extractIndexKeywords(text) {
    const keywords = new Set();
    // Proper nouns — capitalised words 3+ chars
    const properNouns = text.match(/[A-Z][A-Za-z]{2,}(?:\s[A-Z][A-Za-z]{2,})*/g) || [];
    const stopWords = new Set(['The', 'And', 'For', 'Are', 'But', 'Not', 'You', 'All', 'Can', 'Has',
        'Was', 'One', 'His', 'Her', 'Had', 'May', 'Who', 'Been', 'Some', 'They', 'Will', 'Each', 'That',
        'This', 'With', 'From', 'Then', 'When', 'What', 'Where', 'There', 'Those', 'These', 'User', 'Scene']);
    for (const noun of properNouns) {
        if (!stopWords.has(noun)) keywords.add(noun.toLowerCase());
    }
    // Quoted strings — e.g. "I will return"
    const quoted = text.match(/"([^"]{4,60})"/g) || [];
    for (const q of quoted) keywords.add(q.replace(/"/g, '').toLowerCase().trim());
    // [MEMORABLE: ...] tags from condenser
    const memorable = text.match(/\[MEMORABLE:\s*"([^"]+)"\]/g) || [];
    for (const m of memorable) {
        const inner = m.match(/\[MEMORABLE:\s*"([^"]+)"\]/);
        if (inner) keywords.add(inner[1].toLowerCase().trim());
    }
    return Array.from(keywords).slice(0, 20);
}

/** Extract NPC names (words wrapped in [**Name**] format from GM output). */
function extractNPCNames(text) {
    const names = new Set();
    const matches = text.matchAll(/\[\*{0,2}([A-Za-z][A-Za-z0-9 '-]{1,30})\*{0,2}\]/g);
    for (const m of matches) names.add(m[1].trim());
    return Array.from(names).slice(0, 15);
}

/**
 * Estimate intrinsic importance of a scene (1-10) based on content patterns.
 * No LLM call — pure heuristic.
 */
function estimateImportance(text) {
    const lower = text.toLowerCase();
    let importance = 3;

    if (/\b(killed|slain|died|defeated|destroyed|executed|murdered|sacrificed)\b/.test(lower)) importance += 3;
    if (/\[MEMORABLE:/.test(text)) importance += 2;
    if (/\b(king|queen|emperor|empress|lord|lady|prince|princess|archmage|general|commander|champion)\b/.test(lower)) importance += 1;
    if (/\b(acquired|obtained|rewarded|treasure|legendary|artifact|enchanted)\b/.test(lower)) importance += 1;
    if (/\b(quest|mission|objective|prophecy|oath|vow|alliance|betrayal|treaty)\b/.test(lower)) importance += 1;

    return Math.min(10, importance);
}

/**
 * Extract graded keyword strengths (0-1) from text.
 * Strength based on: frequency, position (early = stronger), memorable association.
 */
function extractKeywordStrengths(text, keywords) {
    const lower = text.toLowerCase();
    const strengths = {};
    const textLen = lower.length;

    for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        let strength = 0;
        let count = 0;
        let pos = 0;
        while ((pos = lower.indexOf(kwLower, pos)) !== -1) {
            count++;
            if (pos < textLen * 0.2) strength += 0.3;
            pos += kwLower.length;
        }
        if (count >= 3) strength += 0.6;
        else if (count >= 2) strength += 0.4;
        else if (count >= 1) strength += 0.2;
        if (lower.includes('[memorable:')) {
            const memIdx = lower.indexOf('[memorable:');
            const memContext = lower.substring(Math.max(0, memIdx - 100), memIdx + 200);
            if (memContext.includes(kwLower)) strength += 0.3;
        }
        strengths[kw] = Math.min(1.0, strength);
    }
    return strengths;
}

/**
 * Extract graded NPC strengths (0-1) from GM output.
 * Strength based on: death proximity, dialogue/action proximity, mention frequency.
 */
function extractNPCStrengths(text, npcNames) {
    const lower = text.toLowerCase();
    const strengths = {};

    for (const name of npcNames) {
        const nameLower = name.toLowerCase();
        let strength = 0;
        const deathPattern = new RegExp(nameLower + '\\s+(was\\s+)?(killed|slain|died|defeated|destroyed)', 'i');
        const reverseDeath = new RegExp('(killed|slain|defeated|destroyed|murdered)\\s+' + nameLower, 'i');
        if (deathPattern.test(lower) || reverseDeath.test(lower)) {
            strength = 1.0;
        } else {
            let count = 0;
            let pos = 0;
            while ((pos = lower.indexOf(nameLower, pos)) !== -1) { count++; pos += nameLower.length; }
            if (count >= 3) strength = 0.7;
            else if (count >= 2) strength = 0.5;
            else if (count >= 1) strength = 0.3;
            const dialoguePattern = new RegExp(nameLower + '\\s+(said|replied|shouted|whispered|asked|told|exclaimed)', 'i');
            if (dialoguePattern.test(lower)) strength = Math.max(strength, 0.7);
        }
        strengths[name] = Math.min(1.0, strength);
    }
    return strengths;
}

/**
 * Extract semantic triples from NPC-related narrative text.
 * Creates facts like: {subject, killed, object}, {subject, located_in, object}
 */
function extractNPCFacts(npcNames, text) {
    const facts = [];

    for (const name of npcNames) {
        const killAsSubject = new RegExp(name + '\\s+(killed|slain|defeated|destroyed|murdered)\\s+([A-Z][A-Za-z\\s]{1,30})', 'i');
        const killMatch1 = text.match(killAsSubject);
        if (killMatch1) {
            facts.push({ subject: name, predicate: killMatch1[1].toLowerCase(), object: killMatch1[2].trim(), importance: 10 });
        }
        const killAsObject = new RegExp('([A-Z][A-Za-z\\s]{1,30})\\s+(killed|slain|defeated|destroyed|murdered)\\s+' + name, 'i');
        const killMatch2 = text.match(killAsObject);
        if (killMatch2) {
            facts.push({ subject: name, predicate: 'killed_by', object: killMatch2[1].trim(), importance: 10 });
        }
        const locPattern = new RegExp(name + '\\s+(entered|arrived at|found in|returned to|fled to)\\s+(?:the\\s+)?([A-Z][A-Za-z\\s]{2,40})', 'i');
        const locMatch = text.match(locPattern);
        if (locMatch) {
            facts.push({ subject: name, predicate: 'located_in', object: locMatch[2].trim(), importance: 5 });
        }
        const titlePattern = new RegExp(name + ',\\s+((?:King|Queen|Lord|Lady|Duke|Prince|Princess|General|Commander|Archmage|Champion)(?:\\s+of\\s+[A-Za-z\\s]+)?)', 'i');
        const titleMatch = text.match(titlePattern);
        if (titleMatch) {
            facts.push({ subject: name, predicate: 'title', object: titleMatch[1].trim(), importance: 7 });
        }
        const factionPattern = new RegExp(name + '[\\s,]+(?:leader\\s+of|member\\s+of|of)\\s+(?:the\\s+)?([A-Z][A-Za-z\\s]{2,30})', 'i');
        const factionMatch = text.match(factionPattern);
        if (factionMatch) {
            facts.push({ subject: name, predicate: 'member_of', object: factionMatch[1].trim(), importance: 7 });
        }
    }
    return facts;
}

// Pre-assign next scene number — called by client BEFORE sending to AI
app.get('/api/campaigns/:id/archive/next-scene', (req, res) => {
    const next = getNextSceneNumber(req.params.id);
    const padded = String(next).padStart(3, '0');
    res.json({ sceneNumber: next, sceneId: padded });
});

// Append a scene (user + assistant exchange) — also writes index entry
app.post('/api/campaigns/:id/archive', (req, res) => {
    try {
    ensureDirs();
    const { userContent, assistantContent } = req.body;
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
    const indexEntry = {
        sceneId,
        timestamp,
        keywords,
        keywordStrengths: extractKeywordStrengths(combinedText, keywords),
        npcsMentioned: npcNames,
        npcStrengths: extractNPCStrengths(assistantContent, npcNames),
        importance: estimateImportance(combinedText),
        userSnippet: userContent.slice(0, 120),
    };
    const existing = readJson(idxp, []);
    existing.push(indexEntry);
    writeJson(idxp, existing);

    // Extract semantic facts and append to facts store
    const newFacts = extractNPCFacts(npcNames, combinedText);
    if (newFacts.length > 0) {
        const factsFile = factsPath(req.params.id);
        const existingFacts = readJson(factsFile, []);
        for (const fact of newFacts) {
            const isDuplicate = existingFacts.some(ef =>
                ef.subject === fact.subject && ef.predicate === fact.predicate && ef.object === fact.object
            );
            if (!isDuplicate) {
                existingFacts.push({
                    id: `fact_${String(existingFacts.length + 1).padStart(4, '0')}`,
                    ...fact,
                    sceneId,
                    timestamp,
                });
            }
        }
        writeJson(factsFile, existingFacts);
    }

    // --- NEW: Chapter Auto-Lifecycle ---
    const cp = chaptersPath(req.params.id);
    let chapters = readJson(cp, []);
    let openChapter = chapters.find(c => !c.sealedAt);

    if (!openChapter) {
        // Create new open chapter if none exists
        const nextNum = chapters.length + 1;
        openChapter = {
            chapterId: `CH${String(nextNum).padStart(2, '0')}`,
            title: `Chapter ${nextNum}`,
            sceneRange: [sceneId, sceneId],
            summary: '',
            keywords: [],
            npcs: [],
            majorEvents: [],
            unresolvedThreads: [],
            tone: '',
            themes: [],
            sceneCount: 1,
        };
        chapters.push(openChapter);
    } else {
        // Update existing open chapter
        openChapter.sceneRange[1] = sceneId;
        openChapter.sceneCount++;
    }
    writeJson(cp, chapters);

    res.json({ ok: true, sceneNumber: sceneNum, sceneId });
    } catch (err) {
        console.error('[Archive Append] Write failed:', err);
        res.status(500).json({ error: 'Failed to append scene', detail: err.message });
    }
});

// Clear archive (.archive.md and .archive.index.json)
app.delete('/api/campaigns/:id/archive', (req, res) => {
    const id = req.params.id;
    const files = [
        archivePath(id),
        archiveIndexPath(id),
        chaptersPath(id),
    ];
    for (const f of files) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    res.json({ ok: true, chaptersCleared: true });
});

// Get current scene count
app.get('/api/campaigns/:id/archive', (req, res) => {
    const fp = archivePath(req.params.id);
    if (!fs.existsSync(fp)) return res.json({ exists: false, sceneCount: 0 });
    const nextScene = getNextSceneNumber(req.params.id);
    res.json({ exists: true, sceneCount: nextScene - 1 });
});

// ═══════════════════════════════════════════
//  Chapters (Tier 4.5)
// ═══════════════════════════════════════════

app.get('/api/campaigns/:id/archive/chapters', (req, res) => {
    const chapters = readJson(chaptersPath(req.params.id), []);
    res.json(chapters);
});

app.post('/api/campaigns/:id/archive/chapters', (req, res) => {
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

app.patch('/api/campaigns/:id/archive/chapters/:chapterId', (req, res) => {
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
app.post('/api/campaigns/:id/archive/chapters/seal', (req, res) => {
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
app.post('/api/campaigns/:id/archive/chapters/merge', (req, res) => {
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
app.post('/api/campaigns/:id/archive/chapters/:chapterId/split', (req, res) => {
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

// ═══════════════════════════════════════════
//  Archive Index & Scene Retrieval (Tier 4)
// ═══════════════════════════════════════════

// Return the full .archive.index.json for client-side retrieval
app.get('/api/campaigns/:id/archive/index', (req, res) => {
    const entries = readJson(archiveIndexPath(req.params.id), []);
    res.json(entries);
});

// Fetch full verbatim scenes by comma-separated scene IDs
app.get('/api/campaigns/:id/archive/scenes', (req, res) => {
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
});

// Rollback: remove all scenes >= sceneId from .archive.md and .archive.index.json
app.delete('/api/campaigns/:id/archive/scenes-from/:sceneId', (req, res) => {
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

    // Trim facts from this scene onwards
    const factsFile = factsPath(req.params.id);
    if (fs.existsSync(factsFile)) {
        const allFacts = readJson(factsFile, []);
        const keptFacts = allFacts.filter(f => parseInt(f.sceneId, 10) < fromNum);
        writeJson(factsFile, keptFacts);
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
            chapters.push({
                chapterId: `CH${String(nextNum).padStart(2, '0')}`,
                title: `Chapter ${nextNum}`,
                sceneRange: [fromId, fromId],
                summary: '',
                keywords: [],
                npcs: [],
                majorEvents: [],
                unresolvedThreads: [],
                tone: '',
                themes: [],
                sceneCount: 0, // Will be incremented on next append
            });
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
//  Semantic Facts Store
// ═══════════════════════════════════════════

app.get('/api/campaigns/:id/facts', (req, res) => {
    const facts = readJson(factsPath(req.params.id), []);
    res.json(facts);
});

app.put('/api/campaigns/:id/facts', (req, res) => {
    ensureDirs();
    writeJson(factsPath(req.params.id), req.body);
    res.json({ ok: true });
});

// ═══════════════════════════════════════════
//  Assets (NPC Portraits)
// ═══════════════════════════════════════════

const PUBLIC_ASSETS_DIR = path.join(__dirname, 'public', 'assets', 'portraits');
if (!fs.existsSync(PUBLIC_ASSETS_DIR)) fs.mkdirSync(PUBLIC_ASSETS_DIR, { recursive: true });

app.post('/api/assets/download', async (req, res) => {
    const { url, filename } = req.body;
    if (!url || !filename) return res.status(400).json({ error: 'Missing url or filename' });

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const filePath = path.join(PUBLIC_ASSETS_DIR, filename);
        fs.writeFileSync(filePath, buffer);

        // Return the relative path for the frontend (Vite serves /public at root)
        const relativePath = `/assets/portraits/${filename}`;
        res.json({ ok: true, path: relativePath });
    } catch (err) {
        console.error('[Asset Download] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════
//  Campaign Backups
// ═══════════════════════════════════════════

app.post('/api/campaigns/:id/backup', (req, res) => {
    try {
        const id = req.params.id;
        const campaignFile = path.join(CAMPAIGNS_DIR, `${id}.json`);
        if (!fs.existsSync(campaignFile)) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        const result = createBackup(id, {
            label: req.body.label || '',
            trigger: req.body.trigger || 'manual',
            isAuto: req.body.isAuto || false,
        });
        res.json(result);
    } catch (err) {
        console.error('[Backup] Create failed:', err);
        res.status(500).json({ error: 'Failed to create backup', detail: err.message });
    }
});

app.get('/api/campaigns/:id/backups', (req, res) => {
    try {
        const backupDir = path.join(BACKUPS_DIR, req.params.id);
        if (!fs.existsSync(backupDir)) return res.json({ backups: [] });

        const backups = fs.readdirSync(backupDir)
            .filter(f => fs.statSync(path.join(backupDir, f)).isDirectory())
            .map(f => {
                const meta = readJson(path.join(backupDir, f, 'meta.json'), null);
                if (!meta) return null;
                return { ...meta, timestamp: Number(f) };
            })
            .filter(Boolean)
            .sort((a, b) => b.timestamp - a.timestamp);

        res.json({ backups });
    } catch (err) {
        console.error('[Backup] List failed:', err);
        res.status(500).json({ error: 'Failed to list backups' });
    }
});

app.get('/api/campaigns/:id/backups/:ts', (req, res) => {
    try {
        const backupPath = path.join(BACKUPS_DIR, req.params.id, req.params.ts);
        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ error: 'Backup not found' });
        }
        const meta = readJson(path.join(backupPath, 'meta.json'), {});
        const files = fs.readdirSync(backupPath).filter(f => f !== 'meta.json');
        res.json({ meta, files });
    } catch (err) {
        res.status(500).json({ error: 'Failed to read backup' });
    }
});

app.post('/api/campaigns/:id/backups/:ts/restore', (req, res) => {
    try {
        const id = req.params.id;
        const ts = req.params.ts;
        const backupPath = path.join(BACKUPS_DIR, id, ts);
        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ error: 'Backup not found' });
        }

        const restoreBackup = createBackup(id, {
            label: `Pre-restore from ${new Date(Number(ts)).toLocaleString()}`,
            trigger: 'pre-restore',
            isAuto: false,
        });

        const backupFiles = fs.readdirSync(backupPath).filter(f => f !== 'meta.json');
        for (const name of backupFiles) {
            const src = path.join(backupPath, name);
            const dst = path.join(CAMPAIGNS_DIR, name);
            fs.copyFileSync(src, dst);
        }

        res.json({ ok: true, preRestoreBackup: restoreBackup });
    } catch (err) {
        console.error('[Backup] Restore failed:', err);
        res.status(500).json({ error: 'Failed to restore backup', detail: err.message });
    }
});

app.delete('/api/campaigns/:id/backups/:ts', (req, res) => {
    try {
        const backupPath = path.join(BACKUPS_DIR, req.params.id, req.params.ts);
        if (!fs.existsSync(backupPath)) {
            return res.status(404).json({ error: 'Backup not found' });
        }
        fs.rmSync(backupPath, { recursive: true, force: true });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete backup' });
    }
});

// ═══════════════════════════════════════════
//  Start
// ═══════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`[GM-Cockpit API] ✓ Running on http://localhost:${PORT}`);
    console.log(`[GM-Cockpit API]   Data dir: ${DATA_DIR}`);
});
