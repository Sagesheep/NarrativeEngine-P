import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { getCampaignFileSuffixes } from './tableRegistry.js';
import { RETIRED_CAMPAIGN_FILE_SUFFIXES } from './legacyTables.js';

const __fileDir = path.dirname(fileURLToPath(import.meta.url));
const __projectRoot = path.join(__fileDir, '../..');

export const DATA_DIR = process.env.DATA_DIR || path.join(__projectRoot, 'data');
export const CAMPAIGNS_DIR = path.join(DATA_DIR, 'campaigns');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const PUBLIC_ASSETS_DIR = process.env.NODE_ENV === 'production'
    ? path.join(DATA_DIR, 'portraits')
    : path.join(__projectRoot, 'public', 'assets', 'portraits');

/**
 * Installed mods (Project 2 / WO-P2-04). Deliberately a SIBLING of `data/` rather than a child:
 * mods are app-level, not campaign-level, so wiping `data/` must not uninstall them.
 * Overridable for tests and packaged builds via MODS_DIR.
 */
export const MODS_DIR = process.env.MODS_DIR || path.join(__projectRoot, 'mods');

/**
 * Phase 6.3 — bundled mods (ships with the app, on by default).
 *
 * Bundled mods live wherever app assets live, NOT in the user's `mods/` folder —
 * otherwise an app update overwrites a folder the user may have edited. In dev that
 * is `public/bundled-mods/` (sibling of `public/assets/`); in production it is a
 * folder inside the app package, never inside `data/`. Overridable via
 * `BUNDLED_MODS_DIR` for tests and alternate layouts.
 *
 * A bundled mod is not special-cased in the loader: same validation, same faults.
 * The only difference is the `provenance: 'bundled'` tag the loader stamps on it
 * and the default-enabled convention (absent key = enabled, same as every mod).
 */
export const BUNDLED_MODS_DIR = process.env.BUNDLED_MODS_DIR || path.join(__projectRoot, 'public', 'bundled-mods');

/**
 * Host app version, from `package.json` — used for mod `appVersion` compatibility checks.
 *
 * `undefined` when it cannot be read (e.g. a packaged bundle whose layout puts package.json
 * elsewhere). Unknown is deliberately NOT the same as incompatible: `modLoader` skips the
 * compatibility check when it has no version to compare against, because being unable to check
 * is not evidence that a mod is broken.
 */
export const APP_VERSION = readAppVersion();

function readAppVersion() {
    for (const dir of [__projectRoot, process.cwd()]) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
            if (typeof pkg?.version === 'string' && pkg.version.trim()) return pkg.version;
        } catch { /* try the next candidate */ }
    }
    return undefined;
}

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
    // Created empty so a user has somewhere obvious to drop a `.mod.json` file.
    if (!fs.existsSync(MODS_DIR)) fs.mkdirSync(MODS_DIR, { recursive: true });
    // Phase 6.3 — bundled mods ship with the app. The folder is committed, so
    // it exists in dev; this only creates it in a packaged layout that forgot
    // to include it, so a missing folder is the normal case and not a fault.
    if (!fs.existsSync(BUNDLED_MODS_DIR)) fs.mkdirSync(BUNDLED_MODS_DIR, { recursive: true });
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

/**
 * Phase 8.5 — the per-campaign migration ledger.
 *
 * Records that a retired campaign file has been adopted into a mod's table, so
 * adoption happens exactly once no matter how many times the campaign is
 * opened. It is a campaign file like any other, deliberately: it must be
 * backed up with the campaign, restored with it, exported with it and deleted
 * with it. A ledger that did not travel with a restore would let a restored
 * pre-migration backup silently keep the post-migration tables.
 *
 * Written only by `legacyAdoption.js`, and only for a campaign that actually
 * has a retired file on disk — a campaign created after the extraction never
 * grows one.
 */
export const MIGRATION_LEDGER_SUFFIX = '.migrations.json';

/**
 * The built-in campaign file suffixes. Source-of-truth fallback for the derived
 * `getCampaignFileSuffixes()` in tableRegistry.js (WO-P5-03 §5 Step 2.1). When
 * no descriptors are registered the derived set is exactly this list; when a
 * real table is converted (WO-P5-04) its descriptor's suffix joins the derived
 * set and the fallback eventually retires.
 *
 * Kept here (not in tableRegistry.js) so fileStore.js has zero inbound imports
 * from the registry — tableRegistry.js imports fileStore.js, never the reverse.
 *
 * Phase 8.5 — the five enemy suffixes are no longer spelled out here; they come
 * from `legacyTables.js`, which is now the one place that knows a file was
 * retired. Their POSITION in this array is unchanged, because the order feeds
 * `computeCampaignHash` and reordering it would invalidate every auto-backup's
 * dedupe hash at once. `.migrations.json` is appended at the end for the same
 * reason.
 */
export const BUILTIN_CAMPAIGN_FILE_SUFFIXES = Object.freeze([
    '.json', '.state.json', '.lore.json', '.npcs.json',
    ...RETIRED_CAMPAIGN_FILE_SUFFIXES,
    '.locations.json',
    '.archive.md', '.archive.index.json', '.archive.chapters.json',
    '.timeline.json', '.entities.json', '.facts.json',
    '.overworld.json', '.divergence.json',
    MIGRATION_LEDGER_SUFFIX,
]);

export function campaignFileNames(id) {
    // Derived (WO-P5-03 Step 2.1): with no descriptors registered this is the
    // built-in 18, byte-identical to the prior hand-written list.
    return getCampaignFileSuffixes().map(s => `${id}${s}`);
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
