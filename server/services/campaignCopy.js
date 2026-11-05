// Campaign copy — duplicate a campaign, or restart it without its history.
//
//   full  — every file the campaign owns, scene images and vectors included.
//           A save-scum branch: the copy continues from where the source is.
//   clean — the same world, rules and engine setup with no trace of play. The
//           GM must not be able to tell that anyone has played here before.
//
// Clean copy is an ALLOWLIST at every level (files, context fields, mod tables)
// rather than a list of things to remove. Forgetting to allow a new field costs
// a setting the user re-enters; forgetting to remove one leaks the story into
// the "fresh" campaign, silently, for as long as it is played. The source is
// never modified, so anything left behind is still there.

import fs from 'fs';
import path from 'path';
import { CAMPAIGNS_DIR, MIGRATION_LEDGER_SUFFIX, readJson, writeJson, ensureDirs, validateCampaignId } from '../lib/fileStore.js';
import { isCampaignMetaFile, serverTableRegistry } from '../lib/tableRegistry.js';
import { withCampaignLock } from '../lib/writeLock.js';
import { copyCampaignEmbeddings } from '../lib/vectorStore.js';

export const COPY_MODES = Object.freeze(['full', 'clean']);

/** Built-in files that are setup, not play. Everything else is dropped. */
const CLEAN_COPY_FILE_SUFFIXES = Object.freeze([
    '.lore.json',
    '.overworld.json',
    MIGRATION_LEDGER_SUFFIX,
    // Retired files a mod has not adopted yet: the enemy definitions and combat
    // config, but not the instances, encounters or resolutions.
    '.enemies.json',
    '.enemy-combat.json',
]);

/** `context` fields describing the world and how the engines run. */
const CLEAN_COPY_CONTEXT_FIELDS = Object.freeze([
    'loreRaw', 'rulesRaw', 'rulesChunkMeta', 'rulesChunks',
    'canonState', 'starter', 'continuePrompt', 'worldVibe',
    'canonStateActive', 'starterActive', 'continuePromptActive',
    'headerIndexActive', 'inventoryActive', 'characterProfileActive',
    'sceneNoteActive', 'sceneNoteDepth', 'notebookActive', 'smartBookkeepingActive',
    'surpriseEngineActive', 'encounterEngineActive', 'worldEngineActive',
    'npcIntroEngineActive', 'diceFairnessActive', 'relationshipMemory',
    'diceConfig', 'diceSystem', 'statLabelMap',
    'surpriseConfig', 'encounterConfig', 'worldEventConfig', 'npcIntroConfig',
    'combatModeActive', 'combatConfig',
    'lootTree', 'activeLootProfileId',
    'promptInjections', 'glossary', 'galleryUploads',
    'mapWorldSetting', 'travelUnit',
]);

/** NPC fields that only exist because of what happened in play. */
const NPC_PLAY_FIELDS = Object.freeze([
    'relationMeter', 'previousSnapshot', 'shiftNote', 'shiftTurnCount', 'pressure',
    'archived', 'archivedAtTurn', 'archivedReason', 'repressionPressure',
    'agencyActivity', 'goalRecords', 'lastUpdateScene',
    // Retired fields still on older saves. The load path folds `affinity` back
    // into `pcRelation` and `drives` into `wants` (retireLegacyFields.ts), which
    // would undo the reset below the first time the copy is opened.
    'affinity', 'drives',
]);

function mentions(text, name) {
    return Boolean(name) && typeof text === 'string' && text.toLowerCase().includes(name.toLowerCase());
}

/**
 * An NPC as they were before they met the player. `storyRelevance` and the legacy
 * `goals` are what the bookkeeper rewrites with events, so they survive only when
 * they are still the author's text, which is to say verbatim in the world lore.
 */
export function cleanNpc(npc, { loreText = '', pcName = '' } = {}) {
    const cleaned = { ...npc };
    for (const field of NPC_PLAY_FIELDS) delete cleaned[field];

    // A personality shift is something the story did to them.
    if (npc.previousSnapshot) {
        const { personality, voice, personalityHex, skillRung } = npc.previousSnapshot;
        if (personality !== undefined) cleaned.personality = personality;
        if (voice !== undefined) cleaned.voice = voice;
        if (personalityHex !== undefined) cleaned.personalityHex = personalityHex;
        if (skillRung !== undefined) cleaned.skillRung = skillRung;
    }

    cleaned.pcRelation = 0;
    cleaned.status = 'Alive';
    cleaned.condition = 'healthy';
    if (!cleaned.storyRelevance || !loreText.includes(cleaned.storyRelevance)) {
        cleaned.storyRelevance = '';
    }
    if (cleaned.goals && !loreText.includes(cleaned.goals)) delete cleaned.goals;

    // Wants are rewritten in play and can name the player outright.
    if (cleaned.wants) {
        cleaned.wants = {
            ...cleaned.wants,
            short: (cleaned.wants.short ?? []).filter(want => !mentions(want, pcName)),
            medium: (cleaned.wants.medium ?? []).filter(want => !mentions(want, pcName)),
            long: mentions(cleaned.wants.long, pcName) ? '' : cleaned.wants.long,
        };
    }
    return cleaned;
}

/**
 * The same character at the start of their story. `storyRelevance` is the
 * player's own backstory, which play never writes (see pcUpdater.ts). The wants
 * and signature kit are what the updater rewrites as the story moves, with no
 * earlier version to restore, so they go.
 */
function cleanPlayerCharacter(pc) {
    const cleaned = cleanNpc(pc, { loreText: pc.storyRelevance ?? '' });
    delete cleaned.signatureKit;
    if (cleaned.wants) cleaned.wants = { ...cleaned.wants, medium: [], long: '' };
    return cleaned;
}

/**
 * Places the author made, unvisited. `source: 'llm'` marks estimator output, and
 * the `site-` and `point-` ids plus route and position records are the map's own
 * trail of where the player has been.
 */
export function cleanLocations(locations) {
    const isAuthored = (loc) => loc.source === 'manual'
        && (loc.recordKind ?? 'place') === 'place'
        && (loc.kind ?? 'place') === 'place'
        && !/^(site|point)-/.test(loc.id);
    const kept = locations.filter(isAuthored);
    const keptIds = new Set(kept.map(loc => loc.id));

    return kept.map(({ status: _status, knowledgeNote: _note, ...loc }) => ({
        ...loc,
        connections: (loc.connections ?? []).filter(c => keptIds.has(c.toId)),
        knowledge: loc.knowledge === 'visited' ? 'known' : loc.knowledge,
        firstSeenScene: '',
        lastSeenScene: '',
    }));
}

export function cleanContext(context = {}, { keepCharacter = false } = {}) {
    const cleaned = {};
    for (const field of CLEAN_COPY_CONTEXT_FIELDS) {
        if (context[field] !== undefined) cleaned[field] = context[field];
    }
    // The engine DCs decay during play. Back to each config's start, or left
    // absent for the hydrator's defaults.
    if (context.surpriseConfig?.initialDC !== undefined) cleaned.surpriseDC = context.surpriseConfig.initialDC;
    if (context.encounterConfig?.initialDC !== undefined) cleaned.encounterDC = context.encounterConfig.initialDC;
    if (context.worldEventConfig?.initialDC !== undefined) cleaned.worldEventDC = context.worldEventConfig.initialDC;
    if (context.npcIntroConfig?.initialDC !== undefined) cleaned.npcIntroDC = context.npcIntroConfig.initialDC;

    if (keepCharacter && context.playerCharacter) {
        cleaned.playerCharacter = cleanPlayerCharacter(context.playerCharacter);
        cleaned.pcPromptDismissed = context.pcPromptDismissed;
    }
    return cleaned;
}

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function freshId() {
    let id = uid();
    while (fs.existsSync(path.join(CAMPAIGNS_DIR, `${id}.json`))) id = uid();
    return id;
}

function uniqueName(base) {
    const taken = new Set(
        fs.readdirSync(CAMPAIGNS_DIR)
            .filter(f => isCampaignMetaFile(f))
            .map(f => readJson(path.join(CAMPAIGNS_DIR, f), null)?.name),
    );
    if (!taken.has(base)) return base;
    let n = 2;
    while (taken.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
}

/**
 * Every file the campaign owns, found on disk. `campaignFiles()` knows only
 * registered suffixes and would lose the tables of a disabled mod. Campaign ids
 * cannot contain a dot, so `<id>.` never matches another campaign.
 */
function listSourceFiles(id) {
    return fs.readdirSync(CAMPAIGNS_DIR).filter(f =>
        f.startsWith(`${id}.`) && fs.statSync(path.join(CAMPAIGNS_DIR, f)).isFile());
}

function copyEverything(sourceId, newId) {
    const fromUrl = `/assets/campaigns/${sourceId}/`;
    const toUrl = `/assets/campaigns/${newId}/`;
    for (const file of listSourceFiles(sourceId)) {
        const suffix = file.slice(sourceId.length);
        if (suffix === '.json') continue; // Metadata is written last.
        const content = fs.readFileSync(path.join(CAMPAIGNS_DIR, file), 'utf-8');
        // Scene images are addressed by campaign id, and a copy pointing at the
        // source's would lose them the day the source is deleted.
        fs.writeFileSync(path.join(CAMPAIGNS_DIR, `${newId}${suffix}`), content.replaceAll(fromUrl, toUrl), 'utf-8');
    }
    const assetDir = path.join(CAMPAIGNS_DIR, sourceId);
    if (fs.existsSync(assetDir)) {
        fs.cpSync(assetDir, path.join(CAMPAIGNS_DIR, newId), { recursive: true });
    }
}

function copyClean(sourceId, newId, { keepNpcs = true, keepCharacter = false } = {}) {
    const fromFile = (suffix) => path.join(CAMPAIGNS_DIR, `${sourceId}${suffix}`);
    const toFile = (suffix) => path.join(CAMPAIGNS_DIR, `${newId}${suffix}`);

    const keptModSuffixes = new Set(
        serverTableRegistry.list().filter(d => d.keepOnCleanCopy === true).map(d => d.fileSuffix),
    );
    for (const suffix of [...CLEAN_COPY_FILE_SUFFIXES, ...keptModSuffixes]) {
        if (fs.existsSync(fromFile(suffix))) fs.copyFileSync(fromFile(suffix), toFile(suffix));
    }

    const state = readJson(fromFile('.state.json'), null);
    const context = state?.context ?? {};
    writeJson(toFile('.state.json'), {
        context: cleanContext(context, { keepCharacter }),
        messages: [],
        condenser: { condensedUpToIndex: -1 },
        pinnedExcerpts: [],
    });

    const lore = readJson(fromFile('.lore.json'), []);
    const loreText = lore.map(chunk => chunk.content ?? '').join('\n');
    const npcs = readJson(fromFile('.npcs.json'), []);
    // A legacy PC row is the character, not an NPC. On load it moves into the
    // context, so it follows the character choice rather than the NPC one.
    const legacyPc = npcs.find(npc => npc.isPC);
    const pcName = context.playerCharacter?.name || legacyPc?.name || context.characterProfileData?.name || '';
    const keptNpcs = [
        ...(keepCharacter && legacyPc ? [cleanPlayerCharacter(legacyPc)] : []),
        // Walk-ons and one-shots exist only because a scene needed them.
        ...(keepNpcs ? npcs.filter(npc => !npc.isPC && npc.tier !== 'walkon' && npc.tier !== 'oneshot') : [])
            .map(npc => cleanNpc(npc, { loreText, pcName })),
    ];
    if (keptNpcs.length > 0) writeJson(toFile('.npcs.json'), keptNpcs);

    const locations = cleanLocations(readJson(fromFile('.locations.json'), []));
    if (locations.length > 0) writeJson(toFile('.locations.json'), locations);
}

/**
 * Copy a campaign. Metadata goes last because its file is what makes a campaign
 * exist: a failure part way leaves nothing listed, and the partial files go.
 *
 * @returns {Promise<object | null>} the new campaign record, or null if the source does not exist.
 */
export async function copyCampaign(sourceId, { mode, keepNpcs, keepCharacter } = {}) {
    validateCampaignId(sourceId);
    ensureDirs();
    const source = readJson(path.join(CAMPAIGNS_DIR, `${sourceId}.json`), null);
    if (!source) return null;

    // Held so a deferred archive write cannot land between two of the files read here.
    return withCampaignLock(sourceId, () => {
        const newId = freshId();
        try {
            if (mode === 'clean') copyClean(sourceId, newId, { keepNpcs, keepCharacter });
            else copyEverything(sourceId, newId);

            const now = Date.now();
            const campaign = {
                ...source,
                id: newId,
                name: uniqueName(`${source.name} (${mode === 'clean' ? 'Fresh' : 'Copy'})`),
                createdAt: now,
                lastPlayedAt: now,
            };

            // Reusing vectors avoids re-embedding the whole world. A failure only
            // leaves the copy needing a re-index, so it does not fail the copy.
            try {
                copyCampaignEmbeddings(sourceId, newId, mode === 'clean' ? ['lore', 'rule'] : ['scene', 'lore', 'rule']);
            } catch (err) {
                console.warn(`[CampaignCopy] Embeddings not copied for ${newId}: ${err.message}`);
            }

            writeJson(path.join(CAMPAIGNS_DIR, `${newId}.json`), campaign);
            return campaign;
        } catch (err) {
            for (const file of listSourceFiles(newId)) fs.rmSync(path.join(CAMPAIGNS_DIR, file), { force: true });
            fs.rmSync(path.join(CAMPAIGNS_DIR, newId), { recursive: true, force: true });
            throw err;
        }
    });
}
