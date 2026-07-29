import type { AppSettings, ChatMessage, GameContext, LoreChunk, NPCEntry, EnemyEntry, EnemyInstance, EnemyEncounter, EnemyCombatConfig, ArchiveScene, ArchiveIndexEntry, PayloadTrace, TimelineEvent, DebugSection, InventoryItemCategory, DivergenceRegister, ArchiveChapter, PinnedExcerpt, SceneEventType, LocationEntry } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { createTraceCollector } from './traceCollector';
import { computeBudgets } from './budgets';
import { buildStable } from './stable';
import { buildWorld } from './world';
import { buildVolatile } from './volatile';
import { buildHistory } from './history';
import { buildPinnedMemoriesBlock } from './pinnedMemories';
import { countTokens } from '../infrastructure/tokenizer';
import { assembleContributions } from './contributions/assemble';
import { createFinalUserRegistryWithExtensions } from './contributions/extensions';
import type { FinalUserModuleInput } from './contributions/builtins';
import type { ContributionRegistry } from './contributions/registry';
import type { ElevatedScene } from '../archive-memory/dynamicElevation';
import type { SlottedRagSnippet } from '../archive-memory/slottedRag';
import { buildRelevantEnemyBlock } from '../enemy/enemyPrompt';
import { buildActiveEncounterBlock } from '../enemy/enemyEncounter';

export type BuildPayloadOptions = {
    settings: AppSettings;
    context: GameContext;
    history: ChatMessage[];
    userMessage: string;
    condensedUpToIndex?: number;
    relevantLore?: LoreChunk[];
    npcLedger?: NPCEntry[];
    enemyCompendium?: EnemyEntry[];
    enemyInstances?: EnemyInstance[];
    enemyEncounters?: EnemyEncounter[];
    enemyCombatConfig?: EnemyCombatConfig;
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
    /** Absolute Command v1: binding out-of-character player instruction for THIS turn only.
     *  When present, GM_REMINDER and the watchdog nudge are omitted, the CoT invocation line
     *  is swapped for a subordination line, and the command block is placed LAST — after
     *  userMessage — for maximum recency. Never enters chat history. */
    absoluteCommand?: string;
    /** Project 2: registry of final-user contributions. Defaults to built-ins only.
     *  Callers supply their own once mods can be loaded, so `buildPayload` never learns
     *  what a mod is. */
    finalUserRegistry?: ContributionRegistry<FinalUserModuleInput>;
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
        enemyCompendium,
        enemyInstances,
        enemyEncounters,
        enemyCombatConfig,
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
        nextTurnOocBrief,
        watchdogNudge,
        directorBrief,
        elevatedScenes,
        slottedRagSnippets,
        absoluteCommand,
        finalUserRegistry,
    } = options;
    const isDebug = settings.debugMode === true;
    const limit = settings.contextLimit || 8192;
    const collector = createTraceCollector(isDebug);
    const { rulesBudget, budgetMap } = computeBudgets(limit, settings.rulesBudgetPct, !!deepContextSummary);
    const { stableContent, stableTokens, retrievedRulesContent } = buildStable({ settings, context, relevantRules, rulesManifest, rulesBudget, budgetStable: budgetMap.stable, collector });
    const { worldContent, currentWorldTokens, divergenceContent, divergenceTokens, plannerEventTypes: resolvedEventTypes } = buildWorld({ history, userMessage, condensedUpToIndex, relevantLore, npcLedger, archiveRecall, recommendedNPCNames, semanticFactText, archiveIndex, timelineEvents, deepContextSummary, divergenceRegister, chapters, onStageNpcIds, loreRaw: context.loreRaw, agencyDigest: context.agencyDigest, arcDigest: context.arcDigest, budgetWorld: budgetMap.world, npcBudgetFloor: budgetMap.npc, plannerEventTypes, matureMode: settings.matureMode, isDebug, collector, elevatedScenes, slottedRagSnippets });
    const { volatileContent, volatileTokens } = buildVolatile({ context, inventoryCategories, profileFields, budgetVolatile: budgetMap.volatile, collector, plannerEventTypes: resolvedEventTypes, userMessage, history, npcLedger, locationLedger });
    const enemyContextEnabled = enemyCombatConfig?.promptContextEnabled !== false;
    const activeEncounterBlock = enemyContextEnabled
        ? buildActiveEncounterBlock(enemyEncounters, enemyInstances, enemyCombatConfig, budgetMap.enemy)
        : '';
    const enemyBlock = activeEncounterBlock || (enemyContextEnabled
        ? buildRelevantEnemyBlock(enemyCompendium, history, userMessage, budgetMap.enemy)
        : '');
    const enemyTokens = countTokens(enemyBlock);
    if (enemyBlock) {
        collector.addTrace({
            source: activeEncounterBlock ? 'Active Enemy Encounter' : 'Enemy Compendium',
            classification: 'volatile_state',
            tokens: enemyTokens,
            reason: `Priority-trimmed enemy context (budget ${budgetMap.enemy} tokens)`,
            included: true,
            position: 'user',
            preview: enemyBlock,
        });
    }
    const fitted = buildHistory({
        history,
        condensedUpToIndex,
        userMessage,
        limit,
        stableTokens: stableTokens + divergenceTokens,
        currentWorldTokens,
        volatileTokens: volatileTokens + enemyTokens,
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
    const volatileBlock = [retrievedRulesContent, worldContent, enemyBlock, volatileContent].filter(Boolean).join('\n\n');

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
    const facts = {
        onStageNpcNames: onStageNpcIds
            ?.map((id) => npcLedger?.find((n) => n.id === id)?.name)
            .filter((name): name is string => !!name),
        location: context.currentPlaceId
            ? locationLedger?.find((l) => l.id === context.currentPlaceId)?.name
            : undefined,
        inCombat: activeEncounterBlock !== '',
    };

    const registry = finalUserRegistry ?? createFinalUserRegistryWithExtensions();
    const contributions = registry.collect(
        {
            settings,
            userMessage,
            volatileBlock,
            directorBrief,
            watchdogNudge,
            absoluteCommand,
            nextTurnOocBrief,
            facts,
        },
        // Enablement rides on `settings` (already threaded everywhere `buildPayload` is called),
        // so wiring the extensions screen to the prompt needed no call-site changes at all.
        // Absent key = enabled, so an empty/missing map is exactly today's behaviour.
        settings.moduleEnabled
            ? { isEnabled: (id) => settings.moduleEnabled?.[id] !== false }
            : undefined,
    );
    const assembled = assembleContributions(contributions);

    messages.push({ role: 'user', content: assembled.text });

    for (const contributionTrace of assembled.traces) collector.addTrace(contributionTrace);

    return { messages, trace: isDebug ? collector.trace : undefined, debugSections: isDebug ? collector.debugSections : undefined };
}
