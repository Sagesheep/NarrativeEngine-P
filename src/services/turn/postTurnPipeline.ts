import type { ChatMessage, EndpointConfig, ProviderConfig } from '../../types';
import type { TurnState, TurnCallbacks } from './turnOrchestrator';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../llm/apiClient';
import { rateImportance } from '../archive-memory/importanceRater';
import { sealChapterCombined, type SealModelCall } from '../saveFileEngine';
import { toast } from '../../components/Toast';
import { mergeLifecycleEntries } from '../campaign-state/divergenceRegister';
import { saveDivergenceRegister } from '../../store/campaignStore';
import { tierAllows } from './aiTier';
import { startPostTurnTracks } from './tracks';
import { startPostCommitTracks } from './tracks/postCommit';
import { startPrologueTracks } from './tracks/prologue';
import { startSequentialTracks } from './tracks/sequential';
import type { PostCommitTrackContext, PostTurnTrackContext } from './tracks/types';
import { buildHostFacade, hasHostModelRole, type HostFacade } from './hostFacade';
import { emitCoreEventLazy } from '../mods/events';

// WO-P2-03: the enemy-discovery single-flight map moved to `tracks/enemySuggestionTrack.ts`
// along with the track body. Re-exported here so the campaign-switch caller
// (`campaignSlice.ts:569`, a dynamic `import('.../turn/postTurnPipeline')`) keeps working
// against the same module instance and the same map.
export { clearEnemyDiscoveryState } from './tracks/enemySuggestionTrack';

// ── Durable-commit v1: "did this turn already land?" ───────────────────────
// `appendScene` writes the prose to `.archive.md` synchronously, before it can
// await anything, and `api.archive.append` returns undefined for BOTH a rejected
// request (nothing written) and a lost response (written, id unknown). Retrying
// blindly would duplicate the scene. The index carries `userSnippet` — the first
// 120 raw chars of the turn's user half — so the pairing is recomputable. Same
// normalized-prefix contract as the hydrator's `rebuildSceneStamps`, and equally
// conservative: no user text, no unique match, or an unreachable index all mean
// "not archived", which is the safe answer (a missing scene is repairable; a
// duplicate is not).
const SNIPPET_MATCH_CHARS = 80;
const normalizeSnippet = (s: string): string =>
    (s || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, SNIPPET_MATCH_CHARS);

async function findArchivedSceneIdForTurn(
    campaignId: string,
    userText: string,
): Promise<string | undefined> {
    const want = normalizeSnippet(userText);
    if (!want) return undefined;
    try {
        const index = await api.archive.getIndex(campaignId);
        // Only the tail can be ours — the append, if it happened, is the newest entry.
        const from = Math.max(0, index.length - 3);
        const hits = index.slice(from).filter(e => normalizeSnippet(e.userSnippet ?? '') === want);
        return hits.length === 1 ? hits[0].sceneId : undefined;
    } catch (err) {
        console.warn('[PostTurn] Archive verification lookup failed:', err);
        return undefined;
    }
}

/**
 * Campaign-id guard factory for background-task callbacks. Mirrors the
 * established `guardedUpdateNPC` pattern (L478-485): reads the live
 * `activeCampaignId` from the store and drops the call if the user has
 * switched campaigns while the background task was in flight. The guard
 * only suppresses stale writes — same-campaign calls pass through
 * untouched, so synchronous UI handlers (which call the store directly,
 * not via these wrappers) are unaffected.
 *
 * Used to close the race where a background scan (Profile/Trait/Inventory,
 * Event-Extraction, Chapter-AutoSeal, Timeskip-Narration) completes after
 * a campaign switch and would otherwise contaminate the new campaign's
 * context via `callbacks.updateContext` (campaignSlice.ts:512 has no
 * campaign-id check and merges the patch into whatever `s.context` is
 * currently active).
 */
function makeGuarded<T extends (...args: any[]) => void>(
    fn: T,
    activeCampaignId: string,
    label: string,
): T {
    return ((...args: Parameters<T>) => {
        const currentId = useAppStore.getState().activeCampaignId;
        if (currentId !== activeCampaignId) {
            console.warn(`[PostTurn] Dropping ${label} — campaign switched (${activeCampaignId} → ${currentId})`);
            return;
        }
        return fn(...args);
    }) as T;
}



export async function runPostTurnPipeline(
    state: TurnState,
    callbacks: TurnCallbacks,
    lastAssistantContent: string,
    allMsgs: ChatMessage[],
    // WO-P1-03: optional TurnContext bus, carried across the commit boundary
    // by the PendingTurnSnapshot. Thread-only — the pipeline does NOT yet read
    // this (the existing reads stay, preserving byte-identical behaviour).
    // Project 4's memory port will swap selected reads to bus fields. Keeping
    // the param optional so callers that don't have a bus (e.g. launch
    // reconciliation's rebuildStateFromLiveStore path) still work.
    turnContext?: import('./turnContext').TurnContext,
    // Durable-commit v1: set when a previous commit attempt for THIS turn failed
    // to archive. Makes the archive track check the index before appending, so a
    // retry after a lost response re-links the existing scene instead of writing
    // a second copy of it.
    options?: { verifyExistingScene?: boolean },
): Promise<{ archived: boolean }> {
    // WO-P1-03: thread-only seam. Acknowledge the param is intentionally
    // threaded but not yet consumed — Project 4 will read bus fields here.
    // The void reference keeps lint happy without changing behaviour.
    void turnContext;
    const activeCampaignId = state.activeCampaignId!;
    const { displayInput, npcLedger } = state;

    startPrologueTracks({ state, callbacks, npcLedger });

    // WO-P2-03: the optional post-turn scans are registered tracks now (see
    // `tracks/index.ts`). `startPostTurnTracks` does not await — it starts the enabled
    // tracks in registration order and returns their in-flight promises, so spreading
    // them here reproduces the original array literal exactly: same start order, same
    // single `allSettled`, same containment, archive still at index 0.
    const facade = buildHostFacade(state, callbacks, {
        updatePlayerCharacter: (patch) => useAppStore.getState().updatePlayerCharacter(patch),
        reactiveStore: useAppStore,
    });
    const trackCtx: PostTurnTrackContext = {
        facade,
        displayInput,
        lastAssistantContent,
        allMsgs,
        npcLedger,
        activeCampaignId,
    };

    const results = await Promise.allSettled([
        runArchiveTrack(state, callbacks, displayInput, lastAssistantContent, allMsgs, activeCampaignId, options?.verifyExistingScene === true, facade),
        ...startPostTurnTracks(trackCtx, state.settings),
    ]);

    // Durable-commit v1: the archive track's verdict is the one the caller acts on.
    // A rejected track (thrown) counts as not-archived — the conservative answer.
    const archiveResult = results[0];
    const archived = archiveResult.status === 'fulfilled' && archiveResult.value === true;

    const sequentialTrackPromises = startSequentialTracks({
        state,
        facade,
        callbacks,
        lastAssistantContent,
        onStageIds: [],
        npcLedger,
        settings: state.settings,
        activeCampaignId,
    });

    for (const r of results) {
        if (r.status === 'rejected') {
            console.warn('[PostTurn] Track failed:', r.reason);
        }
    }

    await Promise.allSettled(sequentialTrackPromises);

    // ── Arc Engine Tick ──
    // Arc tick has no in-tree track; it is registered dynamically (see tracks/index.ts:29-34).

    return { archived };
}


/** Returns true when the turn is in long-term memory (freshly appended, or already
 *  there from a previous attempt whose response was lost). False means the scene did
 *  NOT land — the caller must keep the turn armed rather than clearing its markers. */
async function runArchiveTrack(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    lastAssistantContent: string,
    allMsgs: ChatMessage[],
    activeCampaignId: string,
    verifyExistingScene = false,
    facade?: HostFacade,
): Promise<boolean> {
    // Durable-commit v1: a retry after a failed commit looks for the scene before
    // writing one, so a lost-response failure re-links instead of duplicating.
    let appendedSceneId: string | undefined;
    // Phase 3.2 / `EVENTS.md` §6.5 — on the re-link path the message was stamped
    // by an earlier attempt, so `archive.sceneAppended` carries `messageId: null`
    // rather than naming a bubble this run did not touch.
    let reLinked = false;
    if (verifyExistingScene) {
        appendedSceneId = await findArchivedSceneIdForTurn(activeCampaignId, displayInput);
        if (appendedSceneId) {
            reLinked = true;
            console.log(`[PostTurn] Turn was already archived as scene #${appendedSceneId} — re-linking, not re-appending`);
        }
    }

    if (!appendedSceneId) {
        let sceneImportance: number | undefined;
        const importanceProvider = facade ? undefined : state.getFreshProvider();
        const importanceAvailable = facade ? hasHostModelRole(facade, 'story') : Boolean(importanceProvider);
        if (importanceAvailable && tierAllows(facade?.config.aiTier ?? state.settings.aiTier, 'importanceRating')) {
            try {
                sceneImportance = await rateImportance(importanceProvider, displayInput, lastAssistantContent, allMsgs, facade ? (request: import('./hostFacade').ModelRequest) => facade.model.call('story', request) : undefined);
                console.log(`[ImportanceRater] Scene rated: ${sceneImportance}/5`);
            } catch (err) {
                console.warn('[ImportanceRater] Failed (non-fatal):', err);
            }
        }

        const appendData = await api.archive.append(activeCampaignId, displayInput, lastAssistantContent, sceneImportance);
        appendedSceneId = appendData?.sceneId;
        if (!appendedSceneId) {
            // The prose write lands synchronously server-side, so "no data" may still
            // mean "written, response lost". Check before reporting failure.
            appendedSceneId = await findArchivedSceneIdForTurn(activeCampaignId, displayInput);
            if (!appendedSceneId) {
                console.warn('[PostTurn] Archive append failed — turn stays armed for retry');
                toast.error('Scene not saved to long-term memory. Your text is safe — this turn will retry.');
                return false;
            }
            console.log(`[PostTurn] Append response was lost but scene #${appendedSceneId} is on disk — recovered`);
        }
    }

    // WO-F (2be3ad5) — stamp the archived sceneId onto the last assistant message so the
    // surgical-delete + edit-sync UI hooks can map an on-screen GM reply back to its
    // long-term-memory scene. (Mirrors mobile's scene-marker system message, via a direct
    // field instead since main has no scene-marker message stream.)
    //
    // Use `updateLastAssistantMessage` (scans back to the last assistant), NOT
    // `updateLastMessage` (literal last message). After a tool call, the literal
    // last message is the tool message — desktop reuses the same assistant id
    // across tool iterations instead of pushing a fresh bubble per call like
    // mobile does, so `updateLastMessage` would stamp sceneId on the tool
    // message and the assistant would never receive its archive-anchor sceneId.
    if (appendedSceneId) {
        callbacks.updateLastAssistantMessage?.({ sceneId: appendedSceneId });
    }

    const [freshIndex, freshTimeline, freshChapters] = await Promise.all([
        api.archive.getIndex(activeCampaignId),
        api.timeline.get(activeCampaignId),
        api.chapters.list(activeCampaignId),
    ]);
    callbacks.setArchiveIndex(freshIndex);
    callbacks.setTimeline?.(freshTimeline);
    state.setChapters(freshChapters);
    console.log(`[Archive] Scene #${appendedSceneId} committed`);

    // Phase 3.2 / `EVENTS.md` §4.3 + §6.5 — the one emit inside the durable
    // commit path, and placement is what makes it safe. The append has returned
    // a sceneId, the sceneId is stamped on the message, and the fresh index,
    // timeline and chapters have landed in the store, so a listener reading
    // `ctx.data.archiveIndex` after a refresh sees the new scene. Everything
    // below this line is background scheduling, and `runArchiveTrack`'s
    // `return true` verdict is unreachable from a listener: containment is
    // per-listener inside the bus, so no listener can propagate an exception
    // into the enclosing `try` and turn a successful append into
    // `archived: false`.
    if (appendedSceneId) {
        // Lazy: resolving `messageId` reads the live store, so with no listeners
        // it does not happen at all, and if it ever throws it does so inside the
        // emit guard rather than inside `runArchiveTrack`'s `try` — where a
        // throw would turn a successful append into `archived: false`.
        const sceneId = appendedSceneId;
        emitCoreEventLazy('archive.sceneAppended', () => ({
            campaignId: activeCampaignId,
            sceneId,
            // The stamped bubble, identified by the stamp itself rather than by
            // re-deriving "last assistant" — `allMsgs` is the snapshot's frozen
            // window, and `updateLastAssistantMessage` wrote to the live store.
            // `null` on the re-link path, where the message was stamped by an
            // earlier attempt and this run touched no bubble.
            messageId: reLinked
                ? null
                : (useAppStore.getState().messages?.find(m => m.sceneId === sceneId)?.id ?? null),
        }));
    }

    const entry = freshIndex.find(e => e.sceneId === appendedSceneId);

    // Trap 1: Evaluate bookkeeping gate once
    const turnCount = state.incrementBookkeepingTurnCounter();
    const bookkeepingDue = turnCount >= state.autoBookkeepingInterval && Boolean(appendedSceneId);
    if (bookkeepingDue) {
        state.resetBookkeepingTurnCounter();
    }

    // Trap 2: Compute shared scan inputs once
    const bkProvider = state.getFreshProvider();
    const bkAvailable = facade ? hasHostModelRole(facade, 'story') : Boolean(bkProvider);
    const snapshotContext = facade?.data.context;
    const freshContext = snapshotContext?.characterProfileActive ? snapshotContext : state.getFreshContext();
    const inventoryItems = freshContext.inventoryItems || [];
    const profileData = freshContext.characterProfileData || { name: '', race: '', class: '', level: 1, hp: { current: 20, max: 20 }, stats: {}, skills: [], abilities: [], traits: [], notes: '' };
    const scanMessages = facade?.data.messages ?? state.getMessages();
    const storyModelCall = facade ? (request: import('./hostFacade').ModelRequest) => facade.model.call('story', request) : undefined;

    const guardedUpdateContext = makeGuarded(facade?.write.updateContext ?? callbacks.updateContext, activeCampaignId, 'updateContext (bookkeeping scan)');
    const guardedSetCharacterProfileData = makeGuarded(
        callbacks.setCharacterProfileData,
        activeCampaignId,
        'setCharacterProfileData (Profile-Scan)',
    );
    const guardedSetInventoryItems = makeGuarded(
        callbacks.setInventoryItems,
        activeCampaignId,
        'setInventoryItems (Inventory-Scan)',
    );
    const guardedSetLocationLedger = makeGuarded(
        callbacks.setLocationLedger,
        activeCampaignId,
        'setLocationLedger (Location-Scan)',
    );
    const guardedAddLocationSuggestions = makeGuarded(
        callbacks.addLocationSuggestions,
        activeCampaignId,
        'addLocationSuggestions (Location-Scan)',
    );
    
    // PC Drift check context
    const pc = state.getFreshContext().playerCharacter;
    const guardedUpdatePlayerCharacter = makeGuarded(
        (patch: Partial<import('../../types').PlayerCharacter>) => useAppStore.getState().updatePlayerCharacter(patch),
        activeCampaignId,
        'updatePlayerCharacter (PC-Drift)',
    );

    const postCommitContext: PostCommitTrackContext = {
        state,
        facade,
        callbacks,
        displayInput,
        lastAssistantContent,
        activeCampaignId,
        sceneId: appendedSceneId,
        freshIndex,
        freshChapters,
        entry,
        eventExtractionProvider: facade ? undefined : state.getFreshProvider(),
        bookkeepingDue,
        bkProvider,
        bkAvailable,
        snapshotContext,
        freshContext,
        inventoryItems,
        profileData,
        scanMessages,
        storyModelCall,
        guardedUpdateContext,
        guardedSetCharacterProfileData,
        guardedSetInventoryItems,
        guardedSetLocationLedger,
        guardedAddLocationSuggestions,
        pc,
        guardedUpdatePlayerCharacter,
    };

    const postCommitPromises = startPostCommitTracks(postCommitContext, state.settings);
    // Handle rejections to avoid unhandled promise rejection warnings in the background
    for (const p of postCommitPromises) {
        p.catch(err => {
            console.warn('[PostTurn] Post-commit track background execution failed:', err);
        });
    }

    return true;
}

export async function runCombinedSeal(
    provider: EndpointConfig | ProviderConfig | undefined,
    chapter: import('../../types').ArchiveChapter,
    activeCampaignId: string,
    state: TurnState,
    callbacks: TurnCallbacks,
    setSealedAt: boolean,
    // WO-P1-03 §4 (Option A): the 5 coupling reads hoisted to explicit params.
    // Pre-refactor these were fetched inside the function via
    // `useAppStore.getState().*`. Hoisting them makes the seal's inputs honest
    // and testable. Same values, just passed in rather than fetched —
    // byte-identical effect (guarded by postTurnSealGolden.test.ts).
    sealInputs: {
        npcLedger: import('../../types').NPCEntry[];
        archiveIndex: import('../../types').ArchiveIndexEntry[];
        divergenceScanBudget: number;
        contextLimit: number;
        divergenceRegister: import('../../types').DivergenceRegister;
    },
    modelCall?: SealModelCall,
): Promise<void> {
    const startNum = parseInt(chapter.sceneRange[0], 10);
    const endNum = parseInt(chapter.sceneRange[1], 10);
    const sceneIds = chapter.sceneIds?.length > 0
        ? chapter.sceneIds
        : Array.from({ length: endNum - startNum + 1 }, (_, i) =>
            String(startNum + i).padStart(3, '0')
        );

    const scenes = await api.archive.fetchScenes(activeCampaignId, sceneIds);
    // WO-P1-03: was `useAppStore.getState().npcLedger ?? []` (the :489 read).
    const npcLedger = sealInputs.npcLedger;
    const npcData = npcLedger.map(n => ({
        id: n.id,
        name: n.name,
        aliases: n.aliases,
    }));

    // WO-P1-03: was `useAppStore.getState().archiveIndex ?? []` (the :496 read).
    const archiveIndex = sealInputs.archiveIndex;
    const indexEntries = archiveIndex
        .filter(e => {
            const sn = parseInt(e.sceneId, 10);
            return sn >= startNum && sn <= endNum && e.witnesses && e.witnesses.length > 0;
        })
        .map(e => ({ sceneId: e.sceneId, witnesses: e.witnesses }));

    // WO-P1-03: was `useAppStore.getState().settings.divergenceScanBudget ?? 0` (the :504 read)
    // and `useAppStore.getState().settings.contextLimit ?? 4096` (the :505 read).
    const scanBudgetSetting = sealInputs.divergenceScanBudget;
    const contextLimit = sealInputs.contextLimit;
    const effectiveScanBudget = scanBudgetSetting > 0 ? scanBudgetSetting : Math.round(contextLimit * 0.75);

    const sealArgs = [
        scenes,
        chapter.chapterId,
        chapter.title,
        sceneIds,
        npcData,
        2,
        effectiveScanBudget,
        indexEntries.length > 0 ? indexEntries : undefined,
        sealInputs.divergenceRegister.entries,
    ] as const;
    const result = modelCall
        ? await sealChapterCombined(provider, ...sealArgs, modelCall)
        : await sealChapterCombined(provider, ...sealArgs);

    if (result.divergenceParseError && !result.summary && !result.divergences.length) {
        toast.error('Chapter seal produced no output. Try regenerating.');
        return;
    }

    if (result.divergenceParseError && result.divergences.length === 0) {
        toast.warning('Summary generated but facts extraction failed. You can regenerate to retry.');
    }

    if (result.summary) {
        const patch: Record<string, any> = {
            ...result.summary,
            invalidated: false,
            sceneIds,
        };
        if (setSealedAt) {
            // Auto-seal already sets sealedAt via server; just update content
        }
        await api.chapters.update(activeCampaignId, chapter.chapterId, patch);
    } else if (setSealedAt || result.divergences.length > 0) {
        // Even without summary, persist sceneIds
        await api.chapters.update(activeCampaignId, chapter.chapterId, { sceneIds } as any);
    }

    if (result.divergences.length > 0) {
        const currentSceneId = sceneIds[sceneIds.length - 1] ?? '';
        // WO-P1-03: was `useAppStore.getState().divergenceRegister ?? EMPTY_REGISTER` (the :546 read).
        const liveRegister = sealInputs.divergenceRegister;
        const merged = mergeLifecycleEntries(liveRegister, result.divergences, currentSceneId);
        callbacks.setDivergenceRegister?.(merged);

        try {
            await saveDivergenceRegister(activeCampaignId, merged);
        } catch (e) {
            console.warn('[CombinedSeal] Failed to save divergence register:', e);
        }

        console.log(`[CombinedSeal] Chapter ${chapter.chapterId}: ${result.divergences.length} facts extracted`);
    }

    // ── Apply witness corrections from seal audit ──
    if (result.witnessCorrections && Object.keys(result.witnessCorrections).length > 0) {
        try {
            const corrections = result.witnessCorrections;
            const patchPayload: { sceneId: string; witnesses: string[]; witnessSource: string }[] = [];
            for (const [sceneId, names] of Object.entries(corrections)) {
                if (names.length > 0) {
                    patchPayload.push({ sceneId, witnesses: names, witnessSource: 'seal_correction' });
                }
            }
            if (patchPayload.length > 0) {
                await api.archive.patchWitnesses(activeCampaignId, patchPayload);
                const freshIndex = await api.archive.getIndex(activeCampaignId);
                callbacks.setArchiveIndex(freshIndex);
                console.log(`[CombinedSeal] Applied witness corrections for ${Object.keys(corrections).length} scenes`);
            }
        } catch (e) {
            console.warn('[CombinedSeal] Failed to apply witness corrections:', e);
        }
    }

    // ── Apply scene event corrections/backfill from seal audit ──
    if (result.sceneEventMap && Object.keys(result.sceneEventMap).length > 0) {
        try {
            const patches = Object.entries(result.sceneEventMap).map(([sceneId, events]) => ({
                sceneId,
                events
            }));
            await api.archive.patchEvents(activeCampaignId, patches);
            const freshIndex = await api.archive.getIndex(activeCampaignId);
            callbacks.setArchiveIndex(freshIndex);
            console.log(`[CombinedSeal] Applied scene events backfill for ${patches.length} scenes`);
        } catch (e) {
            console.warn('[CombinedSeal] Failed to apply scene events backfill:', e);
        }
    }

    const latestChapters = await api.chapters.list(activeCampaignId);
    state.setChapters(latestChapters);

    if (result.summary) {
        console.log(`[CombinedSeal] Summary generated for "${chapter.title}"`);
    }
}
