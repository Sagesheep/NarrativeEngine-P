import type { AppSettings, ChatMessage, GameContext, LoreChunk, NPCEntry, EnemyEntry, EnemyInstance, EnemyEncounter, ArchiveScene, ArchiveIndexEntry, PayloadTrace, TimelineEvent, DebugSection, InventoryItemCategory, DivergenceRegister, ArchiveChapter, PinnedExcerpt, SceneEventType, LocationEntry } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { createTraceCollector } from './traceCollector';
import { computeBudgets } from './budgets';
import { buildStable, isThinkingEnabled } from './stable';
import { buildWorld } from './world';
import { buildVolatile } from './volatile';
import { buildHistory } from './history';
import { buildPinnedMemoriesBlock } from './pinnedMemories';
import { formatAskGmBrief } from '../ooc/askGmHandoff';
import { buildAbsoluteCommandBlock } from '../turn/absoluteCommand';
import { countTokens } from '../infrastructure/tokenizer';
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
    } = options;
    const isDebug = settings.debugMode === true;
    const limit = settings.contextLimit || 8192;
    const collector = createTraceCollector(isDebug);
    const { rulesBudget, budgetMap } = computeBudgets(limit, settings.rulesBudgetPct, !!deepContextSummary);
    const { stableContent, stableTokens, retrievedRulesContent } = buildStable({ settings, context, relevantRules, rulesManifest, rulesBudget, budgetStable: budgetMap.stable, collector });
    const { worldContent, currentWorldTokens, divergenceContent, divergenceTokens, plannerEventTypes: resolvedEventTypes } = buildWorld({ history, userMessage, condensedUpToIndex, relevantLore, npcLedger, archiveRecall, recommendedNPCNames, semanticFactText, archiveIndex, timelineEvents, deepContextSummary, divergenceRegister, chapters, onStageNpcIds, loreRaw: context.loreRaw, agencyDigest: context.agencyDigest, arcDigest: context.arcDigest, budgetWorld: budgetMap.world, npcBudgetFloor: budgetMap.npc, plannerEventTypes, matureMode: settings.matureMode, isDebug, collector, elevatedScenes, slottedRagSnippets });
    const { volatileContent, volatileTokens } = buildVolatile({ context, inventoryCategories, profileFields, budgetVolatile: budgetMap.volatile, collector, plannerEventTypes: resolvedEventTypes, userMessage, history, npcLedger, locationLedger });
    const fitted = buildHistory({
        history,
        condensedUpToIndex,
        userMessage,
        limit,
        stableTokens: stableTokens + divergenceTokens,
        currentWorldTokens,
        volatileTokens,
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
    const GM_REMINDER = '[GM REMINDER: NPCs push back when their wants/boundaries are crossed. Do not default to facilitation.]';
    const activeEncounterBlock = buildActiveEncounterBlock(enemyEncounters, enemyInstances);
    const enemyBlock = activeEncounterBlock || buildRelevantEnemyBlock(enemyCompendium, history, userMessage);
    const volatileBlock = [retrievedRulesContent, worldContent, enemyBlock, volatileContent].filter(Boolean).join('\n\n');
    const askGmBrief = formatAskGmBrief(nextTurnOocBrief);

    // Absolute Command v1: build the binding OOC block (or '' when absent). When
    // present, GM_REMINDER is dropped (the standing "do not default to facilitation"
    // instruction is the most direct opponent of an explicit player override), and
    // the CoT invocation line is swapped for a subordination line. WRITER_COT stays
    // in the cached stable prefix (never conditionally removed — see WO §2); only
    // the below-boundary invocation line changes. The block itself is placed LAST
    // in the final user message — after userMessage — for maximum recency.
    const absoluteCommandBlock = buildAbsoluteCommandBlock(absoluteCommand);
    const hasAbsolute = absoluteCommandBlock !== '';

    const gmReminderActive = hasAbsolute ? '' : GM_REMINDER;

    // Per-turn CoT invocation line (thinking-mode only). Rides in the final user
    // message (below the cache boundary) — kept out of the cached stable prefix so
    // thinking-off turns stay byte-identical to the pre-CoT payload. Under an
    // absolute command, subordinates the framework instead of invoking it flatly.
    const writerCotNudge = !isThinkingEnabled(settings)
        ? ''
        : hasAbsolute
            ? 'Work through the [WRITER REASONING FRAMEWORK] only where it does not conflict with [USER ABSOLUTE COMMAND]. Where they conflict, discard the framework step and follow the command.'
            : 'Work through the [WRITER REASONING FRAMEWORK] in your reasoning before writing.';

    // Director Watchdog nudge (WO-03): rides adjacent to GM_REMINDER in the final user message
    // (below the cache boundary) so it never perturbs the cached prefix. Suppressed when a
    // Director Brief is present — the Brief supersedes it (WO-04 wires the actual Brief value;
    // WO-03 adds the param so the supersession rule is testable). Also suppressed under an
    // Absolute Command (belt-and-braces — the orchestrator already leaves watchdogNudge
    // undefined when the command is armed; buildPayload is called from three sites and must
    // be correct standalone).
    const watchdogNudgeActive = watchdogNudge && !directorBrief && !hasAbsolute ? watchdogNudge : '';

    // Director Brief (WO-04): rendered as a [DIRECTOR BRIEF] block placed BEFORE GM_REMINDER
    // in the final user message (below the cache boundary). When present, the watchdog nudge
    // is omitted (the Brief supersedes it — see `watchdogNudgeActive` gate above). The Brief
    // carries the LLM-authored Writer Brief from `runDirectorBrief`; the block header is
    // added here so the Director's bare `WRITER BRIEF\n...` output reads as a labeled
    // directive to the GM in the final prompt.
    const directorBriefBlock = directorBrief ? `[DIRECTOR BRIEF]\n${directorBrief}` : '';

    // Ordering: the Brief lands BEFORE GM_REMINDER so the GM reads the audit directives
    // first, then the standing GM reminder, then the (possibly suppressed) deterministic
    // nudge. Everything upstream of this point is cache-stable.
    // Absolute Command v1: the command block is placed LAST — after userMessage — for
    // maximum recency, explicitly outranking everything above it.
    const finalUserContent = [
        volatileBlock, writerCotNudge, directorBriefBlock, gmReminderActive,
        watchdogNudgeActive, askGmBrief, userMessage, absoluteCommandBlock,
    ].filter(Boolean).join('\n\n');
    messages.push({ role: 'user', content: finalUserContent });

    // Trace the watchdog so debug mode shows the dossier (source: 'Watchdog' per WO-03 §4).
    // Trace is only recorded when the nudge is actually surfaced — a suppressed nudge (Brief
    // present) or absent input is not a payload contributor this turn.
    if (watchdogNudgeActive) {
        collector.addTrace({
            source: 'Watchdog',
            classification: 'world_context',
            tokens: countTokens(watchdogNudgeActive),
            reason: 'Deterministic NPC-agency nudge (highest-priority signal from buildWatchdogDossier)',
            included: true,
            position: 'user',
            preview: watchdogNudgeActive,
        });
    }

    // Trace the Director Brief so debug mode shows the LLM-authored directives (WO-04 §5).
    // Only recorded when the Brief is actually present — a null/empty Brief (timeout, parse
    // failure, lite tier) is not a payload contributor this turn. When the Brief is present
    // the watchdog trace above is skipped, so exactly one of the two traces appears.
    if (directorBriefBlock) {
        collector.addTrace({
            source: 'Director',
            classification: 'world_context',
            tokens: countTokens(directorBriefBlock),
            reason: 'LLM-authored Writer Brief from runDirectorBrief (supersedes the deterministic watchdog nudge)',
            included: true,
            position: 'user',
            preview: directorBriefBlock,
        });
    }

    // Absolute Command v1: trace the binding OOC block so debug mode shows it.
    // Mirrors the Director trace above. Only recorded when the block is
    // actually present — an absent/empty command is not a payload contributor.
    if (absoluteCommandBlock) {
        collector.addTrace({
            source: 'Absolute Command',
            classification: 'world_context',
            tokens: countTokens(absoluteCommandBlock),
            reason: 'Binding out-of-character player instruction for this turn (supersedes GM_REMINDER, watchdog nudge, and Director Brief)',
            included: true,
            position: 'user',
            preview: absoluteCommandBlock,
        });
    }

    return { messages, trace: isDebug ? collector.trace : undefined, debugSections: isDebug ? collector.debugSections : undefined };
}
