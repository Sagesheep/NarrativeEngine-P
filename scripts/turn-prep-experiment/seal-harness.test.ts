// Turn Prep Experiment — chapter re-seal harness (Upgrade/Turn-Prep-Experiment/SPEC.md §4 F1–F3).
//
// Re-seals one chapter of an experiment copy with the app's OWN combined-seal code,
// with one deliberate difference: scene truncation is disabled, so the model reads
// whole scenes instead of the first ~2,000 characters of each (COMBINED_SEAL_TOKEN_BUDGET
// = 12k vs ~36k-token chapters in Spirit Card World). The model call itself happens
// outside this harness:
//
//   EXP_MODE=prompt EXP_CHAPTER=CH01  → writes work/<campaign>/CH01.prompt.txt
//   (a model answers it)               → work/<campaign>/CH01.output.json
//   EXP_MODE=apply  EXP_CHAPTER=CH01  → parses with parseCombinedSealOutput and applies
//                                       it exactly as runCombinedSeal does
//                                       (postTurnPipeline.ts), writing campaign files.
//
// Chapters must be applied oldest-first: each prompt lists the active state facts the
// next seal may supersede.
//
// Run: npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts

import fs from 'fs';
import path from 'path';
import { test, vi } from 'vitest';

vi.mock('../../src/services/saveFile/shared', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../src/services/saveFile/shared')>();
    return { ...actual, truncateScenesToBudget: (scenes: { sceneId: string; content: string }[]) => scenes };
});

import { sealChapterCombined, parseCombinedSealOutput } from '../../src/services/saveFile/combinedSeal';
import { mergeLifecycleEntries } from '../../src/services/campaign-state/divergenceRegister';
import { countTokens } from '../../src/services/infrastructure/tokenizer';
import type { ArchiveChapter, ArchiveIndexEntry, DivergenceRegister, NPCEntry } from '../../src/types';

const CAMPAIGN = process.env.EXP_CAMPAIGN ?? 'exp-c1-rebuilt';
const CHAPTER = process.env.EXP_CHAPTER ?? '';
const MODE = process.env.EXP_MODE ?? '';
const DIR = path.resolve('data/campaigns');
const WORK = path.resolve('scripts/turn-prep-experiment/work', CAMPAIGN);

const file = (suffix: string) => path.join(DIR, `${CAMPAIGN}${suffix}`);
const readJson = <T,>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p: string, v: unknown) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

function loadChapter() {
    const chapters = readJson<ArchiveChapter[]>(file('.archive.chapters.json'));
    const chapter = chapters.find(c => c.chapterId === CHAPTER);
    if (!chapter) throw new Error(`No chapter ${CHAPTER} in ${CAMPAIGN}`);
    const [start, end] = chapter.sceneRange.map(s => parseInt(s, 10));
    const sceneIds = chapter.sceneIds?.length
        ? chapter.sceneIds
        : Array.from({ length: end - start + 1 }, (_, i) => String(start + i).padStart(3, '0'));
    const npcData = readJson<NPCEntry[]>(file('.npcs.json')).map(n => ({ id: n.id, name: n.name, aliases: n.aliases }));
    return { chapters, chapter, sceneIds, start, end, npcData };
}

// Same block split as server/services/archiveService.js fetchScenesByIds.
function fetchScenes(sceneIds: string[]) {
    const raw = fs.readFileSync(file('.archive.md'), 'utf8');
    const out: { sceneId: string; content: string }[] = [];
    for (const block of raw.split(/^(?=## SCENE )/m)) {
        const m = block.match(/^## SCENE (\d+)/);
        if (m && sceneIds.includes(m[1].padStart(3, '0'))) out.push({ sceneId: m[1].padStart(3, '0'), content: block.trim() });
    }
    return out;
}

async function writePrompt() {
    const { chapter, sceneIds, start, end, npcData } = loadChapter();
    const index = readJson<ArchiveIndexEntry[]>(file('.archive.index.json'));
    const register = readJson<DivergenceRegister>(file('.divergence.json'));
    const indexEntries = index
        .filter(e => { const n = parseInt(e.sceneId, 10); return n >= start && n <= end && e.witnesses?.length; })
        .map(e => ({ sceneId: e.sceneId, witnesses: e.witnesses }));

    let prompt = '';
    await sealChapterCombined(
        undefined, fetchScenes(sceneIds), chapter.chapterId, chapter.title, sceneIds, npcData,
        0, 0, indexEntries.length > 0 ? indexEntries : undefined, register.entries,
        async (request) => { prompt = request.prompt; return ''; },
    );
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(path.join(WORK, `${CHAPTER}.prompt.txt`), prompt);
    console.log(`[seal-harness] ${CAMPAIGN} ${CHAPTER}: prompt ${countTokens(prompt)} tokens, ${sceneIds.length} scenes, ${register.entries.length} facts in register`);
}

// Mirrors runCombinedSeal (src/services/turn/postTurnPipeline.ts) against files instead of the API.
function applyOutput() {
    const { chapters, chapter, sceneIds, npcData } = loadChapter();
    // Applying twice would append the chapter's facts twice. Refuse unless forced.
    const existing = readJson<DivergenceRegister>(file('.divergence.json')).entries.filter(e => e.chapterId === CHAPTER).length;
    if (existing > 0 && process.env.EXP_FORCE !== '1') {
        throw new Error(`${CHAPTER} is already applied (${existing} facts in the register). Refusing to apply twice.`);
    }
    const raw = fs.readFileSync(path.join(WORK, `${CHAPTER}.output.json`), 'utf8');
    const result = parseCombinedSealOutput(raw, chapter.chapterId, sceneIds, npcData);
    if (!result.summary && result.divergences.length === 0) throw new Error(`${CHAPTER}: seal output unusable`);

    if (result.summary) {
        Object.assign(chapter, result.summary, { invalidated: false, sceneIds });
        writeJson(file('.archive.chapters.json'), chapters);
    }

    const register = readJson<DivergenceRegister>(file('.divergence.json'));
    const merged = result.divergences.length > 0
        ? mergeLifecycleEntries(register, result.divergences, sceneIds[sceneIds.length - 1] ?? '')
        : register;
    writeJson(file('.divergence.json'), merged);

    const index = readJson<ArchiveIndexEntry[]>(file('.archive.index.json'));
    for (const [sceneId, names] of Object.entries(result.witnessCorrections ?? {})) {
        const entry = index.find(e => e.sceneId === sceneId);
        if (entry && names.length > 0) { entry.witnesses = names; entry.witnessSource = 'seal_correction'; }
    }
    for (const [sceneId, events] of Object.entries(result.sceneEventMap ?? {})) {
        const entry = index.find(e => e.sceneId === sceneId);
        if (entry) entry.events = events;
    }
    writeJson(file('.archive.index.json'), index);

    const byCategory: Record<string, number> = {};
    for (const d of result.divergences) byCategory[d.category] = (byCategory[d.category] ?? 0) + 1;
    const superseded = merged.entries.filter(e => e.status === 'superseded').length;
    console.log(`[seal-harness] ${CAMPAIGN} ${CHAPTER} applied: "${result.summary?.title ?? '(no summary)'}"`,
        JSON.stringify({ facts: result.divergences.length, byCategory, scoped: result.divergences.filter(d => d.knownBy !== undefined).length,
            superseded, witnessCorrections: Object.keys(result.witnessCorrections ?? {}).length,
            scenesWithEvents: Object.keys(result.sceneEventMap ?? {}).length, parseError: !!result.divergenceParseError }));
}

// Removes one chapter's facts and reactivates any fact it had superseded, so the chapter
// can be sealed again. Its summary, witness corrections and scene events are left in place;
// the re-apply overwrites them.
function unapplyChapter() {
    const register = readJson<DivergenceRegister>(file('.divergence.json'));
    const removedIds = new Set(register.entries.filter(e => e.chapterId === CHAPTER).map(e => e.id));
    let reactivated = 0;
    const entries = register.entries
        .filter(e => !removedIds.has(e.id))
        .map(e => {
            if (e.status === 'superseded' && e.supersededBy && removedIds.has(e.supersededBy)) {
                reactivated++;
                const { supersededBy: _dropped, ...rest } = e;
                return { ...rest, status: 'active' as const };
            }
            return e;
        });
    writeJson(file('.divergence.json'), { ...register, entries });
    console.log(`[seal-harness] ${CAMPAIGN} ${CHAPTER} unapplied: removed ${removedIds.size} facts, reactivated ${reactivated}`);
}

// After chapters were sealed in parallel, several active facts can share one stateKey.
// Keep the latest (highest sceneRef, then last written) and mark the rest superseded by it.
function settleStateKeys() {
    const register = readJson<DivergenceRegister>(file('.divergence.json'));
    const byKey = new Map<string, number[]>();
    register.entries.forEach((e, i) => {
        if (e.stateKey && e.status !== 'superseded') byKey.set(e.stateKey, [...(byKey.get(e.stateKey) ?? []), i]);
    });
    let settled = 0;
    for (const indexes of byKey.values()) {
        if (indexes.length < 2) continue;
        const ordered = [...indexes].sort((a, b) =>
            (parseInt(register.entries[a].sceneRef, 10) - parseInt(register.entries[b].sceneRef, 10)) || (a - b));
        const keep = register.entries[ordered[ordered.length - 1]];
        for (const i of ordered.slice(0, -1)) {
            register.entries[i] = { ...register.entries[i], status: 'superseded', supersededBy: keep.id };
            settled++;
        }
    }
    writeJson(file('.divergence.json'), register);
    console.log(`[seal-harness] ${CAMPAIGN} settled: ${settled} older state facts superseded by a newer one with the same stateKey`);
}

test(`seal harness: ${MODE} ${CAMPAIGN} ${CHAPTER}`, async () => {
    if (MODE === 'settle') return settleStateKeys();
    if (!CHAPTER) throw new Error('Set EXP_CHAPTER');
    if (MODE === 'prompt') await writePrompt();
    else if (MODE === 'apply') applyOutput();
    else if (MODE === 'unapply') unapplyChapter();
    else throw new Error('Set EXP_MODE=prompt|apply|unapply|settle');
}, 60_000);
