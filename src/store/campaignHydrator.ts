import { useAppStore } from './useAppStore';
import {
    loadCampaignState, getLoreChunks, getNPCLedger, getEnemyCompendium, getEnemyInstances, getEnemyEncounters, getEnemyCombatConfig, getLocationLedger,
    loadArchiveIndex, loadTimeline, loadChapters, loadEntities,
    loadDivergenceRegister, saveDivergenceRegister, saveChapters,
    saveNPCLedger, saveCampaignState,
} from './campaignStore';
import { DEFAULT_CONTEXT, DEFAULT_CONDENSER } from '../services/campaignInit';
import { migrateLegacyContext } from '../types';
import type { GameContext, ArchiveChapter, DivergenceRegister, DivergenceEntry, ChatMessage } from '../types';
import { migrateV1ToV2 } from '../services/campaign-state/divergenceRegister';
import { migratePCIntoContext } from '../services/character/migratePC';
import { normalizeEnemyCombatConfig, normalizeEnemyInstance } from '../services/enemy/enemyCombat';

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

export async function hydrateCampaign(campaignId: string) {
    const [state, chunks, npcs, enemies, enemyInstances, enemyEncounters, enemyCombatConfig, locations, archiveIndex, timeline, chapters, entities, divReg] = await Promise.all([
        loadCampaignState(campaignId),
        getLoreChunks(campaignId),
        getNPCLedger(campaignId),
        getEnemyCompendium(campaignId),
        getEnemyInstances(campaignId),
        getEnemyEncounters(campaignId),
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
    if (swipeOrphansChanged || inventoryMigrated) {
        console.log('[Hydrator] Persisting updated context/messages after hydration migration');
        try { await saveCampaignState(campaignId, { context: finalContext, messages: cleanedMessages, condenser: state?.condenser ?? DEFAULT_CONDENSER, pinnedExcerpts: state?.pinnedExcerpts ?? [] }); } catch (e) {
            console.warn('[Hydrator] Failed to persist state after hydration migration:', e);
        }
    }

    useAppStore.setState({
        context: finalContext,
        messages: cleanedMessages,
        condenser: { ...(state?.condenser ?? DEFAULT_CONDENSER) },
        loreChunks: chunks,
        npcLedger: finalNpcLedger,
        enemyCompendium: enemies ?? [],
        enemyInstances: (enemyInstances ?? []).map(normalizeEnemyInstance),
        enemyEncounters: enemyEncounters ?? [],
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
