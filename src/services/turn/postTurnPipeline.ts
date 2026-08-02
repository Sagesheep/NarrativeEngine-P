import type { ChatMessage, NPCEntry, EndpointConfig, ProviderConfig } from '../../types';
import type { TurnState, TurnCallbacks } from './turnOrchestrator';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../llm/apiClient';
import { CHAPTER_SCENE_SOFT_CAP } from '../../types';
import { rateImportance } from '../archive-memory/importanceRater';
import { sealChapterCombined, type SealModelCall } from '../saveFileEngine';
import { backgroundQueue } from '../infrastructure/backgroundQueue';
import { extractSceneEvents } from '../archive-memory/sceneEventExtractor';
import { scanCharacterProfile } from '../characterProfileParser';
import { scanCharacterTraits } from '../characterTraitParser';
import { scanInventory } from '../inventoryParser';
import { mergeLocationScanLedger, scanLocation } from '../locationParser';
import { resolveLocationHeader } from '../locationHeader';
import { toast } from '../../components/Toast';
import { mergeLifecycleEntries, EMPTY_REGISTER } from '../campaign-state/divergenceRegister';
import { saveDivergenceRegister } from '../../store/campaignStore';
import { tierAllows } from './aiTier';
// WO-P2-03 — post-turn track registry. The optional scans live in `tracks/`; the archive
// commit path deliberately does not (see `tracks/index.ts`).
import { startPostTurnTracks } from './tracks';
import type { PostTurnTrackContext } from './tracks/types';
import { buildHostFacade, hasHostModelRole, type HostFacade } from './hostFacade';

// WO-P2-03: the enemy-discovery single-flight map moved to `tracks/enemySuggestionTrack.ts`
// along with the track body. Re-exported here so the campaign-switch caller
// (`campaignSlice.ts:569`, a dynamic `import('.../turn/postTurnPipeline')`) keeps working
// against the same module instance and the same map.
export { clearEnemyDiscoveryState } from './tracks/enemySuggestionTrack';

const PRESENT_HEADER_RE = /👥\s*\[Present\]\s*(.+)/i;

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

/** Drop the entire background closure if the campaign switched before it
 *  starts running (cheap fast-fail). Re-check after each significant await
 *  via `assertStillActive` for closures with multiple awaited steps. */
function assertStillActive(activeCampaignId: string, label: string): boolean {
    const currentId = useAppStore.getState().activeCampaignId;
    if (currentId !== activeCampaignId) {
        console.warn(`[PostTurn] Aborting ${label} — campaign switched (${activeCampaignId} → ${currentId})`);
        return false;
    }
    return true;
}

function parsePresentHeader(content: string): string[] | null {
    const match = content.match(PRESENT_HEADER_RE);
    if (!match) return null;
    return match[1].split(/[,;]/).map(n => n.trim()).filter(Boolean);
}

function resolveNPCIds(
    names: string[],
    npcLedger: NPCEntry[]
): string[] {
    const nameToId = new Map<string, string>();
    for (const npc of npcLedger) {
        const nameLower = npc.name.toLowerCase();
        nameToId.set(nameLower, npc.id);
        if (npc.aliases) {
            npc.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)
                .forEach(a => nameToId.set(a, npc.id));
        }
    }
    return names
        .map(n => nameToId.get(n.toLowerCase()))
        .filter((id): id is string => !!id);
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

    // B3 — a PC built in chat never flips characterProfileActive (only the PC Creation
    // Wizard did). Auto-enable the moment a campaign has an isPC NPC, and seed the profile
    // name from it. Idempotent: once the gate is true this is a no-op. Never clobbers an
    // existing name (|| guard) — a profile the scan already built must survive. Only name is
    // mappable from NPCEntry (race/class/level are NOT on the entry); scanCharacterProfile
    // enriches the rest over the next few turns, preserving identity as it goes.
    autoEnableCharacterProfile(state, callbacks, npcLedger);

    // ── Phase 2/3: clear agency + arc digests at the top so each is consumed exactly once ──
    // The previous turn's digests were folded into the GM call we just made; clear them
    // before fresh digests accumulate from this turn's agency + arc ticks.
    if (state.context.agencyDigest) {
        callbacks.updateContext({ agencyDigest: '' });
    }
    if (state.context.arcDigest) {
        callbacks.updateContext({ arcDigest: '' });
    }

    // WO-P2-03: the optional post-turn scans are registered tracks now (see
    // `tracks/index.ts`). `startPostTurnTracks` does not await — it starts the enabled
    // tracks in registration order and returns their in-flight promises, so spreading
    // them here reproduces the original array literal exactly: same start order, same
    // single `allSettled`, same containment, archive still at index 0.
    const facade = buildHostFacade(state, callbacks, {
        updatePlayerCharacter: (patch) => useAppStore.getState().updatePlayerCharacter(patch),
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

    // ── On-Stage NPC Tracking ──
    const presentNames = parsePresentHeader(lastAssistantContent);
    const onStageIds = presentNames && presentNames.length > 0
        ? resolveNPCIds(presentNames, npcLedger)
        : [];
    callbacks.setOnStageNpcIds?.(onStageIds);

    // ── Location Header Tracking (hot path) ──
    // Sibling of the 👥 [Present] parse above: the GM's 📍 [Location] header is the
    // authoritative per-turn location self-report (requested by defaultRules.ts:51).
    // Engine regex, zero LLM, every tier. The interval-gated scanLocation call in
    // runArchiveTrack stays the cold path (features/connections enrichment). Header
    // absent or unusable → no-op; the last known pointer stands. Unknown places are
    // suggested, never auto-added (same trust model as NPC suggestions).
    try {
        const sNow = useAppStore.getState();
        if (sNow.activeCampaignId === activeCampaignId) {
            const outcome = resolveLocationHeader(
                lastAssistantContent,
                sNow.locationLedger ?? [],
                sNow.context.currentPlaceId ?? null,
            );
            if (outcome.kind === 'resolved') {
                callbacks.updateContext({ currentPlaceId: outcome.placeId, currentFeature: outcome.feature });
                if (outcome.appendFeature && outcome.feature) {
                    const entry = sNow.locationLedger.find(l => l.id === outcome.placeId);
                    if (entry) sNow.updateLocation(outcome.placeId, { features: [...entry.features, outcome.feature], lastSeenScene: String(Date.now()) });
                }
            } else if (outcome.kind === 'feature-only') {
                callbacks.updateContext({ currentFeature: outcome.feature });
                if (outcome.appendFeature && sNow.context.currentPlaceId) {
                    const entry = sNow.locationLedger.find(l => l.id === sNow.context.currentPlaceId);
                    if (entry) sNow.updateLocation(entry.id, { features: [...entry.features, outcome.feature] });
                }
            } else if (outcome.kind === 'unknown') {
                sNow.addLocationSuggestions([outcome.suggestion]);
            }
        }
    } catch (err) {
        console.warn('[LocationHeader] Parse failed (non-fatal):', err);
    }

    for (const r of results) {
        if (r.status === 'rejected') {
            console.warn('[PostTurn] Track failed:', r.reason);
        }
    }

    // ── NPC Agency Tick (Phase 2 port) ──
    // Runs after archive/NPC/pressure tracks settle so newly-detected NPCs have profiles
    // before they're ticked. Mutates NPC agency state in-place via callbacks.updateNPC;
    // folds a digest into context.agencyDigest for the next GM call. Gated by aiTier in Phase 4.
    // Also bumps activity for every NPC that was on-stage last turn so the deep tier tracks the
    // player's active social circle (bumpOnStageActivity is unconditional — same pattern as the
    // short-want lifecycle).
    try {
        const { runAgencyTick, bumpOnStageActivity } = await import('../npc/agency/agencyEngine');
        bumpOnStageActivity(state, facade ? { ...callbacks, updateNPC: facade.write.updateNPC } : callbacks, facade?.data.npcLedger ?? npcLedger);
        if (tierAllows(state.settings.aiTier, 'heartbeatTick')) {
            // Guard only addMessage — it's the only callback invoked from a
            // backgroundQueue.push closure inside runAgencyTick (Timeskip-Narration,
            // agencyEngine.ts:341). The synchronous updateContext/updateNPC calls in
            // runAgencyTick run in the same microtask as this line, so they don't need
            // guarding (same reasoning as the synchronous pipeline calls at L68/111).
            const agencyCallbacks: TurnCallbacks = {
                ...callbacks,
                addMessage: makeGuarded(callbacks.addMessage, activeCampaignId, 'addMessage (Timeskip-Narration)'),
            };
            runAgencyTick(state, agencyCallbacks, facade?.data.npcLedger ?? npcLedger, displayInput, facade);
        }
    } catch (err) {
        console.warn('[AgencyTick] Failed (non-fatal):', err);
    }

    // ── Inner Repression booking (parity 30/06 WO-3) — the once-per-turn pressure accrual ──
    // The payload reaction menu (world.ts read path) MASKS a hostile impulse on every render but
    // intentionally drops the repression `event`, because payload assembly re-runs within a turn
    // and would double-count. THIS is the single authoritative booking site: roll repression once
    // per on-stage hex NPC and persist the pressure delta, so the build-up → burst dynamic actually
    // fires (without this, repressionPressure never accrues and the feature is inert). Zero LLM;
    // pure dice. Ungated (mirrors the menu, which is shown on every tier). Never inside payload.
    try {
        const { buildReactionMenu } = await import('../npc/reactionMenu');
        const { applyRepressionToMenu, bookRepression } = await import('../npc/reactionRepression');
        const onStageSet = new Set(onStageIds);
        const matureMode = state.settings.matureMode ?? false;
        for (const npc of npcLedger) {
            if (!onStageSet.has(npc.id) || !npc.personalityHex) continue;
            const rng = Math.random; // one fresh roll per turn per NPC — that IS the once-per-turn accrual
            const menu = buildReactionMenu(npc, 'peaceful', rng, matureMode);
            const { event } = applyRepressionToMenu(menu, npc, 'peaceful', rng);
            if (!event) continue; // nothing repressible this turn
            const patch = bookRepression(npc, event);
            if (Object.keys(patch).length > 0) callbacks.updateNPC(npc.id, patch);
        }
    } catch (err) {
        console.warn('[RepressionBooking] Failed (non-fatal):', err);
    }

    // ── Arc Engine Tick ──
    // WO-P5-12 §7 Step 2: moved into the track registry (`tracks/arcTickTrack.ts`),
    // inheriting the `allSettled` containment WO-P5-10 hardened. The inline
    // try/catch that used to wrap it here is deleted — a small, concrete measure
    // of the architecture paying for itself (WO-P5-12 §5). The track reads arcs
    // from the store's `mod.arc.arcs` table (Step 1) and persists its writes
    // through the host facade.

    return { archived };
}

// B3 — Auto-enable characterProfileActive for chat-made PCs. The flag was flipped true ONLY by
// the PC Creation Wizard, so PCs built conversationally never engaged the structured-profile
// subsystem (scan, payload injection). Fires at the top of runPostTurnPipeline with npcLedger
// in scope, before runArchiveTrack's bookkeeping scan so the scan can fire the same turn.
// Idempotent: once characterProfileActive is true, this is a no-op. Never clobbers an existing
// profile name (|| guard) — a profile the scan already built must survive. Only name is mappable
// from NPCEntry (race/class/level are NOT on the entry); scanCharacterProfile enriches the rest.
function autoEnableCharacterProfile(
    state: TurnState,
    callbacks: TurnCallbacks,
    npcLedger: NPCEntry[],
): void {
    if (state.context.characterProfileActive) return;
    // WO-A rewrite 2 §2: PC lives at `context.playerCharacter`. Defensive
    // fallback to a legacy `isPC` ledger row (post-migration this is empty).
    const pc = state.context.playerCharacter ?? npcLedger.find(n => n.isPC);
    if (!pc) return;
    const existing = state.context.characterProfileData || { name: '', race: '', class: '', level: 1, hp: { current: 20, max: 20 }, stats: {}, skills: [], abilities: [], traits: [], notes: '' };
    const seeded: typeof existing = {
        ...existing,
        name: existing.name || pc.name,
    };
    callbacks.updateContext({
        characterProfileActive: true,
        characterProfileData: seeded,
    });
    console.log(`[B3] Auto-enabled characterProfileActive; seeded characterProfileData.name from PC "${pc.name}"`);
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
    if (verifyExistingScene) {
        appendedSceneId = await findArchivedSceneIdForTurn(activeCampaignId, displayInput);
        if (appendedSceneId) {
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

    const entry = freshIndex.find(e => e.sceneId === appendedSceneId);
    const bkProvider = state.getFreshProvider();
    if (entry && !entry.events && bkProvider) {
        const sceneText = `${displayInput}\n\n${lastAssistantContent}`;
        const guardedSetArchiveIndex = makeGuarded(callbacks.setArchiveIndex, activeCampaignId, 'setArchiveIndex (Event-Extraction)');
        backgroundQueue.push(`Event-Extraction:${appendedSceneId}`, async () => {
            if (!assertStillActive(activeCampaignId, 'Event-Extraction')) return;
            const events = await extractSceneEvents(bkProvider, sceneText);
            if (events && events.length > 0) {
                await api.archive.patchEvents(activeCampaignId, [{ sceneId: entry.sceneId, events }]);
                const updatedIndex = await api.archive.getIndex(activeCampaignId);
                guardedSetArchiveIndex(updatedIndex);
                console.log(`[Archive] Post-turn events extracted for scene #${entry.sceneId}`);
            }
        }).catch(err => console.warn('[PostTurn] Background event extraction failed:', err));
    }

    const openChapter = freshChapters.find(c => !c.sealedAt);
    if (openChapter && openChapter.sceneCount >= CHAPTER_SCENE_SOFT_CAP) {
        console.log(`[Auto-Seal] Chapter "${openChapter.title}" hit ${openChapter.sceneCount} scenes — sealing...`);
        const guardedSetChapters = makeGuarded(state.setChapters, activeCampaignId, 'setChapters (Auto-Seal)');
        const guardedSealCallbacks: TurnCallbacks = {
            ...callbacks,
            setDivergenceRegister: callbacks.setDivergenceRegister
                ? makeGuarded(callbacks.setDivergenceRegister, activeCampaignId, 'setDivergenceRegister (Auto-Seal)')
                : undefined,
            setArchiveIndex: makeGuarded(callbacks.setArchiveIndex, activeCampaignId, 'setArchiveIndex (Auto-Seal)'),
        };
        backgroundQueue.push('Chapter-AutoSeal', async () => {
            if (!assertStillActive(activeCampaignId, 'Chapter-AutoSeal')) return;
            const sealResult = await api.chapters.seal(activeCampaignId);
            if (!assertStillActive(activeCampaignId, 'Chapter-AutoSeal')) return;
            if (!sealResult) return;
            const sealedChapters = await api.chapters.list(activeCampaignId);
            if (!assertStillActive(activeCampaignId, 'Chapter-AutoSeal')) return;
            guardedSetChapters(sealedChapters);
            toast.info(`Chapter "${sealResult.sealedChapter.title}" auto-sealed (${CHAPTER_SCENE_SOFT_CAP} scenes)`);

            const sealProvider = facade ? undefined : state.getFreshProvider();
            const sealModelCall: SealModelCall | undefined = facade && hasHostModelRole(facade, 'story')
                ? (request) => facade.model.call('story', request).then(result => result.content)
                : undefined;
            if ((sealProvider || sealModelCall) && tierAllows(facade?.config.aiTier ?? state.settings.aiTier, 'sealChapter')) {
                // WO-P1-03: pass the 5 formerly-coupling reads as explicit params.
                // These are read from the store here at the call site (still on
                // the post-turn path), but the seal function itself no longer
                // reaches into getState() — its inputs are now honest.
                await runCombinedSeal(
                    sealProvider,
                    sealResult.sealedChapter,
                    activeCampaignId,
                    state,
                    guardedSealCallbacks,
                    true,
                    {
                        npcLedger: facade?.data.npcLedger ?? state.npcLedger ?? [],
                        archiveIndex: facade?.data.archiveIndex ?? state.archiveIndex ?? [],
                        divergenceScanBudget: facade?.config.divergenceScanBudget ?? state.settings.divergenceScanBudget ?? 0,
                        contextLimit: facade?.config.contextLimit ?? state.settings.contextLimit ?? 4096,
                        divergenceRegister: facade?.data.divergenceRegister ?? state.divergenceRegister ?? EMPTY_REGISTER,
                    },
                    sealModelCall,
                );
            }
        }).catch(err => console.warn('[Auto-Seal] Failed:', err));
    }

    const turnCount = state.incrementBookkeepingTurnCounter();
    const interval = state.autoBookkeepingInterval;
    if (turnCount >= interval && appendedSceneId) {
        console.log(`[Auto Bookkeeping] Turn ${turnCount} >= interval ${interval} — queuing profile + inventory scan (scene #${appendedSceneId})`);
        state.resetBookkeepingTurnCounter();

        const bkProvider = state.getFreshProvider();
        const bkAvailable = facade ? hasHostModelRole(facade, 'story') : Boolean(bkProvider);
        if (bkAvailable) {
            const sceneId = appendedSceneId;
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

            if (tierAllows(facade?.config.aiTier ?? state.settings.aiTier, 'profileScan')) {
                backgroundQueue.push('Profile-Scan', async () => {
                    if (!assertStillActive(activeCampaignId, 'Profile-Scan')) return;
                    const newProfile = await scanCharacterProfile(facade ? undefined : bkProvider, scanMessages, profileData, storyModelCall);
                    if (!assertStillActive(activeCampaignId, 'Profile-Scan')) return;
                    guardedUpdateContext({
                        characterProfileData: newProfile,
                        characterProfileLastScene: sceneId,
                    });
                    (facade?.write.setCharacterProfileData ?? guardedSetCharacterProfileData)(newProfile);
                    console.log(`[Auto Bookkeeping] Profile sheet updated at scene #${sceneId}`);
                }).catch(err => console.warn('[Auto Bookkeeping] Profile scan failed:', err));
            }

            // WO-G: structured trait scan (sibling of the sheet scan). Maintains the
            // CharacterProfileState (identity + bounded activeTraits with supersession).
            // WO-J (5be8695): gate on characterProfileActive — skip the LLM call when the
            // toggle is off, since the result is never injected.
            if (freshContext.characterProfileActive && tierAllows(facade?.config.aiTier ?? state.settings.aiTier, 'profileScan')) {
                const traitProfile = freshContext.characterProfile || { identity: {}, activeTraits: [] };
                backgroundQueue.push('Trait-Scan', async () => {
                    if (!assertStillActive(activeCampaignId, 'Trait-Scan')) return;
                    const newTraits = await scanCharacterTraits(facade ? undefined : bkProvider, scanMessages, traitProfile, storyModelCall);
                    if (!assertStillActive(activeCampaignId, 'Trait-Scan')) return;
                    guardedUpdateContext({
                        characterProfile: newTraits,
                    });
                    console.log(`[Auto Bookkeeping] Traits updated at scene #${sceneId} (${newTraits.activeTraits.filter(t => !t.superseded).length} active)`);
                }).catch(err => console.warn('[Auto Bookkeeping] Trait scan failed:', err));
            }

            if (bkAvailable && tierAllows(facade?.config.aiTier ?? state.settings.aiTier, 'inventoryScan')) {
                backgroundQueue.push('Inventory-Scan', async () => {
                    if (!assertStillActive(activeCampaignId, 'Inventory-Scan')) return;
                    const newItems = await scanInventory(facade ? undefined : bkProvider, scanMessages, inventoryItems, storyModelCall);
                    if (!assertStillActive(activeCampaignId, 'Inventory-Scan')) return;
                    guardedUpdateContext({
                        inventory: newItems.map(it => `- ${it.qty > 1 ? `${it.qty}x ` : ''}${it.name}`).join('\n'),
                        inventoryItems: newItems,
                        inventoryLastScene: sceneId,
                    });
                    (facade?.write.setInventoryItems ?? guardedSetInventoryItems)(newItems);
                    console.log(`[Auto Bookkeeping] Inventory updated at scene #${sceneId}`);
                }).catch(err => console.warn('[Auto Bookkeeping] Inventory scan failed:', err));
            }

            // WO-Location: structured location estimator — the place-analogue of the
            // inventory scan. Sibling block, same background queue + guards + tier gate
            // class as inventoryScan. Resolves the PC's current place + merges features/
            // connections into existing ledger entries + emits new-place suggestions for
            // player review. Never auto-adds entries. Pointer rides callbacks.updateContext
            // (currentPlaceId/currentFeature); ledger + suggestions ride the store setters.
            if (bkAvailable && tierAllows(facade?.config.aiTier ?? state.settings.aiTier, 'locationScan')) {
                backgroundQueue.push('Location-Scan', async () => {
                    if (!assertStillActive(activeCampaignId, 'Location-Scan')) return;
                    const before = callbacks.getFreshLocationState();
                    const baselineLedger = before.locationLedger ?? [];
                    const baselinePlaceId = before.context.currentPlaceId ?? null;
                    const baselineFeature = before.context.currentFeature ?? null;
                    const scan = await scanLocation(
                        facade ? undefined : bkProvider,
                        scanMessages,
                        baselineLedger,
                        baselinePlaceId,
                        baselineFeature,
                        storyModelCall,
                    );
                    if (!assertStillActive(activeCampaignId, 'Location-Scan')) return;
                    const after = callbacks.getFreshLocationState();
                    if (after.activeCampaignId !== activeCampaignId) return;

                    // A manual/header pointer change made while the LLM was in flight wins.
                    if (after.context.currentPlaceId === baselinePlaceId && (after.context.currentFeature ?? null) === baselineFeature
                        && (scan.currentPlaceId !== baselinePlaceId || scan.currentFeature !== baselineFeature)) {
                        guardedUpdateContext({ currentPlaceId: scan.currentPlaceId, currentFeature: scan.currentFeature });
                    }

                    const mergedLedger = mergeLocationScanLedger(baselineLedger, scan.ledger, after.locationLedger ?? []);
                    if (mergedLedger !== after.locationLedger) {
                        (facade?.write.setLocationLedger ?? guardedSetLocationLedger)(mergedLedger);
                    }
                    if (scan.suggestions.length > 0) {
                        (facade?.write.addLocationSuggestions ?? guardedAddLocationSuggestions)(scan.suggestions);
                    }
                    console.log(`[Auto Bookkeeping] Location scan at scene #${sceneId}: current=${scan.currentPlaceId ?? '(unclear)'}, suggestions=${scan.suggestions.length}`);
                }).catch(err => console.warn('[Auto Bookkeeping] Location scan failed:', err));
            }

            // ── PC Drift Check (WO-A2 §3) — sibling of the bookkeeping scan, on the
            // same `autoBookkeepingInterval` cadence. Kit changes are rare and a
            // per-turn call is wasted most turns, so this gates on the same interval
            // used by the profile/inventory scans. Forked from npc-generation/update.ts
            // with a narrower whitelist (personalityHex/traits/relations/pcRelation
            // are blocked — see §0). Host-facade story broker per §2.2 chain.
            const pc = state.getFreshContext().playerCharacter;
            if (facade && hasHostModelRole(facade, 'story') && pc && tierAllows(facade.config.aiTier ?? state.settings.aiTier, 'npcUpdate')) {
                const guardedUpdatePlayerCharacter = makeGuarded(
                    (patch: Partial<typeof pc>) => useAppStore.getState().updatePlayerCharacter(patch),
                    activeCampaignId,
                    'updatePlayerCharacter (PC-Drift)',
                );
                backgroundQueue.push('PC-Drift:' + pc.name, async () => {
                    if (!assertStillActive(activeCampaignId, 'PC-Drift')) return;
                    const { checkCharacterDrift } = await import('../character/pcUpdater');
                    await checkCharacterDrift((request) => facade.model.callJson('story', request, { retries: 1 }), state.getMessages(), pc, guardedUpdatePlayerCharacter);
                    console.log('[Auto Bookkeeping] PC drift check completed at scene #' + sceneId);
                }).catch(err => console.warn('[PC Updater] Background drift check failed:', err));
            }
        }
    }

    // The scene is in long-term memory — the caller may safely retire the turn.
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
