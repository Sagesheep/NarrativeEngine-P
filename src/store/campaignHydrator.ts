import { useAppStore } from './useAppStore';
import {
    loadCampaignState, getLoreChunks, getNPCLedger, getEnemyCompendium, getEnemyInstances, getEnemyEncounters, getEnemyResolutions, getEnemyCombatConfig, getLocationLedger,
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
import { safeSceneNum } from '../utils/helpers';

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
    const [state, chunks, npcs, enemies, enemyInstances, enemyEncounters, enemyResolutions, enemyCombatConfig, locations, archiveIndex, timeline, chapters, entities, divReg] = await Promise.all([
        loadCampaignState(campaignId),
        getLoreChunks(campaignId),
        getNPCLedger(campaignId),
        getEnemyCompendium(campaignId),
        getEnemyInstances(campaignId),
        getEnemyEncounters(campaignId),
        getEnemyResolutions(campaignId),
        getEnemyCombatConfig(campaignId),
        getLocationLedger(campaignId),
        loadArchiveIndex(campaignId),
        loadTimeline(campaignId),
        loadChapters(campaignId),
        loadEntities(campaignId),
        loadDivergenceRegister(campaignId),
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
    const finalContext = pcMigration.context;
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
    });
}
