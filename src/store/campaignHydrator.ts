import { useAppStore } from './useAppStore';
import {
    loadCampaignState, getLoreChunks, getNPCLedger, getEnemyCompendium, getEnemyInstances, getEnemyEncounters, getEnemyResolutions, getEnemyCombatConfig,
    loadArchiveIndex, loadTimeline, loadChapters, loadEntities,
    loadDivergenceRegister, saveDivergenceRegister, saveChapters,
    saveNPCLedger, saveCampaignState,
} from './campaignStore';
import { DEFAULT_CONTEXT, DEFAULT_CONDENSER } from '../services/campaignInit';
import { migrateLegacyContext } from '../types';
import type { GameContext, ArchiveChapter, ArchiveIndexEntry, DivergenceRegister, DivergenceEntry, ChatMessage } from '../types';
import { migrateV1ToV2 } from '../services/campaign-state/divergenceRegister';
import { migratePCIntoContext } from '../services/character/migratePC';
import { normalizeEnemyCombatConfig, normalizeEnemyInstance } from '../services/enemy/enemyCombat';
import { normalizeEnemyEntries } from '../services/enemy/enemySchema';
import { normalizeEnemyEncounters } from '../services/enemy/enemyEncounter';
import { normalizeEnemyResolutions } from '../services/enemy/enemyResolution';
import { loadLocationTable } from '../services/tables/locationTable';
import { hydrateModTables, saveModTable } from '../services/mods/modTables';
import { fetchMods } from '../services/mods/modClient';
import { safeSceneNum } from '../utils/helpers';
import type { ArcRecord } from '../types/arc';

/**
 * WO-P5-12 §7 Step 1 — migrate Arc's state from `context.arcs` to the
 * `mod.arc.arcs` mod-declared table.
 *
 * Existing campaigns have `context.arcs` populated (it lived on `GameContext`,
 * `gamecontext.ts:209`). The Arc mod (`mods/arc.mod.json`) declares an `arcs`
 * table; this migration MOVES the records into that table on hydrate, so a
 * user's live arcs do not vanish. Data loss is a STOP condition (WO-P5-12 §8),
 * so this migration is conservative in three ways:
 *
 *   1. It only fires when the arc mod is INSTALLED — i.e. when
 *      `modTables['mod.arc.arcs']` is present in the hydrated map. If the mod
 *      is absent, `context.arcs` is left untouched (no migration, no loss).
 *   2. It only fires when `context.arcs` is non-empty AND the mod table is
 *      empty (or `[]`). If the mod table already has arcs (e.g. a re-hydrate
 *      after a prior migration), `context.arcs` is left untouched.
 *   3. It persists the mod table (fire-and-forget) AND persists the cleared
 *      campaign state, so neither half of the migration is lost on reload.
 *      A failure to persist the mod table logs but does NOT clear
 *      `context.arcs` — a half-written migration would lose arcs.
 *
 * Returns the (possibly migrated) `modTables` and `finalContext` so the caller
 * can spread them into `useAppStore.setState`.
 */
async function migrateArcsToModTable(
    campaignId: string,
    finalContext: GameContext,
    modTables: Record<string, unknown>,
): Promise<{ context: GameContext; modTables: Record<string, unknown>; migrated: boolean }> {
    const ARC_TABLE_KEY = 'mod.arc.arcs';
    if (!(ARC_TABLE_KEY in modTables)) {
        // Arc mod not installed — leave context.arcs untouched.
        return { context: finalContext, modTables, migrated: false };
    }
    const legacyArcs = (finalContext as GameContext & { arcs?: ArcRecord[] }).arcs;
    if (!legacyArcs || legacyArcs.length === 0) {
        // No arcs to migrate — leave context.arcs untouched.
        return { context: finalContext, modTables, migrated: false };
    }
    const existing = modTables[ARC_TABLE_KEY];
    if (Array.isArray(existing) && existing.length > 0) {
        // Mod table already populated — do not clobber it; leave context.arcs
        // untouched (the user may have re-installed after a prior migration).
        return { context: finalContext, modTables, migrated: false };
    }

    // Persist the arcs into the mod table FIRST. Only if this succeeds do we
    // clear context.arcs — a half-written migration would lose arcs (§8 STOP).
    try {
        await saveModTable(campaignId, { name: 'arcs', recordShape: 'array' }, 'arc', legacyArcs);
    } catch (e) {
        console.warn('[Hydrator] Arc migration: failed to write mod.arc.arcs; leaving context.arcs intact:', e);
        return { context: finalContext, modTables, migrated: false };
    }

    console.log(`[Hydrator] Arc migration: moved ${legacyArcs.length} arc(s) from context.arcs → mod.arc.arcs`);
    const migratedContext: GameContext = { ...finalContext, arcs: undefined } as GameContext;
    delete (migratedContext as Record<string, unknown>).arcs;
    const migratedModTables: Record<string, unknown> = { ...modTables, [ARC_TABLE_KEY]: legacyArcs };
    return { context: migratedContext, modTables: migratedModTables, migrated: true };
}

/**
 * WO-P5-05 — fetch the installed mods and hydrate their declared tables.
 *
 * This is a separate helper so it can sit inside the hydrator's `Promise.all`
 * fan-out without blocking the other 14 loads. It first fetches the mod list
 * (to know which tables are declared), then fetches each table's data in
 * parallel. NEVER THROWS: a fetch failure yields `{}` (no mod tables), so a
 * mods endpoint that is down cannot break campaign hydration. With no mods
 * installed this resolves to `{}` — byte-identical to the prior behaviour.
 */
async function hydrateModTablesFromServer(campaignId: string): Promise<Record<string, unknown>> {
    try {
        const { mods } = await fetchMods();
        return await hydrateModTables(campaignId, mods);
    } catch {
        // Mods endpoint unreachable or malformed — no mod tables. The app
        // continues; the Extensions screen will show the fault on next refresh.
        return {};
    }
}

function backfillSceneIds(chapters: ArchiveChapter[]): { chapters: ArchiveChapter[]; changed: boolean } {
    let changed = false;
    const updated = chapters.map(ch => {
        if (ch.sceneIds && ch.sceneIds.length > 0) return ch;
        const startNum = parseInt(ch.sceneRange[0], 10);
        const endNum = parseInt(ch.sceneRange[1], 10);
        const ids = Array.from({ length: endNum - startNum + 1 }, (_, i) =>
            String(startNum + i).padStart(3, '0')
        );
        changed = true;
        return { ...ch, sceneIds: ids };
    });
    return { chapters: updated, changed };
}

/**
 * Swipe Generation v1 bug recovery — strip orphaned swipe-set state from
 * non-assistant messages. A pre-fix bug stamped `swipeSet` / `pendingCommit`
 * / `swipeActiveIndex` on the literal last message in the array (`updateLastMessage`),
 * which after a tool call was the `tool` message — NOT the assistant. Those
 * orphaned fields on tool messages broke `findPendingCommitMessage` (it only
 * returns assistants with `pendingCommit=true`), so `commitPendingTurn`
 * silently no-op'd and the post-turn pipeline (archive append, sceneId stamp,
 * timeline, NPC bookkeeping, witness capture) never ran for the affected turn.
 *
 * This one-pass migration cleans up the orphans already on disk. Idempotent
 * — no-op on healthy campaigns. Returns the cleaned messages and a flag.
 * Exported for direct unit testing.
 */
export function stripOrphanedSwipeState(messages: ChatMessage[]): { messages: ChatMessage[]; changed: boolean } {
    let changed = false;
    const cleaned = messages.map(m => {
        if (m.role === 'assistant') return m;
        const hasOrphan = m.pendingCommit === true || m.swipeSet !== undefined || m.swipeActiveIndex !== undefined;
        if (!hasOrphan) return m;
        changed = true;
        // Strip the orphaned swipe-set state. These fields never belonged on
        // a non-assistant message — they were stamped here by the pre-fix
        // `updateLastMessage` bug. Drop them in place without mutating.
        const rest = { ...m };
        delete rest.pendingCommit;
        delete rest.swipeSet;
        delete rest.swipeActiveIndex;
        return rest as ChatMessage;
    });
    return { messages: cleaned, changed };
}

/** Compare on a normalized prefix — `userSnippet` is only the first 120 raw chars. */
const SNIPPET_MATCH_CHARS = 80;
const normalizeForMatch = (s: string): string =>
    (s || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, SNIPPET_MATCH_CHARS);

/**
 * Scene-stamp recovery.
 *
 * `appendScene` writes the prose to `.archive.md` synchronously, before it can
 * await anything — so a scene is durable the moment the request lands. The
 * client learns the assigned sceneId only from that request's RESPONSE, and
 * `api.archive.append` swallows any failure and returns undefined. When the
 * response never arrives (app closing, blip, server restart mid-response) the
 * post-turn pipeline returns early without stamping, and the scene sits on disk
 * with no message pointing at it. That is not preventable client-side: you
 * cannot guarantee a response arrives for a write that already committed.
 *
 * The link is unrecorded, not lost — the index carries `userSnippet`, a prefix
 * of the turn's user text — so the pairing is recomputable from data already in
 * memory. No fetch, no server round-trip.
 *
 * CONSERVATIVE BY CONTRACT. A missing stamp is a leak: surgical delete skips the
 * archive and the scene can be re-linked later. A WRONG stamp points a
 * destructive delete at the wrong scene — dropping its prose, deleting its
 * vector, and invalidating the wrong chapter — which nothing detects and nothing
 * undoes. So this stamps only on a UNIQUE match under a monotonic cursor, and
 * leaves the field blank on any ambiguity. Blank is the existing behaviour, so
 * the worst case of this pass is that it changes nothing.
 *
 * Deliberately stamps the assistant message only. Delete and edit-sync read the
 * assistant's stamp; putting one on the user message too would make deleting a
 * user bubble start destroying scenes, which is a behaviour change and not part
 * of a recovery pass.
 *
 * Idempotent — a no-op on healthy campaigns. Exported for direct unit testing.
 */
export function rebuildSceneStamps(
    messages: ChatMessage[],
    archiveIndex: ArchiveIndexEntry[],
): { messages: ChatMessage[]; changed: number } {
    if (archiveIndex.length === 0 || messages.length === 0) return { messages, changed: 0 };

    const ordered = [...archiveIndex].sort((a, b) => safeSceneNum(a.sceneId) - safeSceneNum(b.sceneId));
    const stampedAt = new Map<string, number>();
    messages.forEach((m, i) => { if (m.sceneId) stampedAt.set(m.sceneId, i); });
    if (ordered.every(e => stampedAt.has(e.sceneId))) return { messages, changed: 0 };

    const out = [...messages];
    let changed = 0;

    for (let k = 0; k < ordered.length; k++) {
        const entry = ordered[k];
        if (stampedAt.has(entry.sceneId)) continue;
        const key = normalizeForMatch(entry.userSnippet);
        if (!key) continue;

        // Search only between the nearest KNOWN scenes on either side. A scene
        // numbered between two located scenes must have happened between their
        // turns — that is forced by scene ordering, not inferred from it. An
        // open-ended cursor would instead let a match drift arbitrarily far,
        // which is how a plausible-looking wrong stamp gets made.
        let lo = -1;
        for (let j = k - 1; j >= 0; j--) {
            const at = stampedAt.get(ordered[j].sceneId);
            if (at !== undefined) { lo = at; break; }
        }
        let hi = out.length;
        for (let j = k + 1; j < ordered.length; j++) {
            const at = stampedAt.get(ordered[j].sceneId);
            if (at === undefined) continue;
            // Bound at the START of that scene's turn (its user message), not at
            // its GM reply — otherwise the anchor's own user message falls inside
            // the window and looks like a rival candidate.
            let start = at;
            for (let i = at - 1; i >= 0; i--) {
                if (out[i].role === 'user') { start = i; break; }
                if (out[i].role === 'assistant') break;
            }
            hi = start;
            break;
        }

        const candidates: number[] = [];
        for (let i = lo + 1; i < hi; i++) {
            if (out[i].role !== 'user') continue;
            if (normalizeForMatch(out[i].displayContent || out[i].content) === key) candidates.push(i);
        }
        // 0 = the turn is gone; >1 = repeated input with nothing to separate them.
        // Both leave the field blank. Recovering fewer scenes costs a re-link
        // later; stamping the wrong one costs the wrong scene on the next delete.
        if (candidates.length !== 1) continue;

        // The GM reply for that turn: the next assistant before any later user message.
        const userIdx = candidates[0];
        let gmIdx = -1;
        for (let i = userIdx + 1; i < hi; i++) {
            if (out[i].role === 'user') break;
            if (out[i].role === 'assistant') { gmIdx = i; break; }
        }
        if (gmIdx === -1 || out[gmIdx].sceneId) continue;

        out[gmIdx] = { ...out[gmIdx], sceneId: entry.sceneId };
        stampedAt.set(entry.sceneId, gmIdx);   // now anchors the scenes after it
        changed++;
    }

    return changed > 0 ? { messages: out, changed } : { messages, changed: 0 };
}

export async function hydrateCampaign(campaignId: string) {
    const [state, chunks, npcs, enemies, enemyInstances, enemyEncounters, enemyResolutions, enemyCombatConfig, locations, archiveIndex, timeline, chapters, entities, divReg, modTables] = await Promise.all([
        loadCampaignState(campaignId),
        getLoreChunks(campaignId),
        getNPCLedger(campaignId),
        getEnemyCompendium(campaignId),
        getEnemyInstances(campaignId),
        getEnemyEncounters(campaignId),
        getEnemyResolutions(campaignId),
        getEnemyCombatConfig(campaignId),
        loadLocationTable(campaignId),
        loadArchiveIndex(campaignId),
        loadTimeline(campaignId),
        loadChapters(campaignId),
        loadEntities(campaignId),
        loadDivergenceRegister(campaignId),
        // WO-P5-05: hydrate declared mod tables in parallel. Fetches the mod
        // list first (to know which tables are declared), then fetches each
        // table's data. NEVER THROWS — a failed fetch yields the default, so
        // a single bad mod table cannot break campaign hydration. With no
        // mods installed this resolves to {} (empty map), byte-identical to
        // the prior behaviour (the field was absent before; now it is `{}`).
        hydrateModTablesFromServer(campaignId),
    ]);

    const rawContext: GameContext = { ...DEFAULT_CONTEXT, ...(state?.context ?? {}) } as GameContext;
    const migratedContext = migrateLegacyContext(rawContext);

    // v1→v2 divergence register migration: wipe-and-restart
    let register: DivergenceRegister;
    if (!divReg || !divReg.version || divReg.version < 2) {
        register = migrateV1ToV2(divReg ?? { entries: [] as DivergenceEntry[], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 1 });
        saveDivergenceRegister(campaignId, register).catch(e =>
            console.warn('[Hydrator] Failed to save migrated divergence register:', e)
        );
    } else {
        register = divReg;
    }

    // Backfill sceneIds on chapters missing the field
    const { chapters: backfilled, changed: sceneIdsChanged } = backfillSceneIds(chapters ?? []);
    if (sceneIdsChanged) {
        console.log('[Hydrator] Backfilled sceneIds on chapters');
        try { await saveChapters(campaignId, backfilled); } catch (e) {
            console.warn('[Hydrator] Failed to save backfilled chapters:', e);
        }
    }

    // WO-A rewrite 2 §2: one-time migration of legacy `isPC` row from npcLedger
    // into `context.playerCharacter`. Idempotent — no-op on already-migrated
    // campaigns. If migration strips a row, persist the trimmed ledger back to
    // disk so the legacy row doesn't复活 on next hydrate.
    const pcMigration = migratePCIntoContext(migratedContext, npcs ?? []);
    let finalContext = pcMigration.context;
    const finalNpcLedger = pcMigration.npcLedger;
    if (pcMigration.migrated) {
        console.log('[Hydrator] Migrated legacy isPC row from npcLedger into context.playerCharacter');
        try { await saveNPCLedger(campaignId, finalNpcLedger); } catch (e) {
            console.warn('[Hydrator] Failed to persist trimmed npcLedger after PC migration:', e);
        }
    }

    // One-time save back if legacy inventory items were normalized during migration
    const inventoryMigrated = JSON.stringify(rawContext.inventoryItems ?? []) !== JSON.stringify(finalContext.inventoryItems ?? []);
    if (inventoryMigrated) {
        console.log('[Hydrator] Persisting normalized inventory item location tags');
    }

    // Swipe Generation v1 bug recovery — strip orphaned swipeSet / pendingCommit
    // / swipeActiveIndex from non-assistant messages left by a pre-fix bug. See
    // `stripOrphanedSwipeState` doc for the full mechanism.
    const rawMessages = state?.messages ?? [];
    const { messages: cleanedMessages, changed: swipeOrphansChanged } = stripOrphanedSwipeState(rawMessages);

    // Scene-stamp recovery — re-link archived scenes whose sceneId never reached
    // the client because the append response was lost. See `rebuildSceneStamps`.
    const { messages: finalMessages, changed: stampsRecovered } = rebuildSceneStamps(cleanedMessages, archiveIndex ?? []);
    if (stampsRecovered > 0) {
        console.log(`[Hydrator] Recovered ${stampsRecovered} scene stamp(s) from the archive index`);
    }

    if (swipeOrphansChanged || inventoryMigrated || stampsRecovered > 0) {
        console.log('[Hydrator] Persisting updated context/messages after hydration migration');
        try { await saveCampaignState(campaignId, { context: finalContext, messages: finalMessages, condenser: state?.condenser ?? DEFAULT_CONDENSER, pinnedExcerpts: state?.pinnedExcerpts ?? [] }); } catch (e) {
            console.warn('[Hydrator] Failed to persist state after hydration migration:', e);
        }
    }

    // WO-P5-12 §7 Step 1 — migrate Arc's state from `context.arcs` to the
    // `mod.arc.arcs` mod-declared table. Conservative: only fires when the arc
    // mod is installed and context.arcs is non-empty and the mod table is empty.
    // The migration persists the mod table FIRST and only clears context.arcs on
    // success — a half-written migration would lose arcs (§8 STOP condition).
    let hydratedModTables = modTables ?? {};
    try {
        const arcMigration = await migrateArcsToModTable(campaignId, finalContext, hydratedModTables);
        finalContext = arcMigration.context;
        hydratedModTables = arcMigration.modTables;
        if (arcMigration.migrated) {
            // Persist the cleared campaign state so context.arcs does not复活 on next hydrate.
            try { await saveCampaignState(campaignId, { context: finalContext, messages: finalMessages, condenser: state?.condenser ?? DEFAULT_CONDENSER, pinnedExcerpts: state?.pinnedExcerpts ?? [] }); } catch (e) {
                console.warn('[Hydrator] Failed to persist state after Arc migration:', e);
            }
        }
    } catch (e) {
        console.warn('[Hydrator] Arc migration failed (non-fatal); context.arcs left intact:', e);
    }

    useAppStore.setState({
        context: finalContext,
        messages: finalMessages,
        condenser: { ...(state?.condenser ?? DEFAULT_CONDENSER) },
        loreChunks: chunks,
        npcLedger: finalNpcLedger,
        enemyCompendium: normalizeEnemyEntries(enemies).entries,
        enemySuggestions: [],
        enemyInstances: (enemyInstances ?? []).map(normalizeEnemyInstance),
        enemyEncounters: normalizeEnemyEncounters(enemyEncounters),
        enemyResolutions: normalizeEnemyResolutions(enemyResolutions),
        enemyCombatConfig: normalizeEnemyCombatConfig(enemyCombatConfig),
        locationLedger: locations ?? [],
        archiveIndex: archiveIndex ?? [],
        timeline: timeline ?? [],
        chapters: backfilled,
        entities: entities ?? [],
        divergenceRegister: register,
        activeCampaignId: campaignId,
        inventoryItems: finalContext.inventoryItems,
        characterProfileData: finalContext.characterProfileData,
        playerCharacter: finalContext.playerCharacter ?? null,
        pinnedExcerpts: state?.pinnedExcerpts ?? [],
        modTables: hydratedModTables,
    });
}
