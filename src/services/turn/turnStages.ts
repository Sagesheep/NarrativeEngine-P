// WO-P1-02 — Named turn stages.
//
// Each stage takes the TurnContext bus (from WO-P1-01) and the inputs it needs.
// Stages write onto the bus; downstream stages read from it. Pure code-move
// from `runTurn` — NO logic, ordering, or control-flow change. The golden
// payload + turn-flow tests (turnContextGolden.test.ts) must stay byte-green.
//
// Stage → original `runTurn` line mapping (pre-extraction):
//   resolveEngineRolls      → 121-176 (rollEngines + armed dice/loot/oneshot)
//   addUserTurnMessage      → 178-189 (synchronous user bubble + setStreaming/phase)
//   gatherTurnContext       → 191-205 (thin wrapper over gatherContext)
//   runIntroEngineStage     → 207-227 (tier-gated NPC intro engine)
//   runDirectorStage        → 229-291 (watchdog + director brief)
//   buildTurnPayload        → 293-350 (wraps buildPayload; debug trace attach)
//   runGenerationStage      → 352-588 (stream + tool loop + finalize + snapshot)
//
// The gnarly one is `runGenerationStage`: it owns the recursive `executeTurn`
// closure + `accumulatedContent`/`retryTimer`/`abortListener` lifecycle. Per
// WO-P1-02 §4, the whole recursion moves as one unit (do NOT hoist its
// function-scoped mutable state onto the bus unless provably neutral).

import type { NPCEntry, PayloadTrace, SwipeVariant, EndpointConfig, ThinkingEffort } from '../../types';
import { uid } from '../../utils/uid';
import { buildPayload, sendMessage } from '../chatEngine';
import { rollEngines, rollDiceFairness, resolveManualRoll } from '../engine/engineRolls';
import { resolveLootDrop } from '../engine/lootEngine';
import { buildOneShotDirective } from '../oneshot/oneShotEvents';
import { toast } from '../../components/Toast';
import { sanitizePayloadForApi } from '../lib/payloadSanitizer';
import { getToolDefinitions } from './toolHandlers';
import { resolveToolHandler } from './toolRegistry';
import { gatherContext } from './contextGatherer';
import { tierAllows } from './aiTier';
import { extractAndStripSceneStakes } from './sceneStakesTag';
import { capturePendingTurnSnapshot } from './pendingCommit';
import { buildWatchdogDossier } from './directorWatchdog';
import { runDirectorBrief, lastAssistantContent } from './directorBrief';
import type { TurnContext } from './turnContext';
import type { GatheredContext } from './contextGatherer';
import type { TurnState, TurnCallbacks } from './turnOrchestrator';
import { hasHostModelRole, type HostFacade } from './hostFacade';
import { emitCoreEvent, emitCoreEventLazy } from '../mods/events';
import { runPromptInterceptors } from '../mods/interceptors';
import { runFactPublishers } from '../mods/facts';
import { blockTokenCap } from './blockEnablement';
import { BUILTIN_IDS, getBuiltinTokenCap } from '../payload/contributions/builtins';

const MAX_TOOL_CALLS_PER_TURN = 5;

// ── Smart Retry v1 helpers ──────────────────────────────────────────────
// Build the collapsed-box summary for the `precontext` field on a retryable
// bubble. Kept short and non-technical — the user taps to expand for details
// (v2). Mirrors mobile's buildPrecontextSummary but against desktop's richer
// GatheredContext shape (semanticArchiveIds/semanticLoreIds instead of
// semanticArchiveHits; relevantRules is LoreChunk[] on both).
function buildPrecontextSummary(gathered: GatheredContext | undefined): string {
    if (!gathered) return 'Context gathered';
    const parts: string[] = [];
    if (gathered.relevantLore?.length) parts.push(`Lore×${gathered.relevantLore.length}`);
    if (gathered.relevantRules?.length) parts.push(`Rules×${gathered.relevantRules.length}`);
    if (gathered.archiveRecall?.length) parts.push(`Archive×${gathered.archiveRecall.length}`);
    if (gathered.semanticArchiveIds?.length) parts.push(`Hits×${gathered.semanticArchiveIds.length}`);
    if (gathered.recommendedNPCNames?.length) parts.push(`NPCs×${gathered.recommendedNPCNames.length}`);
    if (gathered.deepContextSummary) parts.push('DeepScan');
    return parts.length ? parts.join(' · ') : 'Context gathered';
}

// Smart Retry v1: stamp the terminal assistant bubble as retryable + attach
// the precontext summary. Called ONLY from the terminal exit branches (user
// abort + retry-exhausted) — NOT the intermediate retry branches (apiRetryCount
// 0 and 1 are still in flight). Targets the bubble by `assistantMsgId` via
// `updateLastAssistantMessage` (scans back to the last assistant), NEVER
// `updateLastMessage` (literal last message): after a tool call the literal
// last message is a tool message (desktop reuses one assistant id across
// iterations), so `updateLastMessage` would stamp the tool message and the
// Retry button would never render. See the warning at pendingCommit.ts.
function stampRetryable(
    callbacks: TurnCallbacks,
    assistantMsgId: string,
    gathered: GatheredContext | undefined,
): void {
    callbacks.updateLastAssistantMessage({
        retryable: true,
        precontext: { summary: buildPrecontextSummary(gathered) },
    });
    void assistantMsgId;
}

// ── Stage 1: resolveEngineRolls ──────────────────────────────────────────
// Pre-rolls the dice pool; resolves armed dice/loot/oneshot injectors.
// Writes ctx.finalInput, ctx.displayInputFinal, ctx.historyInput.
export function resolveEngineRolls(
    ctx: TurnContext,
    state: TurnState,
    callbacks: TurnCallbacks,
): void {
    const { context } = state;
    callbacks.setPipelinePhase?.('rolling-dice');
    const engineResult = rollEngines(context);
    ctx.finalInput += engineResult.appendToInput;
    callbacks.updateContext(engineResult.updatedDCs);
    ctx.historyInput = ctx.finalInput;

    // Player-called dice ("dice me"). When the player armed a roll, resolve REAL dice now
    // (hidden until this commit), assert the tier as FACT, and SUPPRESS the auto pool menu +
    // dice tool for this turn so the model gets exactly one signal it cannot cherry-pick.
    const armed = state.armedRoll;
    if (armed) {
        const r = resolveManualRoll(armed, context.diceSystem);
        const rollsLabel = r.rolls.length > 1 ? ` (rolled ${r.rolls.join(', ')})` : '';
        const tierLabel = r.tier ?? 'Unmapped';
        ctx.finalInput += `\n[RESOLVED ROLL — ${r.detail} → ${tierLabel} (${r.faceValue})${rollsLabel}. This HAPPENED. The outcome is fixed — do not re-roll, do not alter the tier, do not skip the roll. Narrate the consequence.]`;
        // Player-facing reveal — shows on their own turn bubble.
        ctx.displayInputFinal += `\n\n🎲 ${r.detail} → ${tierLabel} (${r.faceValue})`;
    } else {
        ctx.finalInput += rollDiceFairness(context);
    }

    // Loot Engine WO-05: player-armed loot drop. Mirrors the dice block above —
    // the engine returns a BARE `[LOOT DROP: ...]` tag and the orchestrator adds
    // the fact-assertion wrapper. The caller (ChatArea) clears `armedLoot`
    // before runTurn, exactly as it clears `armedRoll` — so this only reads the
    // captured value. The engine is pure: dice + JSON, zero LLM at runtime.
    const armedLoot = state.armedLoot;
    if (armedLoot && context.lootTree) {
        const loot = resolveLootDrop(context.lootTree, {
            rolls: armedLoot.rolls,
            profile: armedLoot.reweight ? { reweight: armedLoot.reweight } : undefined,
        });
        if (loot.appendToInput) {
            // Inject the fact-assertion INSIDE the closing bracket so the whole
            // block reads as one engine signal. The engine returns a bare `\n[LOOT DROP: ...]`.
            const bare = loot.appendToInput.replace(/\]$/, '');
            ctx.finalInput +=
                bare +
                ` — this loot DROPPED. Narrate the player finding it as fact; ` +
                `do NOT change its identity, inflate it, or add items beyond this list.]`;
            // Player-facing reveal — shows the drop on their own turn bubble.
            ctx.displayInputFinal += `\n\n💰 Loot drop armed (${armedLoot.rolls})`;
        }
    }

    // One-Shot Event Injector v1: player-armed event directive. Mirrors the dice/loot
    // blocks above — appended AFTER the historyInput capture, so it steers THIS turn's
    // generation but never enters durable chat history. Fires once; caller clears it.
    const armedOneShot = state.armedOneShot;
    if (armedOneShot) {
        const directive = buildOneShotDirective(armedOneShot);
        if (directive) {
            ctx.finalInput += directive;
            ctx.displayInputFinal += `\n\n⚡ Event injected (${armedOneShot})`;
        }
    }

    // Absolute Command v1: player-facing reveal only. The command block itself
    // travels as a buildPayload parameter (placed AFTER userMessage for maximum
    // recency) so it is NOT appended to ctx.finalInput — that keeps it out of
    // ctx.historyInput and therefore out of durable chat history. Mirrors the
    // one-shot reveal line above.
    if (state.absoluteCommand) {
        ctx.displayInputFinal += `\n\n⛔ Absolute command issued`;
    }
}

// ── Stage 2: addUserTurnMessage ──────────────────────────────────────────
// Synchronous user bubble + setStreaming/phase. Adds the user message to the
// chat list BEFORE heavy async so the bubble appears immediately.
export function addUserTurnMessage(
    ctx: TurnContext,
    callbacks: TurnCallbacks,
): void {
    const userMsgId = uid();
    callbacks.addMessage({
        id: userMsgId,
        role: 'user',
        content: ctx.historyInput,
        displayContent: ctx.displayInputFinal,
        timestamp: Date.now()
    });
    callbacks.setStreaming(true);
    callbacks.setPipelinePhase?.('gathering-context');
    callbacks.setLoadingStatus?.('Gathering Context & Memories concurrently...');
}

// ── Stage 3: gatherTurnContext ───────────────────────────────────────────
// Thin wrapper over gatherContext(). Folds the full GatheredContext return
// into ctx.gathered (replacing the ~14 loose destructured locals).
export async function gatherTurnContext(
    ctx: TurnContext,
    state: TurnState,
    callbacks: TurnCallbacks,
    signal: AbortSignal,
    facade?: HostFacade,
): Promise<void> {
    ctx.gathered = await gatherContext(state, ctx.finalInput, {
        chapters: state.chapters,
        pinnedChapterIds: state.pinnedChapterIds,
        clearPinnedChapters: state.clearPinnedChapters,
        deepSearchThisTurn: !!state.deepSearchThisTurn,
        setLoadingStatus: callbacks.setLoadingStatus,
    }, signal, facade);
}

// ── Stage 4: runIntroEngineStage ─────────────────────────────────────────
// Tier-gated NPC intro engine. Uses state.getFreshAuxiliaryProvider (WO-P1-01
// killed the useAppStore.getState().getActiveAuxiliaryEndpoint() coupling read).
export async function runIntroEngineStage(
    ctx: TurnContext,
    state: TurnState,
    callbacks: TurnCallbacks,
    facade?: HostFacade,
): Promise<void> {
    const data = facade?.data;
    const config = facade?.config;
    const settings = state.settings;
    const context = data?.context ?? state.context;
    const messages = data?.messages ?? state.messages;
    const npcLedger = data?.npcLedger ?? state.npcLedger;
    const provider = facade ? undefined : state.provider;
    if (!context.npcIntroEngineActive || !tierAllows(config?.aiTier ?? settings.aiTier, 'introEngine')) return;
    const seenNpcNames = new Set((npcLedger ?? []).map((n: NPCEntry) => n.name.toLowerCase()));
    try {
        const auxProvider = facade ? undefined : state.getFreshAuxiliaryProvider?.() ?? provider;
        const { rollCharacterIntroEngine } = await import('../npc-generation/charIntroEngine');
        const introResult = await rollCharacterIntroEngine(
            context,
            seenNpcNames,
            messages,
            auxProvider,
            facade ? (request: import('./hostFacade').ModelRequest) => facade.model.call('auxiliary', request) : undefined
        );
        if (introResult.tag) {
            ctx.finalInput = ctx.finalInput + '\n' + introResult.tag;
        }
        if (introResult.newDC !== context.npcIntroDC) {
            (facade?.write.updateContext ?? callbacks.updateContext)({ npcIntroDC: introResult.newDC });
        }
    } catch (err) {
        console.warn('[CharIntroEngine] Failed to run intro engine:', err);
    }
}

// ── Stage 5: runDirectorStage ────────────────────────────────────────────
// Watchdog + Director Brief. Writes ctx.watchdogNudge / ctx.directorBrief.
export async function runDirectorStage(
    ctx: TurnContext,
    state: TurnState,
    callbacks: TurnCallbacks,
    abortController: AbortController,
    facade?: HostFacade,
): Promise<void> {
    const settings = facade?.config ?? state.settings;
    const npcLedger = facade?.data.npcLedger ?? state.npcLedger;
    const provider = state.provider;

    callbacks.setPipelinePhase?.('building-prompt');
    callbacks.setLoadingStatus?.('Architecting AI Prompt...');

    // Absolute Command v1: the player has issued a binding OOC instruction for this
    // turn. Skip the Director entirely — both the blocking LLM call and the
    // deterministic watchdog nudge exist to steer the GM, which is precisely what the
    // player is overriding. Leaves ctx.watchdogNudge / ctx.directorBrief undefined, so
    // buildPayload emits neither block. Also saves one blocking LLM call. The gate
    // goes BEFORE buildWatchdogDossier so the dossier is not computed either. The
    // tierAllows check below is untouched — Absolute Command works on every tier,
    // including `lite` (which has no Director anyway).
    if (state.absoluteCommand) {
        return;
    }

    // Director Watchdog (WO-03): compute the deterministic dossier at payload-build time from
    // the SAME inputs the payload is about to consume (history, npcLedger, onStageNpcIds).
    // Per invariant 1, this is NOT a post-turn computation — it rides alongside the payload
    // build so the nudge reflects the visible window the model is about to see. The nudge
    // lands adjacent to GM_REMINDER in the final user message (below the cache boundary) so
    // it never perturbs the cached prefix (payloadBuilder enforces this). All tiers get the
    // nudge — no tier gate per WO-03 §3.
    const watchdogDossier = buildWatchdogDossier({
        messages: facade?.data.messages ?? state.messages,
        npcLedger,
        onStageNpcIds: facade?.data.onStageNpcIds ?? state.onStageNpcIds ?? [],
        playerCharacter: (facade?.data.context ?? state.context).playerCharacter ?? null,
    });
    const watchdogNudge = watchdogDossier.nudgeText ?? undefined;

    // Director Brief (WO-04): one blocking LLM call on pro/max that audits the last GM turn
    // and issues a Writer Brief for the next turn. Runs after context gathering (so the
    // dossier + last assistant message are settled) and before buildPayload (so the Brief
    // can ride below the cache boundary in the final user message). Gated by
    // tierAllows(tier, 'directorBrief') — lite never calls. Graceful on timeout/abort/
    // parse-failure/any error: runDirectorBrief returns null and the turn continues with
    // just the watchdog nudge (buildPayload suppresses the nudge only when a Brief string
    // is actually passed). Computed once per (campaignId, userMessage) — a swipe/regenerate
    // with the same user input reuses the cached Brief. The cache is cleared on campaign
    // switch (invariant 7) — `clearDirectorBriefCache` is wired into setActiveCampaign.
    //
    // WO-05: the Director call's abort signal is `AbortSignal.any([outerSignal, skipSignal])`.
    // The outer `abortController` (whole-turn stop) still aborts the Director; the optional
    // `state.directorSkipController` (UI "Skip" button) aborts ONLY the Director. Either way
    // `runDirectorBrief` catches internally and returns null, so the turn proceeds. The
    // `onDirectorBriefPhase` callback toggles the UI's "Director drafting brief…" state.
    let directorBrief: string | null = null;
    if (tierAllows(settings.aiTier, 'directorBrief')) {
        const skipSignal = state.directorSkipController?.signal;
        const directorSignal = skipSignal
            ? AbortSignal.any([abortController.signal, skipSignal])
            : abortController.signal;
        callbacks.onDirectorBriefPhase?.('running');
        try {
            directorBrief = await runDirectorBrief({
                provider,
                dossierText: watchdogDossier.dossierText,
                lastAssistant: lastAssistantContent(facade?.data.messages ?? state.messages),
                userMessage: ctx.finalInput,
                npcLedger,
                onStageNpcIds: facade?.data.onStageNpcIds ?? state.onStageNpcIds,
                timeline: facade?.data.timeline ?? state.timeline,
                campaignId: facade?.data.activeCampaignId ?? state.activeCampaignId,
                getAuxiliaryProvider: facade ? undefined : state.getFreshAuxiliaryProvider,
                signal: directorSignal,
                maxTokens: blockTokenCap(
                    BUILTIN_IDS.directorBrief,
                    getBuiltinTokenCap(BUILTIN_IDS.directorBrief)?.default ?? 1500,
                    state.settings.moduleTokens,
                ),
                modelCall: facade && hasHostModelRole(facade, 'auxiliary')
                    ? (prompt, request) => facade.model.call('auxiliary', { prompt, ...request }).then(result => result.content)
                    : undefined,
            });
        } catch (err) {
            // Defensive: runDirectorBrief is expected to never throw (it catches
            // internally and returns null), but if a future refactor breaks that
            // contract we must not poison the turn. Log and proceed without a Brief.
            console.warn('[DirectorBrief] unexpected throw (suppressed):', err);
            directorBrief = null;
        } finally {
            callbacks.onDirectorBriefPhase?.('done');
        }
    }

    ctx.watchdogNudge = watchdogNudge;
    ctx.directorBrief = directorBrief ?? undefined;
}

// ── Stage 5b: runPromptInterception ──────────────────────────────────────
// Phase 5.2 — the pre-prompt / generation interceptor.
//
// THE FIRE POINT, and why it is here and nowhere else. The work order asks
// for "one well-defined point, before assembly, after the app knows the
// turn's inputs". This is it:
//
//   • AFTER `runDirectorStage`, because the Director Brief and the watchdog
//     nudge are turn inputs, and an interceptor that wants to suppress the
//     Brief has to know whether there is one.
//   • BEFORE `buildTurnPayload`, because assembly is where the arbiter runs
//     and the whole point is to hand it a bigger set of specs rather than to
//     reach into it. Nothing in `buildPayload` is reordered to make this
//     work — the 5.2 §5 stop condition, not fired.
//
// The stage NEVER throws. `runPromptInterceptors` contains every per-mod
// failure (throw, rejection, deadline, malformed return, mid-turn disable)
// as a surfaced fault and returns whatever the healthy interceptors produced,
// which may be nothing. The caller guards the call with
// `hasPromptInterceptors()`, so a zero-interceptor turn does not await at all.
export async function runPromptInterception(
    ctx: TurnContext,
    state: TurnState,
    facade?: HostFacade,
): Promise<void> {
    try {
        const result = await runPromptInterceptors({
            turnId: ctx.turnId,
            campaignId: (facade?.data.activeCampaignId ?? state.activeCampaignId) ?? null,
            tier: facade?.config.aiTier ?? state.settings.aiTier,
            // `ctx.finalInput`, not `ctx.input`: the interceptor sees the
            // string the prompt will carry, engine-roll and one-shot
            // injections included. `turn.start`'s `playerInput` is the raw
            // pre-injection text; the two differ on purpose (EVENTS.md §8.3).
            playerInput: ctx.finalInput,
            hasDirectorBrief: !!ctx.directorBrief,
            hasWatchdogNudge: !!ctx.watchdogNudge,
            hasAbsoluteCommand: !!state.absoluteCommand,
        });
        if (result) ctx.interception = result;
    } catch (err) {
        // Belt-and-braces. The registry is total by construction; a throw
        // here would mean the host itself is broken, and even then the turn
        // proceeds with the un-intercepted payload (5.2 §3).
        console.warn('[mods] prompt interception failed (suppressed):', err);
    }
}

// ── Stage 5c: runFactPublication ─────────────────────────────────────────
// Phase 5.4 — mod fact publishers run after the interceptor and before
// contributions are evaluated. The timing is the whole game: the facts
// must be settled before `buildTurnPayload` calls `buildPayload`, which
// builds the `facts` object that drives `evaluateWhen` on every mod's
// `when` conditions.
//
// THE FIRE POINT, and why it is here and nowhere else. The work order asks
// for "publish after the interceptor, before contributions are evaluated":
//
//   • AFTER `runPromptInterception`, because an interceptor may want to
//     read the same facts it influences (and the publication must not race
//     the interceptor's own reads).
//   • BEFORE `buildTurnPayload`, because `buildPayload` builds the
//     `facts` object at line 233 and passes it to the contribution
//     registry at line 244 — the merged facts must be available by then.
//
// The stage NEVER throws. `runFactPublishers` contains every per-mod
// failure (throw, mid-turn disable, ill-typed value) as a surfaced fault
// and returns whatever the healthy publishers produced, which may be
// nothing. The caller guards the call with `hasFactPublishers()`, so a
// zero-publisher turn does not even enter the stage.
export function runFactPublication(
    ctx: TurnContext,
): void {
    try {
        const result = runFactPublishers();
        if (result) ctx.publishedFacts = result;
    } catch (err) {
        // Belt-and-braces. The registry is total by construction; a throw
        // here would mean the host itself is broken, and even then the
        // turn proceeds with the host-computed facts only (5.4 §3).
        console.warn('[mods] fact publication failed (suppressed):', err);
    }
}

// ── Stage 6: buildTurnPayload ────────────────────────────────────────────
// Wraps buildPayload(options) (WO-P1-01 made it an options object). Stashes
// the assembled payload + trace + debugSections on the bus. Attaches the
// debug payload to the user message when debugMode is on. Sets up the
// pushToolTrace helper used by the generation stage's tool-call loop.
export function buildTurnPayload(
    ctx: TurnContext,
    state: TurnState,
    callbacks: TurnCallbacks,
): { liveTrace: PayloadTrace[]; pushToolTrace: (name: string, args: string, result: string) => void } {
    const { settings, context, messages, condenser, npcLedger, archiveIndex } = state;

    const payloadResult = buildPayload({
        settings,
        context,
        history: messages,
        userMessage: ctx.finalInput,
        condensedUpToIndex: condenser.condensedUpToIndex,
        relevantLore: ctx.gathered.relevantLore,
        npcLedger,
        archiveRecall: ctx.gathered.archiveRecall,
        recommendedNPCNames: ctx.gathered.recommendedNPCNames,
        semanticFactText: ctx.gathered.semanticFactText,
        archiveIndex,
        timelineEvents: ctx.gathered.timelineEvents,
        inventoryCategories: ctx.gathered.inventoryCategories as (import('../../types').InventoryItemCategory | 'equipped')[] | undefined,
        profileFields: ctx.gathered.profileFields as string[] | undefined,
        deepContextSummary: ctx.gathered.deepContextSummary,
        divergenceRegister: state.divergenceRegister,
        chapters: state.chapters,
        onStageNpcIds: state.onStageNpcIds,
        relevantRules: ctx.gathered.relevantRules,
        rulesManifest: ctx.gathered.rulesManifest,
        pinnedExcerpts: state.pinnedExcerpts,
        // plannerEventTypes omitted — recomputed inside buildWorld.
        locationLedger: ctx.locationLedger,
        nextTurnOocBrief: state.nextTurnOocBrief,
        watchdogNudge: ctx.watchdogNudge,
        directorBrief: ctx.directorBrief,
        absoluteCommand: state.absoluteCommand ?? undefined,
        elevatedScenes: ctx.gathered.elevatedScenes,
        slottedRagSnippets: ctx.gathered.slottedRagSnippets,
        relationshipStances: ctx.gathered.relationshipStances,
        // Phase 5.2 — the interceptor's blocks and suppressions for this turn.
        // `undefined` when no mod registered one, which is the byte-identical
        // zero-mod path (`buildPayload` then makes exactly the pre-5.2 calls).
        interception: ctx.interception,
        // Phase 5.4 — the mod-published facts overlay for this turn.
        // `undefined` when no mod registered a publisher, which is the
        // byte-identical zero-mod path.
        publishedFacts: ctx.publishedFacts,
    });

    ctx.payload = payloadResult.messages;
    ctx.payloadTrace = payloadResult.trace;
    ctx.payloadDebugSections = payloadResult.debugSections;

    // Phase 3.2 / `EVENTS.md` §6.3 — the last moment before the prompt is frozen
    // and sent. The payload BODY is never carried: a prompt body on the surface
    // is a `CONTRACT.md` permanent prohibition (§3).
    //
    // **Correction to `EVENTS.md` §6.3.** It says `tokenEstimate` is "summed
    // from `payloadResult.trace`, which is computed unconditionally… identical
    // with `debugMode` off". The trace is *collected* unconditionally but only
    // RETURNED when `debugMode` is on (`payloadBuilder.ts` — `trace: isDebug ?
    // collector.trace : undefined`), so a trace sum alone would be 0 for every
    // user with debug off. The fallback is the character/4 heuristic the repo
    // already uses for exactly this purpose (`pushToolTrace`, below) — the field
    // is `tokenEstimate`, not a token count. Recorded as a finding; no turn
    // stage was restructured (3.2 §6).
    //
    // Lazy because building it walks the payload: with no listeners this does
    // not run at all, which is what keeps the Phase 0.2 gate honest (§3).
    emitCoreEventLazy('turn.payloadBuilt', () => ({
        turnId: ctx.turnId,
        campaignId: state.activeCampaignId ?? null,
        messageCount: payloadResult.messages.length,
        tokenEstimate: payloadResult.trace?.length
            ? payloadResult.trace.reduce((sum, row) => sum + (row.tokens ?? 0), 0)
            : Math.round(payloadResult.messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0) / 4),
    }));

    const payload = payloadResult.messages;
    if (settings.debugMode && callbacks.setLastPayloadTrace) {
        callbacks.setLastPayloadTrace(payloadResult.trace);
    }

    // WO-I: tool calls fire after the snapshot above; append a row each time a tool result is
    // folded back into the payload and re-publish so the debug panel includes them too.
    const liveTrace: PayloadTrace[] = payloadResult.trace ? [...payloadResult.trace] : [];
    const pushToolTrace = (name: string, args: string, result: string) => {
        if (!settings.debugMode || !callbacks.setLastPayloadTrace) return;
        liveTrace.push({
            source: `Tool Call — ${name}`,
            classification: 'world_context',
            tokens: Math.round((args.length + result.length) / 4),
            reason: `Model called ${name}; result folded back into the payload`,
            included: true,
            position: 'tool',
            preview: `↳ ARGS:\n${args}\n\n↳ RESULT:\n${result}`,
        });
        callbacks.setLastPayloadTrace([...liveTrace]);
    };

    // Attach the debug payload to the user message we added earlier (memory-only, never persisted)
    if (settings.debugMode) {
        callbacks.updateLastMessage({ debugPayload: { sections: payloadResult.debugSections, raw: payload } });
    }

    return { liveTrace, pushToolTrace };
}

// ── Stage 7: runGenerationStage ──────────────────────────────────────────
// The gnarly one. Owns the recursive `executeTurn` closure + its
// function-scoped mutable state (`accumulatedContent`, `retryTimer`,
// `abortListener`). Per WO-P1-02 §4, the whole recursion moves as one unit
// — the state stays function-scoped here, NOT hoisted onto the bus.
export async function runGenerationStage(
    ctx: TurnContext,
    state: TurnState,
    callbacks: TurnCallbacks,
    abortController: AbortController,
    genDeps: {
        liveTrace: PayloadTrace[];
        pushToolTrace: (name: string, args: string, result: string) => void;
    },
): Promise<void> {
    const { context, loreChunks, provider } = state;
    // `runTurn` guards `!provider` before calling this stage, so the non-null
    // assertion here is safe. (Mirrors the pre-extraction narrowing that happened
    // at the top of `runTurn` after `if (!provider) return;`.)
    const providerSafe = provider!;
    const payload = ctx.payload!;

    // Smart Retry v1: capture the precontext snapshot BEFORE the Story AI runs.
    // The success-path capture at the end of `executeTurn`'s onDone (below) re-
    // captures with tool-call history + the fully-populated `ctx` bus — that
    // overwrite is idempotent by design and is what swipes 2–5 + the importance
    // rater depend on. DO NOT remove or "dedupe" that later capture: it carries
    // strictly richer state (tool history, complete ctx) than this early one.
    // This early capture is intentionally poorer — it exists ONLY so the
    // failure/abort path has something to retry from without regathering. The
    // 4th arg (ctx bus) is desktop-only; mobile's signature has no bus. The
    // failure path never commits, and success re-captures with the complete bus.
    capturePendingTurnSnapshot(state, payload, state.displayInput, ctx);

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const abortListener = () => {
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
    };
    abortController.signal.addEventListener('abort', abortListener);

    const stripLLMSceneHeader = (text: string): string =>
        text.replace(/^Scene\s*#\d+\s*\|?\s*/i, '');

    let accumulatedContent = '';
    const armed = state.armedRoll;

    const executeTurn = async (currentPayload: any[], toolCallCount = 0, apiRetryCount = 0, existingMsgId?: string) => {
        if (abortController.signal.aborted) return;

        const assistantMsgId = existingMsgId ?? uid();
        if (!existingMsgId) {
            callbacks.addMessage({ id: assistantMsgId, role: 'assistant' as const, content: '', timestamp: Date.now() });
        } else if (apiRetryCount > 0) {
            // Error retry: clear any error message shown in the bubble
            callbacks.updateLastAssistant('');
        }
        // Tool-call recursion (existingMsgId + apiRetryCount === 0): preserve existing content
        callbacks.setStreaming(true);

        const allowTools = toolCallCount < MAX_TOOL_CALLS_PER_TURN && apiRetryCount < 2;
        const requestPayload = sanitizePayloadForApi(currentPayload, allowTools, provider?.modelName);

        // Dice tool availability is decoupled from pool mode (diceFairnessActive).
        // Pool mode = pre-rolled numbers injected; tool mode = AI calls roll_dice on demand.
        // They are mutually exclusive: tool is available only when pool mode is OFF
        // (diceFairnessActive === false) and the player hasn't manually armed a roll.
        // When the player armed a manual roll, the resolved fact is already in the payload;
        // offering the tool too would let the model double-roll (WO-H).
        const allowDiceTool = context.diceFairnessActive === false && !armed;
        const tools = allowTools ? getToolDefinitions({ allowDiceTool }) : undefined;

        callbacks.setPipelinePhase?.('generating');
        callbacks.setLoadingStatus?.(null);
        await sendMessage(
            providerSafe,
            requestPayload,
            (fullText) => {
                callbacks.updateLastAssistant(
                    accumulatedContent
                        ? `${accumulatedContent}\n\n${stripLLMSceneHeader(fullText)}`
                        : stripLLMSceneHeader(fullText)
                );
            },
            async (finalText, toolCall, reasoningContent) => {
                if (toolCall && toolCallCount >= MAX_TOOL_CALLS_PER_TURN) {
                    console.warn(`[Turn] Tool-call cap (${MAX_TOOL_CALLS_PER_TURN}) reached — refusing tool call '${toolCall.name}' and treating model output as final answer.`);
                    toolCall = undefined;
                }
                const toolHandler = toolCall ? resolveToolHandler(toolCall.name) : null;
                if (toolCall && toolHandler) {
                    const toolName = toolCall.name;
                    // Lore tool signals the "checking notes" UI state — preserved verbatim from
                    // the pre-Phase-4 inline implementation. This is a UI concern owned by the
                    // orchestrator, not the registry handler.
                    if (toolName === 'query_campaign_lore') {
                        callbacks.setPipelinePhase?.('checking-notes');
                        callbacks.onCheckingNotes(true);
                    }

                    const engineText = stripLLMSceneHeader(finalText);
                    const dispatchResult = toolHandler({ arguments: toolCall.arguments, loreChunks, notebook: state.context.notebook, diceSystem: context.diceSystem });
                    if (dispatchResult.accumulation === 'overwrite') {
                        accumulatedContent = engineText;
                    } else {
                        accumulatedContent = accumulatedContent
                            ? `${accumulatedContent}\n\n${stripLLMSceneHeader(finalText)}`
                            : engineText;
                    }
                    callbacks.updateLastAssistant(accumulatedContent);

                    callbacks.updateLastAssistantMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolName, arguments: toolCall.arguments }
                        }],
                        ...(reasoningContent ? { reasoning_content: reasoningContent } : {})
                    });

                    currentPayload.push({
                        role: 'assistant',
                        content: engineText || "",
                        reasoning_content: reasoningContent || undefined,
                        tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolName, arguments: toolCall.arguments } }]
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    if (dispatchResult.traceResult) {
                        genDeps.pushToolTrace(toolName, toolCall.arguments, dispatchResult.toolResult);
                    }
                    if (dispatchResult.contextPatch) {
                        callbacks.updateContext(dispatchResult.contextPatch);
                    }
                    if (dispatchResult.proposal) {
                        callbacks.stageInventoryProposal?.(dispatchResult.proposal);
                    }

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: dispatchResult.toolResult,
                        timestamp: Date.now(),
                        name: toolName,
                        tool_call_id: toolCall.id,
                        ephemeral: true
                    });

                    currentPayload.push({
                        role: 'tool',
                        content: dispatchResult.toolResult,
                        name: toolName,
                        tool_call_id: toolCall.id
                    } as unknown as import('../chatEngine').OpenAIMessage);

                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        if (abortController.signal.aborted) return;
                        if (toolName === 'query_campaign_lore') {
                            callbacks.onCheckingNotes(false);
                            callbacks.setPipelinePhase?.('generating');
                        }
                        executeTurn(currentPayload, toolCallCount + 1, 0, assistantMsgId);
                    }, 800);
                    return;
                }

                callbacks.setStreaming(false);
                callbacks.onCheckingNotes(false);
                callbacks.setPipelinePhase?.('post-processing');
                const engineText = accumulatedContent
                    ? `${accumulatedContent}\n\n${stripLLMSceneHeader(finalText)}`
                    : stripLLMSceneHeader(finalText);

                // ── Swipe Generation v1 (per-variant scene-stakes strip) ──
                // mainApp accumulates tool-call preamble into engineText (unlike mobile,
                // which creates a new message per tool call). Strip the [[SCENE_STAKES]]
                // tag from the display text now and store the parsed stakes on the
                // SwipeVariant. The tag is removed from the bubble; classifySceneStakes
                // (LLM fallback) runs later at commit only when the variant had no tag.
                const { displayText: stakesStrippedText, stakes: parsedStakes } = extractAndStripSceneStakes(engineText);
                const tagPresent = engineText !== stakesStrippedText || parsedStakes !== 'calm';

                callbacks.updateLastAssistant(stakesStrippedText);
                // WO-3: attach the computed stance to the visible GM message only.
                // buildHistory/buildPayload read role/content explicitly, so this cannot reach the story model.
                if (ctx.gathered.relationshipStances && ctx.gathered.relationshipStances.length > 0) {
                    callbacks.updateLastAssistantMessage({
                        relationshipStances: ctx.gathered.relationshipStances,
                    });
                }
                // Only store reasoning_content when this is the FIRST (and only) response for this
                // assistant message — i.e. not a post-tool-call continuation. If accumulatedContent
                // is non-empty it means a tool call already ran and reasoning_content was already
                // stored on this message from that first response; overwriting it with the second
                // response's reasoning would corrupt the history and cause 400 on the next turn.
                if (reasoningContent && !accumulatedContent) {
                    callbacks.updateLastAssistantMessage({ reasoning_content: reasoningContent });
                }

                // ── Swipe Generation v1: stamp the swipe set + pendingCommit on the
                // latest GM message and capture the snapshot for lazy swipes + late commit.
                // runPostTurnPipeline + auto-condense are DEFERRED to commitPendingTurn
                // (called by the next send / Arc Injector / campaign switch).
                //
                // NOTE: use `updateLastAssistantMessage` (scans back to the last
                // assistant), NOT `updateLastMessage` (literal last message). After a
                // tool call, the literal last message is the tool message — desktop
                // reuses the same assistant id across tool iterations instead of
                // pushing a fresh bubble per call like mobile does, so the literal
                // `updateLastMessage` would stamp the swipe set on the tool message,
                // the assistant bubble would never get it, the swipe UI would
                // silently disappear, and `findPendingCommitMessage` would return
                // null so `commitPendingTurn` would no-op and the post-turn pipeline
                // (archive/timeline/NPC bookkeeping) would silently skip the turn.
                const variant: SwipeVariant = {
                    id: uid(),
                    text: stakesStrippedText,
                    reasoningContent: reasoningContent || undefined,
                    sceneStakes: parsedStakes,
                    tagPresent,
                };
                callbacks.updateLastAssistantMessage({
                    swipeSet: [variant],
                    pendingCommit: true,
                    swipeActiveIndex: 0,
                });

                // Capture the snapshot for lazy swipes (cached payload with tool history)
                // and for the late-commit path (frozen messages window for the importance
                // rater — it must read the snapshot, never live getMessages()).
                // WO-P1-03: pass the bus so it is carried across the commit boundary by
                // the snapshot. The post-turn pipeline reads bus fields from it instead
                // of reaching into getState() (thread-only — does NOT rewrite what
                // post-turn computes; that's Project 4's memory port).
                //
                // Smart Retry v1: this is the SECOND capture — there is an earlier,
                // deliberately poorer one at the top of runGenerationStage (pre-Story-AI)
                // that exists only so the failure path can retry without regathering.
                // This call overwrites it with the richer payload (tool-call history +
                // complete ctx). DO NOT remove either capture — the two are redundant by
                // design. See the comment at the early capture site for the full rationale.
                capturePendingTurnSnapshot(state, currentPayload, state.displayInput, ctx);

                // Durable-commit v1: flush the pending turn to disk immediately.
                // The stamp above rides `updateLastAssistantMessage`, which schedules
                // no save, and the deferred commit can be minutes or hours away — so
                // without this the pending markers lived only in memory. A crash /
                // improper close / idle timeout before the next store write left the
                // GM text on disk with no `pendingCommit`, nothing for the launch
                // reconciler to find, and the scene silently never archived.
                callbacks.persistTurnState?.();

                // Phase 3.2 / `EVENTS.md` §6.3 — the terminal success branch,
                // immediately after `persistTurnState()`: a listener runs only
                // once the turn is recoverable on disk. `text` is carried
                // because from this instant the message is mutable — swipe,
                // edit and continue all overwrite it.
                emitCoreEvent('turn.generated', {
                    turnId: ctx.turnId,
                    campaignId: state.activeCampaignId ?? null,
                    messageId: assistantMsgId,
                    text: stakesStrippedText,
                    sceneStakes: parsedStakes,
                });

                callbacks.setPipelinePhase?.('idle');
                abortController.signal.removeEventListener('abort', abortListener);
            },
            (err) => {
                const isUserAbort = abortController.signal.aborted
                    || err === 'AbortError'
                    || err === 'The user aborted a request.'
                    || (typeof err === 'string' && err.includes('abort'));

                if (isUserAbort) {
                    // Smart Retry v1: user pressed Stop. Stamp the (partial) terminal
                    // assistant bubble as retryable so the Retry button renders. The
                    // early-captured snapshot (pre-Story-AI) is still in memory and
                    // can re-enter executeTurn without regathering.
                    stampRetryable(callbacks, assistantMsgId, ctx.gathered);
                    callbacks.setStreaming(false);
                    callbacks.onCheckingNotes(false);
                    callbacks.setLoadingStatus?.(null);
                    callbacks.setPipelinePhase?.('idle');
                    // Phase 3.2 / `EVENTS.md` §6.3 — the `isUserAbort` terminal
                    // branch, after `setPipelinePhase('idle')`, before the abort
                    // listener is detached.
                    emitCoreEvent('turn.aborted', {
                        turnId: ctx.turnId,
                        campaignId: state.activeCampaignId ?? null,
                        messageId: assistantMsgId,
                    });
                    abortController.signal.removeEventListener('abort', abortListener);
                    return;
                }

                const currentAssistantContent = state.getMessages().find(m => m.id === assistantMsgId)?.content || '';

                if (apiRetryCount === 0) {
                    if (!currentAssistantContent) {
                        callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying...`);
                    }
                    toast.warning('LLM request failed — retrying...');
                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        if (abortController.signal.aborted) return;
                        executeTurn(currentPayload, toolCallCount, 1, assistantMsgId);
                    }, 2000);
                } else if (apiRetryCount === 1) {
                    if (!currentAssistantContent) {
                        callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying without tools...`);
                    }
                    toast.warning('Retry failed — trying without tools...');
                    retryTimer = setTimeout(() => {
                        retryTimer = null;
                        if (abortController.signal.aborted) return;
                        executeTurn(currentPayload, 999, 2, assistantMsgId);
                    }, 4000);
                } else {
                    if (!currentAssistantContent) {
                        callbacks.updateLastAssistant(`⚠️ Error: ${err}`);
                    }
                    toast.error('LLM request failed after retries');
                    // Smart Retry v1: final retry exhaustion — stamp retryable so the
                    // user can retry from the cached precontext without regathering.
                    // Do NOT stamp on the intermediate retry branches (apiRetryCount 0
                    // and 1) — those are still in flight.
                    stampRetryable(callbacks, assistantMsgId, ctx.gathered);
                    callbacks.setStreaming(false);
                    callbacks.onCheckingNotes(false);
                    callbacks.setLoadingStatus?.(null);
                    callbacks.setPipelinePhase?.('idle');
                    // Phase 3.2 / `EVENTS.md` §6.3 — the retry-exhausted terminal
                    // branch ONLY. The two intermediate retry branches above are
                    // still in flight and emit nothing: a mod must not see three
                    // "failures" for one turn.
                    emitCoreEvent('turn.failed', {
                        turnId: ctx.turnId,
                        campaignId: state.activeCampaignId ?? null,
                        messageId: assistantMsgId,
                        reason: String(err),
                    });
                    abortController.signal.removeEventListener('abort', abortListener);
                }
            },
            tools ? [...tools] : undefined,
            abortController,
            state.sampling,
            (state.provider as EndpointConfig).thinkingEffort as ThinkingEffort | undefined
        );
    };

    await executeTurn(payload);
}
