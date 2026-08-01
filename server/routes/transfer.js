import fs from 'fs';
import { Router } from 'express';
import {
    CAMPAIGNS_DIR, readJson, writeJson, ensureDirs,
    archivePath, archiveIndexPath, chaptersPath, factsPath,
    entitiesPath, timelinePath, validateCampaignId,
} from '../lib/fileStore.js';
import { isCampaignMetaFile, getTransferableTables } from '../lib/tableRegistry.js';
import { modTableSuffix, modTableName } from '../lib/modTableRegistry.js';
import { embedText, buildArchiveText, buildLoreText } from '../lib/embedder.js';
import { storeArchiveEmbedding, storeLoreEmbedding } from '../lib/vectorStore.js';
import { wrapAsync } from '../lib/asyncHandler.js';
import path from 'path';
import {
    validateEnemyCompendium,
    validateEnemyInstances,
    validateEnemyEncounters,
    validateEnemyResolutions,
    validateEnemyCombatConfig,
} from '../lib/enemySchema.js';

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
        const enemies = readJson(path.join(CAMPAIGNS_DIR, `${id}.enemies.json`), []);
        const enemyInstances = readJson(path.join(CAMPAIGNS_DIR, `${id}.enemy-instances.json`), []);
        const enemyEncounters = readJson(path.join(CAMPAIGNS_DIR, `${id}.enemy-encounters.json`), []);
        const enemyResolutions = readJson(path.join(CAMPAIGNS_DIR, `${id}.enemy-resolutions.json`), []);
        const enemyCombatConfig = readJson(path.join(CAMPAIGNS_DIR, `${id}.enemy-combat.json`), null);
        const archiveIndex = readJson(archiveIndexPath(id), []);
        const chapters = readJson(chaptersPath(id), []);
        const facts = readJson(factsPath(id), []);
        const timeline = readJson(timelinePath(id), []);
        const entities = readJson(entitiesPath(id), []);

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
            enemies,
            enemyInstances,
            enemyEncounters,
            enemyResolutions,
            enemyCombatConfig,
            scenes,
            archiveIndex,
            chapters,
            facts,
            timeline,
            entities,
        };

        for (const { bundleKey, fileSuffix, recordShape } of getTransferableTables()) {
            bundle[bundleKey] = readJson(
                path.join(CAMPAIGNS_DIR, `${id}${fileSuffix}`),
                recordShape === 'array' ? [] : null,
            );
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

        // Validate ALL enemy data BEFORE writing any files. A malformed bundle
        // is rejected with a useful 400 response so a partial import cannot leave
        // crash-prone enemy files on disk while other ledgers are already written.
        const enemyChecks = [
            validateEnemyCompendium(bundle.enemies),
            validateEnemyInstances(bundle.enemyInstances),
            validateEnemyEncounters(bundle.enemyEncounters),
            validateEnemyResolutions(bundle.enemyResolutions),
            validateEnemyCombatConfig(bundle.enemyCombatConfig),
        ];
        const enemyErrors = enemyChecks.flatMap(check => check.errors);
        if (enemyErrors.length) {
            return res.status(400).json({
                error: 'Malformed enemy data in campaign bundle',
                details: enemyErrors,
            });
        }
        const [validEnemies, validEnemyInstances, validEnemyEncounters, validEnemyResolutions, validEnemyCombatConfig] = enemyChecks;

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

        if (validEnemies.value?.length) {
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}.enemies.json`), validEnemies.value);
        }

        if (validEnemyInstances.value?.length) {
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}.enemy-instances.json`), validEnemyInstances.value);
        }

        if (validEnemyEncounters.value?.length) {
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}.enemy-encounters.json`), validEnemyEncounters.value);
        }

        if (validEnemyResolutions.value?.length) {
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}.enemy-resolutions.json`), validEnemyResolutions.value);
        }

        if (validEnemyCombatConfig.value) {
            writeJson(path.join(CAMPAIGNS_DIR, `${newId}.enemy-combat.json`), validEnemyCombatConfig.value);
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

        for (const { bundleKey, fileSuffix } of getTransferableTables()) {
            if (bundle[bundleKey] !== undefined) {
                writeJson(path.join(CAMPAIGNS_DIR, `${newId}${fileSuffix}`), bundle[bundleKey]);
            }
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
