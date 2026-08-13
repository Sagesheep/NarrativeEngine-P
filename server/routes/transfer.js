import fs from 'fs';
import { Router } from 'express';
import {
    CAMPAIGNS_DIR, readJson, writeJson, ensureDirs,
    archivePath, archiveIndexPath, chaptersPath, factsPath,
    entitiesPath, timelinePath, validateCampaignId, relationshipMemoryNpcToMcPath, relationshipMemoryNpcToNpcPath,
} from '../lib/fileStore.js';
import { isCampaignMetaFile, getTransferableTables, serverTableRegistry } from '../lib/tableRegistry.js';
import { modTableSuffix, scanModTableFiles } from '../lib/modTableRegistry.js';
import { RETIRED_CAMPAIGN_TABLES } from '../lib/legacyTables.js';
import { readMigrationLedger, normalizeLedger, migrationLedgerPath } from '../lib/legacyAdoption.js';
import { embedText, buildArchiveText, buildLoreText } from '../lib/embedder.js';
import { storeArchiveEmbedding, storeLoreEmbedding } from '../lib/vectorStore.js';
import { wrapAsync } from '../lib/asyncHandler.js';
import path from 'path';

function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Parse the .archive.md format into SceneRecord[]
function parseArchiveMd(content, indexEntries = []) {
    const byId = {};
    for (const e of indexEntries) byId[e.sceneId] = e;

    const blocks = content.split(/^(?=## SCENE )/m).filter(b => b.trim());
    return blocks.map(block => {
        const idMatch = block.match(/^## SCENE (\d+)/);
        if (!idMatch) return null;
        const sceneId = idMatch[1].padStart(3, '0');

        const entry = byId[sceneId];
        let timestamp = entry?.timestamp ?? 0;
        if (!timestamp) {
            const tsMatch = block.match(/^\*(.+)\*$/m);
            if (tsMatch) {
                const parsed = new Date(tsMatch[1]).getTime();
                if (!isNaN(parsed)) timestamp = parsed;
            }
        }

        const userMatch = block.match(/\*\*\[USER\]\*\*\n([\s\S]*?)\n\n\*\*\[GM\]\*\*/);
        const assistantMatch = block.match(/\*\*\[GM\]\*\*\n([\s\S]*?)(?:\n\n---|\n---|\s*$)/);
        return {
            sceneId,
            userContent: userMatch?.[1]?.trim() ?? '',
            assistantContent: assistantMatch?.[1]?.trim() ?? '',
            timestamp,
        };
    }).filter(Boolean);
}

// Reconstruct .archive.md from SceneRecord[]
function scenesToArchiveMd(scenes) {
    return scenes.map(s => {
        const ts = new Date(s.timestamp).toLocaleString();
        return `## SCENE ${s.sceneId}\n*${ts}*\n\n**[USER]**\n${s.userContent}\n\n**[GM]**\n${s.assistantContent}\n\n---\n\n`;
    }).join('');
}

export function createTransferRouter() {
    const router = Router();

    // Export a campaign as a portable bundle
    router.get('/api/campaigns/:id/export', wrapAsync((req, res) => {
        const id = req.params.id;
        validateCampaignId(id);
        const metaPath = path.join(CAMPAIGNS_DIR, `${id}.json`);
        if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'Campaign not found' });

        const campaign = readJson(metaPath, null);
        const state = readJson(path.join(CAMPAIGNS_DIR, `${id}.state.json`), null);
        const lore = readJson(path.join(CAMPAIGNS_DIR, `${id}.lore.json`), []);
        const npcs = readJson(path.join(CAMPAIGNS_DIR, `${id}.npcs.json`), []);
        const archiveIndex = readJson(archiveIndexPath(id), []);
        const chapters = readJson(chaptersPath(id), []);
        const facts = readJson(factsPath(id), []);
        const timeline = readJson(timelinePath(id), []);
        const entities = readJson(entitiesPath(id), []);
        const relationshipMemoryNpcToMc = readJson(relationshipMemoryNpcToMcPath(id), []);
        const relationshipMemoryNpcToNpc = readJson(relationshipMemoryNpcToNpcPath(id), []);

        const fp = archivePath(id);
        const scenes = fs.existsSync(fp)
            ? parseArchiveMd(fs.readFileSync(fp, 'utf-8'), archiveIndex)
            : [];

        const bundle = {
            version: 1,
            exportedAt: Date.now(),
            sourcePlatform: 'desktop',
            campaign,
            state,
            lore,
            npcs,
            scenes,
            archiveIndex,
            chapters,
            facts,
            timeline,
            entities,
            relationshipMemoryNpcToMc,
            relationshipMemoryNpcToNpc,
        };

        // Phase 8.5 — only tables that HAVE a file. This used to emit the
        // record-shape default (`[]` / `null`) for every registered table
        // whether or not the campaign had one, and that turned out to be data
        // loss with extra steps: a campaign exported before its retired files
        // had been adopted carried `mod.<mod>.<table>: []` for tables that did
        // not exist, import wrote those empty files, and their existence then
        // told adoption on the far side that the mod already had data. The
        // campaign opened with an empty compendium and its real one sitting
        // unread on disk. A key in the bundle now means a file on disk, which
        // is what the mod-table scan below and the retired-file loop after it
        // have always meant.
        for (const { bundleKey, fileSuffix, recordShape } of getTransferableTables()) {
            const tablePath = path.join(CAMPAIGNS_DIR, `${id}${fileSuffix}`);
            if (!fs.existsSync(tablePath)) continue;
            bundle[bundleKey] = readJson(tablePath, recordShape === 'array' ? [] : null);
        }

        // Phase 6.4 / `DATA_POLICY.md` §4 — then every mod-table file ON DISK
        // that the loop above did not already cover.
        //
        // The registry is populated as a side effect of `GET /api/mods`, and it
        // forgets a mod the moment its folder is gone. Export driven by the
        // registry alone therefore dropped mod tables in two ordinary cases: a
        // server that had not yet served the mods route, and a campaign whose
        // mod was uninstalled. Both are silent data loss on the path users
        // treat as a backup, and both contradict the policy's promise that a
        // disabled mod's data is kept and comes back intact.
        //
        // Import already preserves unknown `mod.<modId>.<name>` keys (§5
        // below); this is the other half of that symmetry — export must be able
        // to PRODUCE the key import knows how to keep.
        for (const { bundleKey, fileSuffix } of scanModTableFiles(CAMPAIGNS_DIR, id, serverTableRegistry)) {
            if (bundleKey in bundle) continue;
            bundle[bundleKey] = readJson(path.join(CAMPAIGNS_DIR, `${id}${fileSuffix}`), null);
        }

        // Phase 8.5 — and then every RETIRED campaign file still on disk, under
        // the bundle key the app used before that feature left core.
        //
        // Without this, a campaign that has not been adopted yet exports with
        // its enemy data simply missing: core stopped reading those files in
        // 8.2, so the loop above cannot see them and the mod-table scan finds
        // nothing to see. Export is the path users treat as a backup, and a
        // backup that drops the data it was taken to protect is the worst bug
        // this phase could ship.
        //
        // Carrying the ORIGINAL key (`enemies`, not `mod.enemies.compendium`)
        // is deliberate on both ends: a pre-extraction build importing this
        // bundle still finds the key it knows, and a post-extraction build
        // writes the legacy file back and lets the normal adoption path pick
        // it up on first open. One mechanism, not two.
        for (const { bundleKey, fileSuffix, recordShape } of RETIRED_CAMPAIGN_TABLES) {
            if (bundleKey in bundle) continue;
            const legacyPath = path.join(CAMPAIGNS_DIR, `${id}${fileSuffix}`);
            if (!fs.existsSync(legacyPath)) continue;
            bundle[bundleKey] = readJson(legacyPath, recordShape === 'array' ? [] : null);
        }

        // The ledger travels too, so an already-adopted campaign does not
        // re-adopt on the far side and overwrite the mod tables this same
        // bundle is carrying. Only written when something has actually been
        // adopted — a campaign with no migration history exports no key.
        const ledger = readMigrationLedger(id);
        if (Object.keys(ledger.adopted).length > 0 || Object.keys(ledger.failures).length > 0) {
            bundle.migrations = ledger;
        }

        const safeName = (campaign.name || id).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
        const filename = `${safeName}_${new Date().toISOString().slice(0, 10)}.campaign`;
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'application/json');
        res.json(bundle);
    }));

    // Import a campaign bundle
    router.post('/api/campaigns/import', wrapAsync(async (req, res) => {
        ensureDirs();
        const bundle = req.body;
        if (bundle?.version !== 1) return res.status(400).json({ error: 'Unsupported bundle version' });

        // ID collision check — only match bare {id}.json metadata files.
        // Derived positive test (WO-P5-03 §4): replaces the hand-written
        // negative substring filter (transfer.js:150) which had drifted against
        // the campaigns.js filter. Belt-and-braces: the ID_REGEX in fileStore.js
        // forbids dots, so a suffixed file can never collide with a real id
        // anyway; this filter just keeps the candidate set clean.
        const existingIds = new Set(
            fs.readdirSync(CAMPAIGNS_DIR)
                .filter(f => isCampaignMetaFile(f))
                .map(f => f.slice(0, -5))
        );
        const originalId = bundle.campaign?.id;
        validateCampaignId(originalId);
        const newId = existingIds.has(originalId) ? uid() : originalId;
        validateCampaignId(newId);

        const campaign = { ...bundle.campaign, id: newId };

        // Write metadata
        writeJson(path.join(CAMPAIGNS_DIR, `${newId}.json`), campaign);

        // Write state
        if (bundle.state) {
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}.state.json`), bundle.state);
        }

        // Write lore
        if (bundle.lore?.length) {
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}.lore.json`), bundle.lore);
        }

        // Write npcs
        if (bundle.npcs?.length) {
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}.npcs.json`), bundle.npcs);
        }

        // Write archive index
        if (bundle.archiveIndex?.length) {
            writeJson(archiveIndexPath(newId), bundle.archiveIndex);
        }

        // Reconstruct archive.md from scenes
        if (bundle.scenes?.length) {
            fs.writeFileSync(archivePath(newId), scenesToArchiveMd(bundle.scenes), 'utf-8');
        }

        // Write chapters, facts, timeline, entities
        if (bundle.chapters?.length) writeJson(chaptersPath(newId), bundle.chapters);
        if (bundle.facts?.length) writeJson(factsPath(newId), bundle.facts);
        if (bundle.timeline?.length) writeJson(timelinePath(newId), bundle.timeline);
        if (bundle.entities?.length) writeJson(entitiesPath(newId), bundle.entities);
        if (bundle.relationshipMemoryNpcToMc?.length) writeJson(relationshipMemoryNpcToMcPath(newId), bundle.relationshipMemoryNpcToMc);
        if (bundle.relationshipMemoryNpcToNpc?.length) writeJson(relationshipMemoryNpcToNpcPath(newId), bundle.relationshipMemoryNpcToNpc);

        for (const { bundleKey, fileSuffix, recordShape } of getTransferableTables()) {
            const value = bundle[bundleKey];
            if (value === undefined) continue;
            // Phase 8.5 — and not an empty one. The import target is a brand new
            // campaign, so there is nothing an empty write could be clearing;
            // all it does is create a file whose only effect is to convince the
            // adoption path that this table is already populated. Bundles
            // carrying those empty keys already exist, so the export fix above
            // is not enough on its own.
            if (recordShape === 'array' && Array.isArray(value) && value.length === 0) continue;
            if (recordShape !== 'array' && value === null) continue;
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}${fileSuffix}`), value);
        }

        // WO-P5-05 §5 — unknown bundle keys are PRESERVED, not dropped.
        //
        // A user who exports a campaign, uninstalls a mod, reinstalls it and
        // imports must get their data back. Dropping unknown keys silently
        // destroys data on a path users treat as a backup. So: after writing
        // the known transferable tables, scan the bundle for keys that match
        // the mod-table bundle key pattern (`mod.<modId>.<name>`) but are NOT
        // in the registered set, and write them to disk using the computed
        // suffix. The suffix is derived from the key, never from the bundle.
        //
        // This is safe because:
        //   - The bundle key was produced by the export, which computed it
        //     from a registered descriptor. The key IS the descriptor name.
        //   - The suffix derivation is deterministic: `.mod-<modId>-<name>.json`.
        //   - The `mod-` prefix guarantees no collision with a built-in suffix.
        // A key that does not match the pattern is left untouched — we do not
        // invent a suffix for an unknown key shape.
        // Phase 8.5 — retired campaign files, written back under the suffix the
        // app owns for that key. This is the import half of the export above,
        // and it is what makes "exported before the extraction, imported after"
        // work: the bundle's `enemies` key becomes `<id>.enemies.json`, and the
        // first mod-table read adopts it exactly as it would for a campaign
        // that never left this machine.
        //
        // Empty values are skipped, matching the pre-8.2 importer, which wrote
        // each enemy file only `if (value.length)`. An empty legacy file would
        // adopt as an empty table and seal the ledger against a later restore.
        //
        // NOTE (`Phase 8.2` D2 item 2): the pre-8.2 importer validated all five
        // enemy files and rejected the whole bundle if any was malformed. That
        // atomicity is gone with the validators, deliberately and knowingly —
        // the mod repairs on read instead. It is on the 9.9.5 honesty list.
        for (const { bundleKey, fileSuffix, recordShape } of RETIRED_CAMPAIGN_TABLES) {
            const value = bundle[bundleKey];
            if (value === undefined || value === null) continue;
            if (recordShape === 'array' && (!Array.isArray(value) || value.length === 0)) continue;
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}${fileSuffix}`), value);
        }

        // The ledger, normalised — a bundle is untrusted input and must not be
        // able to write an arbitrary object into a file the host reads back.
        if (bundle.migrations !== undefined) {
            const ledger = normalizeLedger(bundle.migrations);
            if (Object.keys(ledger.adopted).length > 0 || Object.keys(ledger.failures).length > 0) {
                writeJson(migrationLedgerPath(newId), ledger);
            }
        }

        const knownKeys = new Set(getTransferableTables().map(t => t.bundleKey));
        for (const key of Object.keys(bundle)) {
            if (knownKeys.has(key)) continue;
            if (bundle[key] === undefined) continue;
            // Only round-trip keys that match the mod-table bundle key pattern.
            const match = /^mod\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)$/.exec(key);
            if (!match) continue;
            const [, modId, tableName] = match;
            const fileSuffix = modTableSuffix(modId, tableName);
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}${fileSuffix}`), bundle[key]);
        }

        // Background re-embedding
        setImmediate(async () => {
            let embedOk = 0;
            let embedFail = 0;
            for (const entry of bundle.archiveIndex || []) {
                try {
                    const vec = await embedText(buildArchiveText(entry));
                    storeArchiveEmbedding(newId, entry.sceneId, vec);
                    embedOk++;
                } catch (e) { console.warn('[Transfer] Archive embed failed:', entry.sceneId, e.message); embedFail++; }
            }
            for (const chunk of bundle.lore || []) {
                try {
                    const vec = await embedText(buildLoreText(chunk));
                    storeLoreEmbedding(newId, chunk.id, vec);
                    embedOk++;
                } catch (e) { console.warn('[Transfer] Lore embed failed:', chunk.id, e.message); embedFail++; }
            }
            if (embedOk || embedFail) console.log(`[Transfer] Background embed: ${embedOk} ok, ${embedFail} failed`);
        });

        res.json({ ok: true, id: newId, name: campaign.name });
    }));

    return router;
}
