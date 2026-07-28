import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __fileDir = path.dirname(fileURLToPath(import.meta.url));
const __projectRoot = path.join(__fileDir, '../..');

export const DATA_DIR = process.env.DATA_DIR || path.join(__projectRoot, 'data');
export const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const PUBLIC_ASSETS_DIR = process.env.NODE_ENV === 'production'
    ? path.join(DATA_DIR, 'portraits')
    : path.join(__projectRoot, 'public', 'assets', 'portraits');

const ID_REGEX = /^[a-zA-Z0-9_-]+$/;

export function validateCampaignId(id) {
    if (typeof id !== 'string' || !ID_REGEX.test(id)) {
        const err = new Error('Invalid campaign ID');
        err.statusCode = 400;
        throw err;
    }
}

export function ensureDirs() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CAMPAIGNS_DIR)) fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    if (!fs.existsSync(PUBLIC_ASSETS_DIR)) fs.mkdirSync(PUBLIC_ASSETS_DIR, { recursive: true });
}

export function readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) { console.warn(`[fileStore] readJson failed: ${filePath} — ${e.message}`); return fallback; }
}

export function writeJson(filePath, data) {
    try {
        // Write to a temp file first, then rename for atomicity (prevents partial writes on crash/disk-full)
        const tmp = filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
        fs.renameSync(tmp, filePath);
    } catch (err) {
        console.error(`[writeJson] Failed to write ${filePath}: ${err.message}`);
        throw err;
    }
}

export function archivePath(id) {
    validateCampaignId(id);
    return path.join(CAMPAIGNS_DIR, `${id}.archive.md`);
}

export function archiveIndexPath(id) {
    validateCampaignId(id);
    return path.join(CAMPAIGNS_DIR, `${id}.archive.index.json`);
}

export function chaptersPath(id) {
    validateCampaignId(id);
    return path.join(CAMPAIGNS_DIR, `${id}.archive.chapters.json`);
}

export function factsPath(id) {
    validateCampaignId(id);
    return path.join(CAMPAIGNS_DIR, `${id}.facts.json`);
}

export function entitiesPath(id) {
    validateCampaignId(id);
    return path.join(CAMPAIGNS_DIR, `${id}.entities.json`);
}

export function timelinePath(id) {
    validateCampaignId(id);
    return path.join(CAMPAIGNS_DIR, `${id}.timeline.json`);
}

export function overworldPath(id) {
    validateCampaignId(id);
    return path.join(CAMPAIGNS_DIR, `${id}.overworld.json`);
}

export function divergencePath(id) {
    validateCampaignId(id);
    return path.join(CAMPAIGNS_DIR, `${id}.divergence.json`);
}

/**
 * The next free scene number.
 *
 * Takes the MAX across BOTH `.archive.md` and `.archive.index.json`, for two
 * separate reasons.
 *
 * Max rather than last: the prose is ascending under normal append-only use, but
 * an out-of-order merge, restore, or import would make "last" smaller than an
 * existing scene.
 *
 * Both files rather than the prose alone: `appendScene` writes the prose
 * synchronously and the index entry behind an awaited lock, so an interrupted
 * append can leave one without the other. Reading only the prose means an
 * index-only remnant gets its number handed out AGAIN — and a reused id is the
 * one failure this system cannot absorb, because scene ids are the primary key
 * for the index, chapters, embeddings, facts, the timeline and the divergence
 * register, so two scenes sharing an id silently merges their history. Skipping
 * a number costs a gap in the sequence, which everything already tolerates.
 */
export function getNextSceneNumber(id) {
    let highest = 0;

    const fp = archivePath(id);
    if (fs.existsSync(fp)) {
        const matches = fs.readFileSync(fp, 'utf-8').match(/^## SCENE (\d+)/gm) || [];
        for (const m of matches) {
            const num = parseInt(m.replace('## SCENE ', ''), 10);
            if (Number.isFinite(num) && num > highest) highest = num;
        }
    }

    const idxEntries = readJson(archiveIndexPath(id), []);
    if (Array.isArray(idxEntries)) {
        for (const e of idxEntries) {
            const num = parseInt(e?.sceneId, 10);
            if (Number.isFinite(num) && num > highest) highest = num;
        }
    }

    return highest + 1;
}

export function createDefaultChapter(chapterId, title, sceneRangeStart, sceneCount = 0) {
    return {
        chapterId,
        title,
        sceneRange: [sceneRangeStart, sceneRangeStart],
        sceneIds: [],
        summary: '',
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount,
    };
}

const CAMPAIGN_FILE_SUFFIXES = [
    '.json', '.state.json', '.lore.json', '.npcs.json', '.enemies.json', '.abilities.json', '.enemy-instances.json', '.enemy-encounters.json', '.enemy-resolutions.json', '.enemy-combat.json', '.locations.json',
    '.archive.md', '.archive.index.json', '.archive.chapters.json',
    '.timeline.json', '.entities.json', '.facts.json',
    '.overworld.json', '.divergence.json',
];

export function campaignFileNames(id) {
    return CAMPAIGN_FILE_SUFFIXES.map(s => `${id}${s}`);
}

export function computeCampaignHash(id) {
    const hash = crypto.createHash('md5');
    for (const name of campaignFileNames(id)) {
        const fp = path.join(CAMPAIGNS_DIR, name);
        if (fs.existsSync(fp)) {
            hash.update(fs.readFileSync(fp, 'utf-8'));
        }
    }
    return hash.digest('hex');
}

export function campaignFiles(id) {
    return campaignFileNames(id).filter(n => fs.existsSync(path.join(CAMPAIGNS_DIR, n)));
}
