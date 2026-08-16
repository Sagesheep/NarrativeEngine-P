import type { AppSettings, ChatMessage, GameContext, LoreChunk, NPCEntry, ArchiveScene, ArchiveIndexEntry, PayloadTrace, TimelineEvent, DebugSection, InventoryItemCategory, DivergenceRegister, ArchiveChapter, PinnedExcerpt, SceneEventType, LocationEntry, RelationshipStance } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { createTraceCollector } from './traceCollector';
import { computeBudgets } from './budgets';
import { buildStable } from './stable';
import { buildWorld } from './world';
import { buildVolatile } from './volatile';
import { buildHistory } from './history';
import { buildPinnedMemoriesBlock } from './pinnedMemories';
import { composeVolatileBlock, renderVolatileSegments, type VolatileSegment } from './volatileSegments';
import { assembleContributions } from './contributions/assemble';
import { createFinalUserRegistryWithExtensions } from './contributions/extensions';
import type { FinalUserModuleInput } from './contributions/builtins';
import type { ContributionRegistry } from './contributions/registry';
import type { ContributionSpec } from './contributions/types';
import type { ModFacts } from '../mods/modTypes';
import type { FactPublicationResult } from '../mods/facts';
import type { ElevatedScene } from '../archive-memory/dynamicElevation';
import type { SlottedRagSnippet } from '../archive-memory/slottedRag';
import { isBlockEnabled } from '../turn/blockEnablement';
import { BUILTIN_IDS } from './contributions/builtins';
import { interceptorFaultStore, formatInterceptorFaultReason } from '../mods/interceptors/interceptorFaults';
import { RELATIONSHIP_STANCE_TOKEN_BUDGET } from '../npc/relationshipStance';

export type BuildPayloadOptions = {
    settings: AppSettings;
    context: GameContext;
    history: ChatMessage[];
    userMessage: string;
    condensedUpToIndex?: number;
    relevantLore?: LoreChunk[];
    npcLedger?: NPCEntry[];
    archiveRecall?: ArchiveScene[];
    recommendedNPCNames?: string[];
    semanticFactText?: string;
    archiveIndex?: ArchiveIndexEntry[];
    timelineEvents?: TimelineEvent[];
    inventoryCategories?: (InventoryItemCategory | 'equipped')[];
    profileFields?: string[];
    deepContextSummary?: string;
    divergenceRegister?: DivergenceRegister;
    chapters?: ArchiveChapter[];
    onStageNpcIds?: string[];
    relevantRules?: LoreChunk[];
    rulesManifest?: string;
    pinnedExcerpts?: PinnedExcerpt[];
    plannerEventTypes?: SceneEventType[];
    locationLedger?: LocationEntry[];
    /** Travel facts already supplied to the Director; debug-only visibility in
     * the payload trace, never additional GM payload text. */
    directorWorldFacts?: string[];
    /** User-confirmed session-only guidance, excluded from canonical chat history. */
    nextTurnOocBrief?: string;
    /** Director Watchdog nudge (WO-03): highest-priority deterministic signal from
     *  `buildWatchdogDossier`, surfaced as a [STAGE NOTE] adjacent to GM_REMINDER in
     *  the final user message (below the cache boundary). Suppressed when a Director
     *  Brief is present — the Brief supersedes it (WO-04 wires the actual value). */
    watchdogNudge?: string;
    /** Director Brief (WO-04): when provided, rendered as a [DIRECTOR BRIEF] block
     *  placed BEFORE GM_REMINDER in the final user message (below the cache boundary).
     *  Supersedes `watchdogNudge` (the deterministic nudge is omitted when the Brief
     *  is present — the Brief carries the same intent with LLM-authored directives). */
    directorBrief?: string;
    /** WO-11: synopsis-tier scenes elevated verbatim below the cache boundary for
     *  this turn only. Each carries a chapterId for the labeled rendering in world.ts. */
    elevatedScenes?: ElevatedScene[];
    /** WO-12: Slotted RAG — one-line snippets from synopsis-tier scenes that had
     *  search hits but did NOT get elevated. Reuses WO-11's scoped search results
     *  (one search, two consumers); no second vector search. Witness-filtered. */
    slottedRagSnippets?: SlottedRagSnippet[];
    /** WO-5: scene-specific relationship readings rendered as a final-user contribution. */
    relationshipStances?: readonly RelationshipStance[];
    /** Absolute Command v1: binding out-of-character player instruction for THIS turn only.
     *  When present, GM_REMINDER and the watchdog nudge are omitted, the CoT invocation line
     *  is swapped for a subordination line, and the command block is placed LAST — after
     *  userMessage — for maximum recency. Never enters chat history. */
    absoluteCommand?: string;
    /** Project 2: registry of final-user contributions. Defaults to built-ins only.
     *  Callers supply their own once mods can be loaded, so `buildPayload` never learns
     *  what a mod is. */
    finalUserRegistry?: ContributionRegistry<FinalUserModuleInput>;
    /** Phase 7.5: subsystem-rendered segments folded into the composed volatile block.
     *
     *  Each carries `{ id, order, render }` and nothing else, so `buildPayload` never
     *  learns which feature produced one — the same discipline `interception` and
     *  `finalUserRegistry` follow. A segment's `id` is also its budget claim id, so an
     *  unclaimed budget and an absent block are one event (`volatileSegments.ts`).
     *
     *  Absent (the zero-segment case) means the composed block is
     *  `[rules, world, state]` exactly as it was before this option existed, which is
     *  what keeps the Phase 0.2 gate byte-identical. */
    volatileSegments?: readonly VolatileSegment[];
    /** Phase 5.2: the pre-prompt interceptor's result for THIS turn, already validated
     *  and namespaced by the mod layer. Specs are appended to what the registry collected;
     *  suppression is handed to the arbiter alongside the specs' own `suppresses`.
     *
     *  The dependency direction is unchanged: this is a `ContributionSpec[]` plus an
     *  `(id, by)` list, so `buildPayload` still has no idea what a mod is — exactly as with
     *  `finalUserRegistry`. Absent (the zero-interceptor case) means both calls below are
     *  byte-identical to the pre-5.2 ones, which is what keeps the Phase 0.2 gate green. */
    interception?: {
        readonly specs?: readonly ContributionSpec[];
        readonly suppress?: readonly { readonly id: string; readonly by: string }[];
    };
    /** Phase 5.4: the mod-published facts overlay for THIS turn, already
     *  validated and type-checked by the fact registry. A claimed core fact
     *  (e.g. `inCombat`) overrides the host-computed value; a namespaced
     *  mod fact is not read by `evaluateWhen` today.
     *
     *  The dependency direction is unchanged: `buildPayload` receives a
     *  `Partial<ModFacts>` overlay and merges it onto the host-computed
     *  facts, so `buildPayload` still has no idea what a mod is. Absent
     *  (the zero-publisher case) means the host facts are used as-is, which
     *  is byte-identical to the pre-5.4 path and keeps the Phase 0.2 gate
     *  green. */
    publishedFacts?: FactPublicationResult;
};

export function buildPayload(options: BuildPayloadOptions): { messages: OpenAIMessage[]; trace?: PayloadTrace[]; debugSections?: DebugSection[] } {
    const {
        settings,
        context,
        history,
        userMessage,
        condensedUpToIndex,
        relevantLore,
        npcLedger,
        archiveRecall,
        recommendedNPCNames,
        semanticFactText,
        archiveIndex,
        timelineEvents,
        inventoryCategories,
        profileFields,
        deepContextSummary,
        divergenceRegister,
        chapters,
        onStageNpcIds,
        relevantRules,
        rulesManifest,
        pinnedExcerpts,
        plannerEventTypes,
        locationLedger,
        directorWorldFacts,
        nextTurnOocBrief,
        watchdogNudge,
        directorBrief,
        elevatedScenes,
        slottedRagSnippets,
        relationshipStances,
        absoluteCommand,
        finalUserRegistry,
        interception,
        publishedFacts,
        volatileSegments,
    } = options;
    const isDebug = settings.debugMode === true;
    const limit = settings.contextLimit || 8192;
    const collector = createTraceCollector(isDebug);
    // Phase 7.4 — the budget map is keyed by claim id, not by feature name.
    // `computeBudgets` runs every registered claim (core's four structural
    // ones plus whatever a subsystem or a mod claimed) and returns a
    // `BudgetMap` whose `get(id)` returns the allocation. An unregistered id
    // returns `0` — the absent-means-zero contract — which is how a claim
    // going away stays quiet here (Phase 7.5 §3). The four ids read below are
    // core's own structural parts; every other allocation is resolved through
    // a segment's id, so this file names no feature.
    const { rulesBudget, budgetMap } = computeBudgets(limit, settings.rulesBudgetPct, !!deepContextSummary);
    const stableBudget = budgetMap.get('stable');
    const worldBudget = budgetMap.get('world');
    const volatileBudget = budgetMap.get('volatile');
    const npcFloor = budgetMap.get('npc');
    const { stableContent, stableTokens, retrievedRulesContent } = buildStable({ settings, context, relevantRules, rulesManifest, rulesBudget, budgetStable: stableBudget, collector });
    const { worldContent, currentWorldTokens, divergenceContent, divergenceTokens, plannerEventTypes: resolvedEventTypes, relationsBlock } = buildWorld({ history, userMessage, condensedUpToIndex, relevantLore, npcLedger, archiveRecall, recommendedNPCNames, semanticFactText, archiveIndex, timelineEvents, deepContextSummary, divergenceRegister, chapters, onStageNpcIds, loreRaw: context.loreRaw, agencyDigest: context.agencyDigest, arcDigest: context.arcDigest, budgetWorld: worldBudget, npcBudgetFloor: npcFloor, plannerEventTypes, matureMode: settings.matureMode, isDebug, collector, elevatedScenes, slottedRagSnippets, relationshipMemoryEnabled: context.relationshipMemory === true });
    const { volatileContent, volatileTokens } = buildVolatile({ context, inventoryCategories, profileFields, budgetVolatile: volatileBudget, collector, plannerEventTypes: resolvedEventTypes, userMessage, history, npcLedger, locationLedger, directorWorldFacts, directorBrief });
    // Phase 7.5 — subsystem segments. `buildPayload` hands each one its budget
    // (resolved by the segment's own id) plus the two relevance inputs, and
    // gets back text, an optional trace and any facts the segment establishes.
    // Nothing here knows what a segment renders. Zero segments is the quiet
    // path: no text, no trace, no fact, no error.
    const renderedSegments = renderVolatileSegments(volatileSegments, (segmentId) => ({
        budget: budgetMap.get(segmentId),
        history,
        userMessage,
    }));
    const segmentTokens = renderedSegments.reduce((sum, segment) => sum + segment.tokens, 0);
    for (const segment of renderedSegments) {
        if (!segment.trace || !segment.text) continue;
        collector.addTrace({
            source: segment.trace.source,
            classification: segment.trace.classification,
            tokens: segment.tokens,
            reason: segment.trace.reason,
            included: true,
            position: 'user',
            preview: segment.text,
        });
    }
    const fitted = buildHistory({
        history,
        condensedUpToIndex,
        userMessage,
        limit,
        stableTokens: stableTokens + divergenceTokens,
        currentWorldTokens,
        volatileTokens: volatileTokens + segmentTokens,
        context,
        collector,
        // WO-09: plumb the existing `chapters`, `archiveIndex`, `onStageNpcIds`
        // params (already in buildPayload's signature) plus the two LOD knobs.
        chapters,
        archiveIndex,
        onStageNpcIds,
        lodSummaryChapters: settings.lodSummaryChapters,
        lodImportanceBonus: settings.lodImportanceBonus,
    });

    // --- 8. Final Assembly ---
    // Stable, divergence, and pinned blocks get cache_control: ephemeral for Anthropic prompt caching.
    // These blocks change infrequently across turns, making them ideal cache hit candidates.
    const cacheControl = { type: 'ephemeral' as const };
    const messages: OpenAIMessage[] = [];
    if (stableContent) messages.push({ role: 'system', content: stableContent, cache_control: cacheControl });
    if (divergenceContent) messages.push({ role: 'system', content: divergenceContent, cache_control: cacheControl });
    if (pinnedExcerpts && pinnedExcerpts.length > 0) {
        messages.push({ role: 'system', content: buildPinnedMemoriesBlock(pinnedExcerpts), cache_control: cacheControl });
    }

    // Push history BEFORE the volatile block so the growing campaign log rides in the cached prefix.
    messages.push(...fitted);

    // Stamp cache_control: ephemeral on the last history message so prefix-caching covers all of history.
    // WO-09b: widened the role check from `user || assistant` to `system || user || assistant` so
    // the LOD-only history shape (every chat message at or before `condensedUpToIndex` → `fitted`
    // contains only the LOD `system` message) still lands a cache breakpoint. Without this, the
    // LOD block would be emitted after the prior breakpoint but receive none itself, falling outside
    // the cached prefix. The final volatile user message is appended below and is never stamped here.
    //
    // WO-09c §1: `tool`-role history messages are intentionally NOT stamped here — tool-role
    // stamping was not authorized by WO-09/09b/09c (not a type-capability issue: the internal
    // OpenAIMessage type can carry cache_control on any role). Tool-message caching is out of
    // scope and left for a separate design decision. The Claude wire transform preserves any
    // marker already placed on `system`/`user`/`assistant` messages; unstamped messages (including
    // all `tool` messages) keep their current wire shapes.
    if (fitted.length > 0) {
        const last = messages.length - 1;
        const lastMsg = messages[last];
        if (lastMsg.role === 'system' || lastMsg.role === 'user' || lastMsg.role === 'assistant') {
            messages[last] = { ...lastMsg, cache_control: { type: 'ephemeral' } };
        }
    }

    // Fold the per-turn volatile world/NPC block and the GM reminder into the final user message
    // (below the cache boundary) so they never perturb the cached prefix.
    // RAG-retrieved rules are per-turn dynamic (re-selected by semantic match to user input),
    // so they ride in the volatile block below the cache boundary — not in stable. Mirrors
    // mobileApp. Only verbatim full-rules fallback stays in stable (byte-identical across turns).
    // Phase 7.5 — the composition is ordered rather than hand-written: core's
    // three parts sit at their published anchors (100 / 200 / 400) and any
    // segment sorts among them by its declared `order`. With no segments this
    // is byte-identical to the old `[rules, world, volatile]` expression.
    const volatileBlock = composeVolatileBlock(
        { rules: retrievedRulesContent, world: worldContent, state: volatileContent },
        renderedSegments,
    );

    // Project 2 / WO-P2-02: the final user message is assembled by the contribution registry
    // rather than a hand-written array. Every block that used to be open-coded here — the
    // volatile block, the CoT invocation line, the Director Brief, GM_REMINDER, the watchdog
    // nudge, the Ask-GM handoff, the player's message, and the Absolute Command — is now a
    // registered module in `contributions/builtins.ts`, and the precedence rules that used to
    // be inline conditionals (`hasAbsolute ? '' : ...`, `!directorBrief && !hasAbsolute`) are
    // declared as `suppresses` on the contributions that win.
    //
    // Ordering, suppression, and the emitted traces are unchanged — `finalUserAssemblyGolden`
    // replicates the old inline expression as an oracle and compares across every combination
    // of the flags that drove it. Everything here still lands BELOW the cache boundary, so the
    // cached prefix assembled above is untouched.
    // Condition facts for mod contributions. Derived only from data already resolved above —
    // no extra work on the turn path. `location` reuses the same `currentPlaceId` → ledger
    // resolution that `buildLocationBlock` performs, so a mod and the [LOCATION] block can
    // never disagree about where the scene is.
    const facts: ModFacts = {
        onStageNpcNames: onStageNpcIds
            ?.map((id) => npcLedger?.find((n) => n.id === id)?.name)
            .filter((name): name is string => !!name),
        location: context.currentPlaceId
            ? locationLedger?.find((l) => l.id === context.currentPlaceId)?.name
            : undefined,
        // Phase 7.5 — `inCombat` used to be derived here from whether a
        // feature's rendered text came out non-empty. It is now a
        // default that a segment may override below. With no segment the value
        // is `false`, which is 5.4's "absence stays false" rule holding by
        // construction rather than by a conditional.
        inCombat: false,
    };

    // Phase 7.5 — facts established by subsystem segments. Merged key-by-key
    // and name-blind (`Object.entries`, no `if (key === …)`), skipping
    // `undefined` so a segment with no opinion leaves the host default alone.
    // Applied BEFORE the mod overlay below, so a mod that claims a fact still
    // wins over the subsystem that computed it — the precedence 5.4 declared.
    for (const segment of renderedSegments) {
        if (!segment.facts) continue;
        for (const [key, value] of Object.entries(segment.facts)) {
            if (value !== undefined) (facts as Record<string, unknown>)[key] = value;
        }
    }

    // Phase 5.4 — merge the mod-published facts overlay. A claimed core
    // fact overrides both the host default and any segment value. The
    // overlay only contains keys a mod actually
    // published; absent keys fall through to the host value, preserving
    // "absence stays false" exactly (`modAdapter.ts:evaluateWhen` is
    // unchanged). `undefined` in the overlay means "no opinion this turn"
    // and does NOT overwrite the host value (the registry skips `undefined`
    // returns, so this branch is belt-and-braces).
    if (publishedFacts) {
        const overlay = publishedFacts.facts;
        if (overlay.inCombat !== undefined) facts.inCombat = overlay.inCombat;
        if (overlay.location !== undefined) facts.location = overlay.location;
        if (overlay.sceneTags !== undefined) facts.sceneTags = overlay.sceneTags;
        if (overlay.onStageNpcNames !== undefined) facts.onStageNpcNames = overlay.onStageNpcNames;
    }

    const relationshipStanceBudget = relationshipStances && relationshipStances.length > 0
        ? Math.min(
            relationshipStances.reduce((sum, stance) => sum + RELATIONSHIP_STANCE_TOKEN_BUDGET[stance.tier], 0),
            npcFloor,
        )
        : undefined;
    const registry = finalUserRegistry ?? createFinalUserRegistryWithExtensions();
    const contributions = registry.collect(
        {
            settings,
            userMessage,
            volatileBlock,
            relationsBlock,
            relationshipStances,
            relationshipStanceBudget,
            directorBrief,
            watchdogNudge,
            absoluteCommand,
            nextTurnOocBrief,
            facts,
        },
        // Enablement rides on `settings` (already threaded everywhere `buildPayload` is called),
        // so wiring the extensions screen to the prompt needed no call-site changes at all.
        // Resolved through `isBlockEnabled`: explicit moduleEnabled entry wins, else the tier
        // preset, else enabled (the absent-means-enabled convention for contributions).
        { isEnabled: (id) => isBlockEnabled(id, settings.aiTier, settings.moduleEnabled) },
    );

    // Phase 5.2 — the interceptor's blocks join the collected ones and go
    // through the SAME arbiter: ordering, budget trimming, suppression and
    // tracing are one implementation, not two. They are appended rather than
    // prepended because `order` decides position, not array index — appending
    // only fixes the tie-break, and a mod losing a tie to a built-in is the
    // right default.
    //
    // Everything here still lands in the `final-user` slot, BELOW the cache
    // boundary, so the prefix assembled above cannot move
    // (`payloadCacheStability.test.ts` is the guard and it stays green with
    // interceptors registered and firing).
    const withInterception = interception?.specs?.length
        ? [...contributions, ...interception.specs]
        : contributions;
    const assembled = assembleContributions(
        withInterception,
        interception?.suppress?.length ? { suppress: interception.suppress } : undefined,
    );

    // A mod may suppress the stance contribution, but that omission must be visible in the
    // existing Extensions fault surface rather than silently reverting to scalar relationship
    // numbers. The shared arbiter remains feature-name-blind; this is the host-facing disclosure
    // at the payload boundary.
    for (const suppression of assembled.suppressed) {
        if (suppression.id !== BUILTIN_IDS.stance || !suppression.by.startsWith('mod.')) continue;
        const modId = suppression.by.slice('mod.'.length);
        interceptorFaultStore.add({
            modId,
            file: `mod:${modId}`,
            kind: 'suppressed',
            id: suppression.id,
            reason: formatInterceptorFaultReason({ modName: modId, kind: 'suppressed', id: suppression.id }),
        });
    }

    messages.push({ role: 'user', content: assembled.text });

    for (const contributionTrace of assembled.traces) collector.addTrace(contributionTrace);

    return { messages, trace: isDebug ? collector.trace : undefined, debugSections: isDebug ? collector.debugSections : undefined };
}
