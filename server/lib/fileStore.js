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
    } catch { return fallback; }
}

export function writeJson(filePath, data) {
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

export function archivePath(id) {
    return path.join(CAMPAIGNS_DIR, `${id}.archive.md`);
}

export function archiveIndexPath(id) {
    return path.join(CAMPAIGNS_DIR, `${id}.archive.index.json`);
}

export function chaptersPath(id) {
    return path.join(CAMPAIGNS_DIR, `${id}.archive.chapters.json`);
}

export function factsPath(id) {
    return path.join(CAMPAIGNS_DIR, `${id}.facts.json`);
}

export function entitiesPath(id) {
    return path.join(CAMPAIGNS_DIR, `${id}.entities.json`);
}

export function timelinePath(id) {
    return path.join(CAMPAIGNS_DIR, `${id}.timeline.json`);
}

export function getNextSceneNumber(id) {
    const fp = archivePath(id);
    if (!fs.existsSync(fp)) return 1;
    const content = fs.readFileSync(fp, 'utf-8');
    const matches = content.match(/^## SCENE (\d+)/gm);
    if (!matches || matches.length === 0) return 1;
    const last = matches[matches.length - 1];
    const num = parseInt(last.replace('## SCENE ', ''), 10);
    return num + 1;
}

export function createDefaultChapter(chapterId, title, sceneRangeStart, sceneCount = 0) {
    return {
        chapterId,
        title,
        sceneRange: [sceneRangeStart, sceneRangeStart],
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
    '.json', '.state.json', '.lore.json', '.npcs.json',
    '.archive.md', '.archive.index.json', '.archive.chapters.json',
    '.timeline.json', '.entities.json', '.facts.json',
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
