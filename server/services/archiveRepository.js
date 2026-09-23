/**
 * Archive Repository — pure file I/O layer.
 *
 * Phase 5 split: every filesystem read/write for the archive subsystem lives here.
 * No business logic, no DB calls, no NLP, no locks. The service layer composes
 * these primitives and holds the per-campaign write lock.
 *
 * Path resolution is delegated to `fileStore.js` (which validates campaign IDs),
 * so this module never touches `path`/`fs` directly for path derivation — it only
 * touches the file contents themselves.
 */

import fs from 'fs';
import {
    readJson, writeJson, writeTextAtomic,
    archivePath, archiveIndexPath, chaptersPath, entitiesPath, timelinePath, factsPath,
    getNextSceneNumber, createDefaultChapter,
} from '../lib/fileStore.js';

// ─── Archive prose (.archive.md) ────────────────────────────────────────────

/** Append a pre-formatted scene block string to the archive markdown. Synchronous. */
export function appendSceneBlock(campaignId, blockText) {
    fs.appendFileSync(archivePath(campaignId), blockText, 'utf-8');
}

/** Read the full archive markdown as a UTF-8 string. Returns '' if the file is missing. */
export function readArchiveMd(campaignId) {
    const fp = archivePath(campaignId);
    if (!fs.existsSync(fp)) return '';
    return fs.readFileSync(fp, 'utf-8');
}

/**
 * Overwrite the full archive markdown with `text`, atomically.
 *
 * This is the campaign's lossless record and it has no second copy, so a
 * partial write is unrecoverable. Every derived JSON file already went
 * through `writeJson`'s tmp+rename; this one did not.
 */
export function writeArchiveMd(campaignId, text) {
    writeTextAtomic(archivePath(campaignId), text);
}

/** Does the archive markdown file exist on disk? */
export function archiveMdExists(campaignId) {
    return fs.existsSync(archivePath(campaignId));
}

/** Pre-resolved variant of `archiveMdExists` for callers that already hold a path. */
export function pathExists(p) {
    return fs.existsSync(p);
}

/** Delete a list of resolved file paths (used by the clear route). No-op if missing. */
export function deleteFiles(paths) {
    for (const p of paths) {
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
}

// ─── Archive index (.archive.index.json) ───────────────────────────────────

/** Read the index as an array. Returns `fallback` (default []) if missing/corrupt. */
export function readIndex(campaignId, fallback = []) {
    return readJson(archiveIndexPath(campaignId), fallback);
}

/** Overwrite the full index. */
export function writeIndex(campaignId, entries) {
    writeJson(archiveIndexPath(campaignId), entries);
}

/** Pre-resolved variants — used by append/edit-sync where the path is already computed. */
export function readIndexAt(idxPath, fallback = []) {
    return readJson(idxPath, fallback);
}
export function writeIndexAt(idxPath, entries) {
    writeJson(idxPath, entries);
}

// ─── Chapters (.archive.chapters.json) ─────────────────────────────────────

export function readChapters(campaignId, fallback = []) {
    return readJson(chaptersPath(campaignId), fallback);
}

export function writeChapters(campaignId, chapters) {
    writeJson(chaptersPath(campaignId), chapters);
}

export function writeChaptersAt(chaptersFilePath, chapters) {
    writeJson(chaptersFilePath, chapters);
}

export { createDefaultChapter };

// ─── Entities (.entities.json) ────────────────────────────────────────────

export function readEntities(campaignId, fallback = []) {
    return readJson(entitiesPath(campaignId), fallback);
}

export function readEntitiesAt(entitiesFilePath, fallback = []) {
    return readJson(entitiesFilePath, fallback);
}

export function writeEntitiesAt(entitiesFilePath, entities) {
    writeJson(entitiesFilePath, entities);
}

// ─── Timeline (.timeline.json) ─────────────────────────────────────────────

export function readTimeline(campaignId, fallback = []) {
    return readJson(timelinePath(campaignId), fallback);
}

export function writeTimeline(campaignId, events) {
    writeJson(timelinePath(campaignId), events);
}

export function writeTimelineAt(timelineFilePath, events) {
    writeJson(timelineFilePath, events);
}

export function timelineExists(campaignId) {
    return fs.existsSync(timelinePath(campaignId));
}

// ─── Facts (.facts.json) ───────────────────────────────────────────────────

export function readFacts(campaignId, fallback = []) {
    return readJson(factsPath(campaignId), fallback);
}

export function writeFacts(campaignId, facts) {
    writeJson(factsPath(campaignId), facts);
}

// ─── Scene number + path helpers (pass-through) ────────────────────────────

export { getNextSceneNumber, archivePath, archiveIndexPath, chaptersPath, timelinePath, factsPath, entitiesPath };