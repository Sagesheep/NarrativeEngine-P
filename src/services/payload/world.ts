import type { ChatMessage, LoreChunk, NPCEntry, ArchiveScene, ArchiveIndexEntry, TimelineEvent, DivergenceRegister, DivergenceEntry, ArchiveChapter, SceneEvent, SceneEventType } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { buildDriftAlert, buildKnowledgeBoundary, buildReactionMenuLine } from '../npc/npcBehaviorDirective';
import { relationBand, describeHex } from '../npc/agency/agencyBands';
import { readPcAffinity, relationToward } from '../npc/affinityAccess';
import { minifyLoreChunk, minifyNPC } from '../turn/contextMinifier';
import { clipLine, npcFieldLimits, NPC_FIELD_FLOORS, type NpcFieldLimits } from '../npc/npcFieldLimits';
import { resolveTimeline, formatResolvedForContext } from '../campaign-state/timelineResolver';
import { isFactActive, renderRegisterForPayload } from '../campaign-state/divergenceRegister';
import { isKnownToAnyOnStage, parseKnownByToken } from '../campaign-state/knowledgeScope';
import { dedupElevatedScenes, type ElevatedScene } from '../archive-memory/dynamicElevation';
import { renderSlottedRagBlock, type SlottedRagSnippet } from '../archive-memory/slottedRag';
import { createWitnessResolver, witnessNames } from '../npc/witnessResolve';
import type { TraceCollector } from './traceCollector';
import { fitBlock, fitLines, fitText } from './fitToBudget';

// ── Context Allocation: which row each world block draws from ──
export type WorldRow = 'npcs' | 'facts' | 'recall' | 'lore';
export type WorldAllocation = {
    /** Shared pool for Automatic rows (today's world budget). */
    pool?: number;
    /** Guaranteed slice for Automatic NPCs before they draw on the pool. */
    npcFloor?: number;
    /** Custom caps; undefined = Automatic (shares the pool). */
    npcs?: number;
    facts?: number;
    recall?: number;
    lore?: number;
};
type WorldBlock = { source: string; content: string; tokens: number; reason: string; fit?: (budget: number) => string };
const WORLD_BLOCK_ROW: Record<string, WorldRow> = {
    'Active NPCs': 'npcs',
    'Agency Digest': 'npcs',
    'Archive Recall': 'recall',
    'Recent Scene Events': 'recall',
    'Dynamic Elevation': 'recall',
    'Slotted RAG': 'recall',
    'Deep Archive Context': 'recall',
    'RAG Lore': 'lore',
    'Raw Lore (Legacy)': 'lore',
    'Arc Digest': 'lore',
    'Scoped Knowledge': 'facts',
    'Semantic Facts': 'facts',
    'Resolved World State': 'facts',
};
const WORLD_ROW_LABEL: Record<WorldRow, string> = {
    npcs: 'Active NPCs',
    facts: 'Canon Facts',
    recall: 'Archive Recall',
    lore: 'Lore',
};

/**
 * Public facts trimmed to `cap`: pinned facts first, then the newest, rendered in
 * their usual order. Deterministic for a given register and cap, so the cached
 * [ESTABLISHED FACTS] block does not change between turns.
 */
function fitPublicFacts(register: DivergenceRegister, chapters: ArchiveChapter[] | undefined, fullText: string, cap: number): string {
    if (cap <= 0) return '';
    if (countTokens(fullText) <= cap) return fullText;
    const entries = register.entries;
    const rank = entries.map((e, i) => ({ i, pinned: !!e.pinned }))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.i - a.i)
        .map(r => r.i);
    const render = (k: number) => {
        const keep = new Set(rank.slice(0, k));
        return renderRegisterForPayload({ ...register, entries: entries.filter((_, i) => keep.has(i)) }, chapters, undefined, undefined, true);
    };
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const text = render(mid);
        if (text && countTokens(text) <= cap) lo = mid;
        else if (!text) lo = mid; // nothing active yet in this subset — keep growing
        else hi = mid - 1;
    }
    const text = lo > 0 ? render(lo) : '';
    return text && countTokens(text) <= cap ? text : '';
}

const RECENT_SCENE_WINDOW = 3;      // mobile used 2; desktop can see a touch deeper
const SCENE_EVENTS_TOKEN_BUDGET = 350; // mobile rationed ~200; desktop has headroom

// ── WO-G: NPC payload tiering helpers ──
// Core tier (always injected): affinity, personality hex, current goal — the
// "GM is never starved" floor. Extended tier (scene-tagged): goals, boundaries,
// triggers, voice, example, drift, inner state — filtered by fieldTags ∩ planner.

function fieldTagMatches(
    fieldName: string,
    fieldTags: Partial<Record<string, SceneEventType[]>> | undefined,
    plannerTags: Set<SceneEventType> | null,
): boolean {
    if (!fieldTags) return true;
    if (!plannerTags) return true;
    const tags = fieldTags[fieldName];
    if (!tags || tags.length === 0) return true;
    return tags.some(t => plannerTags.has(t));
}

export function buildCoreDirective(npc: NPCEntry, relationshipMemoryEnabled = false, limits: NpcFieldLimits = NPC_FIELD_FLOORS): string {
    const parts: string[] = [];
    // Routed through the one affinity accessor (WO-4 §2). The `pcRelation` arm
    // preserves the pre-refactor `npc.pcRelation !== undefined` branch exactly;
    // the legacy/none arms emit no label (matching the old `undefined` path).
    const affinityRead = readPcAffinity(npc, relationshipMemoryEnabled);
    const affinityLabel = affinityRead.kind === 'pcRelation' ? relationBand(affinityRead.value) : undefined;
    if (affinityLabel) parts.push(`[Aff: ${affinityLabel}]`);
    if (npc.personalityHex) parts.push(`Personality: ${describeHex(npc.personalityHex)}`);
    if (npc.wants?.short?.[0]) parts.push(`NOW: ${clipLine(npc.wants.short[0], limits.now)}`);
    // NPC Signature Kit (v1) — durable loadout rides CORE so scene-tag filtering
    // can never drop it. The anti-drift analogue of personalityHex.
    if (npc.signatureKit) {
        const k = npc.signatureKit;
        const kitBits: string[] = [];
        if (k.equipment.length) kitBits.push(`KIT: ${k.equipment.join(', ')}`);
        if (k.abilities.length) kitBits.push(`POWERS: ${k.abilities.join(', ')}`);
        if (k.element) kitBits.push(`element: ${k.element}`);
        if (kitBits.length) parts.push(kitBits.join(' | '));
    }
    return parts.length > 0 ? `PLAY AS: ${parts.join(' | ')}` : '';
}

function buildExtendedDirective(
    npc: NPCEntry,
    plannerTags: Set<SceneEventType> | null,
    limits: NpcFieldLimits,
): string {
    const parts: string[] = [];
    if (npc.wants?.long) parts.push(`GOAL: ${clipLine(npc.wants.long, limits.goal)}`);
    if (npc.wants?.medium?.[0]) parts.push(`PURSUING: ${clipLine(npc.wants.medium[0], limits.pursuing)}`);
    if (npc.hardBoundaries?.length && fieldTagMatches('hardBoundaries', npc.fieldTags, plannerTags)) {
        parts.push(`WON'T: ${npc.hardBoundaries.map(b => clipLine(b, limits.boundary)).join('; ')}`);
    }
    if (npc.softBoundaries?.length && fieldTagMatches('softBoundaries', npc.fieldTags, plannerTags)) {
        parts.push(`RESENTS: ${npc.softBoundaries.map(b => clipLine(b, limits.boundary)).join('; ')}`);
    }
    if (npc.behavioralTriggers?.length && fieldTagMatches('behavioralTriggers', npc.fieldTags, plannerTags)) {
        for (const t of npc.behavioralTriggers) {
            parts.push(`ON "${t.keyword}": ${clipLine(t.shift, limits.trigger)}`);
        }
    }
    if (npc.voice && fieldTagMatches('voice', npc.fieldTags, plannerTags)) {
        parts.push(`Voice: ${clipLine(npc.voice, limits.voice)}`);
    }
    if (npc.exampleOutput && fieldTagMatches('exampleOutput', npc.fieldTags, plannerTags)) {
        parts.push(`Example: ${clipLine(npc.exampleOutput, limits.example)}`);
    }
    return parts.length > 0 ? parts.join(' | ') : '';
}

function renderSceneEventLine(e: SceneEvent): string {
    const parts = [`[${e.eventType}] ${e.text}`];
    if (e.cause && e.result) parts.push(`(${e.cause} → ${e.result})`);
    else if (e.cause) parts.push(`(cause: ${e.cause})`);
    else if (e.result) parts.push(`(result: ${e.result})`);
    return parts.join(' ');
}



export function buildWorld(opts: {
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
    deepContextSummary?: string;
    divergenceRegister?: DivergenceRegister;
    chapters?: ArchiveChapter[];
    onStageNpcIds?: string[];
    loreRaw?: string;
    agencyDigest?: string;
    arcDigest?: string;
    budgetWorld: number;
    npcBudgetFloor: number;
    /** Context Allocation caps for this turn (contextAllocation.ts). Absent → every
     *  row is Automatic: the shared pool is `budgetWorld` and NPCs get `npcBudgetFloor`. */
    allocation?: WorldAllocation;
    plannerEventTypes?: SceneEventType[];
    matureMode?: boolean;
    collector: TraceCollector;
    // WO-11: synopsis-tier scenes surfaced verbatim below the cache boundary
    // for this turn only. Each carries a chapterId for the labeled rendering.
    elevatedScenes?: ElevatedScene[];
    // WO-12: Slotted RAG — one-line snippets from synopsis-tier scenes that had
    // search hits but did NOT get elevated (WO-11). Reuses WO-11's ranked IDs —
    // no second vector search. Witness-filtered, capped at 4 scenes / N per scene.
    slottedRagSnippets?: SlottedRagSnippet[];
    /** WO-5: v3 stances replace scalar relationship context in this payload. */
    relationshipMemoryEnabled?: boolean;
}): { worldContent: string; currentWorldTokens: number; divergenceContent: string; divergenceTokens: number; plannerEventTypes: SceneEventType[]; relationsBlock: string } {
    const {
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
        deepContextSummary,
        divergenceRegister,
        chapters,
        onStageNpcIds,
        loreRaw,
        agencyDigest,
        arcDigest,
        budgetWorld,
        npcBudgetFloor,
        allocation,
        plannerEventTypes: plannerEventTypesOpt,
        matureMode,
        collector,
        elevatedScenes,
        slottedRagSnippets,
        relationshipMemoryEnabled = false,
    } = opts;

    // --- 3. Gather trimmable World Context (Medium Priority) ---
    // `fit` trims a block to an allowance; blocks without one use the generic line trimmer.
    const worldBlocks: WorldBlock[] = [];
    let divergenceRegText = '';
    let divergenceTokens = 0;
    // WO-4 §4: the on-stage NPC↔NPC relations block is split out of the structural
    // volatile.block into its own toggleable contribution. `buildWorld` renders it
    // here (routed through the canonical relation-key resolver) and returns it
    // separately; `payloadBuilder` registers it as its own contribution beside the
    // other built-ins. With no mods the assembled payload is byte-identical to the
    // pre-split form — the same text, position, spacing, and ordering, assembled
    // from two modules instead of one.
    let relationsBlock = '';
    // WO-G: derive plannerEventTypes — explicit param wins; otherwise derive from
    // recent scene events (the desktop adaptation of mobile's turn-time planner).
    let plannerEventTypes: SceneEventType[] = plannerEventTypesOpt ?? [];

    // WO-11b Correction 1: Dynamic Elevation renders independently of ordinary recall.
    // The post-filter regular-recall IDs feed elevation dedup; empty set when no recall.
    let regularRecallIds = new Set<string>();

    // Witness labels. Recalled and elevated scenes are never dropped for who saw
    // them: the narrator remembers everything, and the player character was
    // usually there. Each scene names the NPCs recorded as present instead, so the
    // writer can keep what each NPC knows straight. (The old perceptual filter
    // compared witness names against NPC ids, matched nothing, and emptied recall.)
    const resolveWitness = createWitnessResolver(npcLedger ?? []);
    const witnessesBySceneId = new Map((archiveIndex ?? []).map(e => [e.sceneId, e.witnesses]));
    const pastSceneHeader = (sceneId: string): string => {
        const names = witnessNames(witnessesBySceneId.get(sceneId), resolveWitness);
        return names.length > 0 ? `[PAST SCENE — witnessed by ${names.join(', ')}]` : '[PAST SCENE]';
    };

    // Archive Recall
    if (archiveRecall && archiveRecall.length > 0) {
        // Simple dedupe against active history
        const activeAssistantContents = history
            .slice((condensedUpToIndex ?? -1) + 1)
            .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 20)
            .map(m => m.content as string);

        const filteredRecall = archiveRecall.filter(scene => {
            if (activeAssistantContents.some(asst => scene.content.includes(asst))) return false;
            return true;
        });

        if (filteredRecall.length > 0) {
            // WO-F (2be3ad5) — drop the internal scene number from the header so it never leaks
            // into the GM prompt. The scene id is a storage detail; the AI should recall scenes by
            // content, not by number (and surgical deletes can leave gaps that would confuse it).
            // Scenes recalled as a one-line definition (form 'short') are listed after the
            // verbatim ones, so the budget reaches far more scenes than full text alone.
            const fullRecall = filteredRecall.filter(s => s.form !== 'short');
            const shortRecall = filteredRecall.filter(s => s.form === 'short');
            const fullText = fullRecall.map(s => `${pastSceneHeader(s.sceneId)}\n${s.content}`).join('\n\n');
            const shortText = shortRecall.length > 0
                ? `[OTHER RELEVANT PAST SCENES — IN BRIEF]\n${shortRecall.map(s => {
                    const names = witnessNames(witnessesBySceneId.get(s.sceneId), resolveWitness);
                    return `- ${s.content}${names.length > 0 ? ` (witnessed by ${names.join(', ')})` : ''}`;
                }).join('\n')}`
                : '';
            const wrapRecall = (full: string, short: string) =>
                `[ARCHIVE RECALL — VERBATIM PAST SCENES]\n${[full, short].filter(Boolean).join('\n\n')}\n[END ARCHIVE RECALL]`;
            const text = wrapRecall(fullText, shortText);
            const reason = shortRecall.length > 0
                ? `Verbatim history (${fullRecall.length} scenes, ${shortRecall.length} in brief)`
                : `Verbatim history (${filteredRecall.length} scenes)`;
            // Over its allowance, the full scene is cut to an excerpt and the brief
            // reminders are kept; with no room for an excerpt, only reminders remain.
            const fitRecall = (budget: number): string => {
                const shell = countTokens(wrapRecall('', shortText));
                const room = budget - shell - 4;
                if (fullText && room >= 120) {
                    const cut = fitText(fullText, room - 2);
                    const candidate = wrapRecall(cut === fullText ? cut : `${cut} …`, shortText);
                    if (countTokens(candidate) <= budget) return candidate;
                }
                const briefLines = shortText ? shortText.split('\n').slice(1) : [];
                return fitLines({ head: '[ARCHIVE RECALL — VERBATIM PAST SCENES]\n[OTHER RELEVANT PAST SCENES — IN BRIEF]', lines: briefLines, foot: '[END ARCHIVE RECALL]', budget });
            };
            worldBlocks.push({ source: 'Archive Recall', content: text, tokens: countTokens(text), reason, fit: fitRecall });
        }

        // Post-filter regular-recall IDs available to elevation dedup.
        regularRecallIds = new Set(filteredRecall.map(s => s.sceneId));

        // Recent Scene Events block rendering
        const recentScenes = archiveRecall.slice(-RECENT_SCENE_WINDOW);
        const allEvents: SceneEvent[] = [];
        for (const scene of recentScenes) {
            const entry = archiveIndex?.find(e => e.sceneId === scene.sceneId);
            if (entry?.events) {
                allEvents.push(...entry.events);
            }
        }
        // WO-G: if no explicit plannerEventTypes, derive from recent scene events.
        if (plannerEventTypes.length === 0 && allEvents.length > 0) {
            const typeSet = new Set<SceneEventType>();
            for (const ev of allEvents) {
                if (ev.eventType) typeSet.add(ev.eventType);
            }
            plannerEventTypes = [...typeSet];
        }
        if (allEvents.length > 0) {
            const sortedEvents = allEvents
                .slice()
                .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));

            // Accumulate the rendered text rather than rebuilding it for every
            // candidate. The previous form passed the whole accumulated list to
            // `renderSceneEvents` each iteration, which re-sorted a list that
            // `sortedEvents` had already sorted by the same key and re-rendered
            // every line it had already rendered.
            //
            // The output is byte-identical: sort is stable, so re-sorting an
            // already-sorted array cannot reorder it, and the lines come from
            // the same function. Token counts stay exact — counted on the real
            // accumulated string rather than summed per line, because BPE is
            // not additive across a line boundary and the golden gates pin
            // these bytes.
            const includedEvents: SceneEvent[] = [];
            let accumulatedText = '';
            for (const event of sortedEvents) {
                const line = renderSceneEventLine(event);
                const candidate = accumulatedText ? `${accumulatedText}\n${line}` : line;
                if (countTokens(candidate) <= SCENE_EVENTS_TOKEN_BUDGET) {
                    includedEvents.push(event);
                    accumulatedText = candidate;
                } else {
                    break;
                }
            }

            if (includedEvents.length > 0) {
                const eventsText = accumulatedText;
                worldBlocks.push({
                    source: 'Recent Scene Events',
                    content: eventsText,
                    tokens: countTokens(eventsText),
                    reason: `${includedEvents.length} events from last ${RECENT_SCENE_WINDOW} scene(s)`,
                });
            }
        }
    }

    // WO-11 / WO-11b: Dynamic Elevation — synopsis-tier scenes referenced this turn
    // surface verbatim below the cache boundary, labeled by chapter. Per WO-11b
    // Correction 1, this renders independently of ordinary recall — evaluated
    // whenever elevatedScenes is non-empty, regardless of whether archiveRecall is
    // undefined, [], or non-empty. Dedup uses the regular-recall IDs (empty set when
    // no regular recall rendered). Elevated scenes carry the same witness labels as
    // regular recall. The scope was already
    // restricted to synopsis-tier scenes at gather time (computeSynopsisScope), so
    // the LOD history from WO-09 is never touched — elevation is a new path beside
    // it, not a modification. The elevated block stays a worldBlocks entry with
    // source: 'Dynamic Elevation' so it rides below the cache boundary (never in
    // history, stable, pinned, divergence, or a system message).
    if (elevatedScenes && elevatedScenes.length > 0) {
        const elevated = dedupElevatedScenes(elevatedScenes, regularRecallIds);

        if (elevated.length > 0) {
            // Group by chapterId so each chapter's scenes render under one labeled section.
            const byChapter = new Map<string, ArchiveScene[]>();
            for (const s of elevated) {
                const arr = byChapter.get(s.chapterId) ?? [];
                arr.push(s);
                byChapter.set(s.chapterId, arr);
            }
            const sections: string[] = [];
            for (const [chapterId, scenes] of byChapter) {
                const body = scenes.map(s => `${pastSceneHeader(s.sceneId)}\n${s.content}`).join('\n\n');
                sections.push(`[ELEVATED MEMORY — Chapter ${chapterId}]\n${body}\n[END ELEVATED MEMORY]`);
            }
            const text = sections.join('\n\n');
            // WO-11 §5: trace reason carries the elevated scene IDs so the debug
            // panel shows what was surfaced. The scoped search endpoint returns
            // ranked scene IDs but not explicit score values (cosine similarity
            // is internal to sqlite-vec); the order IS the ranking.
            worldBlocks.push({
                source: 'Dynamic Elevation',
                content: text,
                tokens: countTokens(text),
                reason: `Synopsis-tier scenes elevated verbatim (${elevated.length} scene(s) across ${byChapter.size} chapter(s)); IDs: ${elevated.map(s => s.sceneId).join(', ')} (ranked by cosine similarity; scores not exposed by endpoint)`,
            });
        }
    }

    // WO-12: Slotted RAG — synopsis-tier scenes with search hits that did NOT get
    // elevated contribute one-line verbatim snippets, witness-filtered. Reuses
    // WO-11's scoped search results (one search, two consumers); no second vector
    // search. The witness filter already ran in buildSlottedRagSnippets, so every
    // snippet here is already witness-cleared (broadcast scenes pass; witnessed
    // scenes pass only if an on-stage/active NPC saw them). Renders the
    // [FABLE-AUTHORED] [ARCHIVE FLASHES] block, labeled per scene with the chapter
    // id and witness names. Empty snippets → no block emitted (renderSlottedRagBlock
    // returns ''). Stays a worldBlocks entry with source: 'Slotted RAG' so it rides
    // below the cache boundary (never in history, stable, pinned, divergence, or a
    // system message). Per invariant 6, the witness filter is the core of this WO —
    // scenes not witnessed by any on-stage NPC are dropped at snippet-build time.
    if (slottedRagSnippets && slottedRagSnippets.length > 0) {
        const text = renderSlottedRagBlock(slottedRagSnippets);
        if (text) {
            worldBlocks.push({
                source: 'Slotted RAG',
                content: text,
                tokens: countTokens(text),
                reason: `Synopsis-tier snippet flashes (${slottedRagSnippets.length} line(s) across ${new Set(slottedRagSnippets.map(s => s.sceneId)).size} scene(s)); reuses WO-11 scoped search results`,
            });
        }
    }

    // Deep Archive Context
    if (deepContextSummary) {
        const text = `[DEEP ARCHIVE CONTEXT — AI-synthesized from full campaign history]\n${deepContextSummary}\n[END DEEP ARCHIVE CONTEXT]`;
        worldBlocks.push({ source: 'Deep Archive Context', content: text, tokens: countTokens(text), reason: 'Deep archive scan result' });
    }

    // RAG Lore — minified and grouped by category
    if (relevantLore && relevantLore.length > 0) {
        const grouped = new Map<string, string[]>();
        for (const chunk of relevantLore) {
            const cat = chunk.category || 'misc';
            const catTitle = cat === 'faction' ? 'FACTIONS'
                           : cat === 'character' ? 'CHARACTERS'
                           : cat === 'location' ? 'LOCATIONS'
                           : cat === 'power_system' || cat === 'rules' ? 'POWER SYSTEM & RULES'
                           : cat === 'economy' ? 'ECONOMY'
                           : cat === 'event' ? 'EVENTS'
                           : cat === 'world_overview' ? 'OVERVIEW'
                           : 'MISCELLANEOUS';

            if (!grouped.has(catTitle)) grouped.set(catTitle, []);
            grouped.get(catTitle)!.push(minifyLoreChunk(chunk));
        }

        const sections: string[] = [];
        for (const [title, chunks] of grouped.entries()) {
            sections.push(`[${title}]\n` + chunks.join('\n'));
        }

        const text = `[WORLD LORE — RELEVANT SECTIONS]\n${sections.join('\n\n')}\n[END WORLD LORE]`;
        worldBlocks.push({ source: 'RAG Lore', content: text, tokens: countTokens(text), reason: `RAG injected (${relevantLore.length} chunks, minified)` });
    } else if (loreRaw) {
        worldBlocks.push({ source: 'Raw Lore (Legacy)', content: loreRaw, tokens: countTokens(loreRaw), reason: 'Legacy fallback' });
    }

    // Resolved World State (Timeline)
    if (timelineEvents && timelineEvents.length > 0) {
        const resolved = resolveTimeline(timelineEvents);
        if (resolved.length > 0) {
            const resolvedText = formatResolvedForContext(resolved);
            worldBlocks.push({
                source: 'Resolved World State',
                content: resolvedText,
                tokens: countTokens(resolvedText),
                reason: `Timeline resolution: ${resolved.length} active truths from ${timelineEvents.length} events`
            });
        }
    }

    // Active NPCs
    if (npcLedger && npcLedger.length > 0) {
        const loreHeadersSet = new Set((relevantLore ?? []).filter(l => l.header).map(l => l.header!.toLowerCase()));

        let activeNPCs: NPCEntry[];

        if (recommendedNPCNames && recommendedNPCNames.length > 0) {
            // ── Utility AI Recommender mode ──
            // Use the pre-computed list from contextRecommender.ts
            const recommendedSet = new Set(recommendedNPCNames.map(n => n.toLowerCase()));
            activeNPCs = npcLedger.filter(npc => {
                if (npc.archived) return false;
                if (!npc.name || loreHeadersSet.has(npc.name.toLowerCase())) return false;
                const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
                const allNames = [npc.name.toLowerCase(), ...aliases];
                return allNames.some(n => recommendedSet.has(n));
            });
            console.debug(`[PayloadBuilder] NPC selection via UtilityAI recommender: ${activeNPCs.length} active.`);
        } else {
            // ── Legacy substring scan mode ──
            const scanHistory = history.slice(-10).map(m => m.content || '').join(' ') + ' ' + userMessage;
            activeNPCs = npcLedger.filter(npc => {
                if (npc.archived) return false;
                if (!npc.name || loreHeadersSet.has(npc.name.toLowerCase())) return false;
                const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
                const patterns = [npc.name.toLowerCase(), ...aliases];
                return patterns.some(p => scanHistory.toLowerCase().includes(p));
            });
        }

        if (activeNPCs.length > 0) {
            const plannerTags = plannerEventTypes.length > 0 ? new Set(plannerEventTypes) : null;
            const onStageSet = new Set(onStageNpcIds ?? []);
            // Only the rendered line is ever read. This used to carry an id and
            // a token count as well, and the count meant a BPE encode per active
            // NPC per turn whose result was discarded.
            const npcSegments: string[] = [];
            // Per-NPC core line (always-on tier) beside the full line, so the block can be
            // trimmed NPC by NPC: on-stage cores first, then full detail, then mentioned NPCs.
            const npcTiers: { core: string; full: string; onStage: boolean }[] = [];

            // Field caps scale with the NPC budget shared by every active NPC
            // (npcFieldLimits.ts). Only NPCs on stage get the scaled caps; ones merely
            // mentioned stay at the floor. With no on-stage list, every NPC scales.
            // A custom Active NPCs allowance scales them instead of the floor.
            const scaledLimits = npcFieldLimits(allocation?.npcs ?? npcBudgetFloor, activeNPCs.length);
            const limitsFor = (npc: NPCEntry): NpcFieldLimits =>
                onStageSet.size === 0 || onStageSet.has(npc.id) ? scaledLimits : NPC_FIELD_FLOORS;

            for (const npc of activeNPCs) {
                const limits = limitsFor(npc);
                // Core tier — always injected.
                const coreParts: string[] = [minifyNPC(npc, limits)];
                const coreDirective = buildCoreDirective(npc, relationshipMemoryEnabled, limits);
                if (coreDirective) coreParts.push(coreDirective);
                const coreLine = coreParts.join(' | ');

                // Extended tier — scene-tagged.
                const extParts: string[] = [];
                const extDirective = buildExtendedDirective(npc, plannerTags, limits);
                if (extDirective) extParts.push(extDirective);
                const drift = buildDriftAlert(npc);
                if (drift && fieldTagMatches('drift', npc.fieldTags, plannerTags)) extParts.push(drift);
                if (archiveIndex && fieldTagMatches('knowledgeBoundary', npc.fieldTags, plannerTags)) {
                    const divergenceFacts = divergenceRegister?.entries;
                    const boundary = buildKnowledgeBoundary(npc, archiveIndex, divergenceFacts, resolveWitness);
                    if (boundary) extParts.push(boundary);
                }
                // Reaction menu (Phase 2 §9.1) — on-stage NPCs only; the engine-scored menu is the
                // anti-sycophancy forcing function and is meaningful only for NPCs actually in the
                // scene. matureMode threads the same gate the want draws use; context stays
                // 'peaceful' until encounter/combat state is available here. The repression event is
                // discarded (read path) — booking is once-per-turn in postTurnPipeline (WO-3).
                if (onStageSet.has(npc.id)) {
                    const menuLine = buildReactionMenuLine(npc, { matureMode, relationshipMemoryEnabled });
                    if (menuLine) extParts.push(menuLine);
                }
                const extLine = extParts.length > 0 ? extParts.join(' | ') : '';
                const fullLine = extLine ? `${coreLine} | ${extLine}` : coreLine;
                npcSegments.push(fullLine);
                npcTiers.push({ core: coreLine, full: fullLine, onStage: onStageSet.size === 0 || onStageSet.has(npc.id) });
            }

            // On-stage NPC↔NPC relations (sparse, directed). Routed through the canonical
            // relation-key resolver (WO-4 §3) so name-keyed edges — the overwhelming majority —
            // read non-zero here. Returned as a separate string so it can be split out of the
            // structural volatile.block into its own toggleable contribution (WO-4 §4).
            const present = activeNPCs.filter(n => onStageSet.has(n.id));
            const relationLines: string[] = [];
            for (let i = 0; i < present.length; i++) {
                for (let j = 0; j < present.length; j++) {
                    if (i === j) continue;
                    const a = present[i], b = present[j];
                    const r = relationToward(a, b, relationshipMemoryEnabled);
                    if (typeof r === 'number' && r !== 0) {
                        relationLines.push(`${a.name}\u2192${b.name}: ${r > 0 ? '+' : ''}${r}`);
                    }
                }
            }
            const relationBlock = relationLines.length > 0
                ? `[ON-STAGE RELATIONS]\n${relationLines.join('\n')}`
                : '';
            relationsBlock = relationBlock;

            const wrapNpcs = (lines: string[]) => `[ACTIVE NPC CONTEXT]\n${lines.join('\n')}\n[END NPC CONTEXT]`;
            const npcText = wrapNpcs(npcSegments);
            const fitNpcs = (budget: number): string => {
                // Priority: on-stage core lines, mentioned core lines, then upgrade to full
                // detail in the same order. Kept NPCs stay in their original order.
                const order = npcTiers.map((_, i) => i).sort((a, b) => Number(npcTiers[b].onStage) - Number(npcTiers[a].onStage));
                const chosen = new Map<number, string>();
                const render = () => wrapNpcs([...chosen.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l));
                for (const i of order) {
                    chosen.set(i, npcTiers[i].core);
                    if (countTokens(render()) > budget) { chosen.delete(i); break; }
                }
                for (const i of order) {
                    if (!chosen.has(i) || npcTiers[i].full === npcTiers[i].core) continue;
                    chosen.set(i, npcTiers[i].full);
                    if (countTokens(render()) > budget) chosen.set(i, npcTiers[i].core);
                }
                return chosen.size > 0 ? render() : '';
            };
            worldBlocks.push({
                source: 'Active NPCs',
                content: npcText,
                tokens: countTokens(npcText),
                reason: `NPCs detected in context (${activeNPCs.length}, tiered core+extended)`,
                fit: fitNpcs,
            });
        }
    }

    // ── Phase 6: per-turn scoped-knowledge block (the cage) ──
    // Facts whose knownBy is DEFINED ride here, never in the cached canon block. Only
    // facts a present (on-stage) character knows are shown, resolved against the live
    // cast. Cast-aware → MUST live below the cache boundary (the world block), so that
    // cached [ESTABLISHED FACTS] stays byte-identical when only the cast changes.
    if (divergenceRegister && divergenceRegister.entries.length > 0) {
        const onStage = onStageNpcIds ?? [];
        const ledger = npcLedger ?? [];
        const isActive = (e: DivergenceEntry): boolean => {
            if (e.enabled === false) return false;
            if (!isFactActive(e)) return false;
            if (e.pinned) return true;
            const chapterOn = divergenceRegister.chapterToggles[e.chapterId] !== false;
            if (!chapterOn) return false;
            const catToggles = divergenceRegister.categoryToggles[e.chapterId];
            if (catToggles && catToggles[e.category] === false) return false;
            return true;
        };
        const labelKnowers = (knownBy: string[]): string => {
            const parts: string[] = [];
            for (const tok of knownBy) {
                const p = parseKnownByToken(tok);
                if (!p || p.kind === 'player') continue;
                if (p.kind === 'npc') {
                    const npc = ledger.find(n => n.id === p.id);
                    if (npc) parts.push(npc.name);
                } else {
                    parts.push(`${p.name} members`);
                }
            }
            return parts.join(', ');
        };
        const scoped = divergenceRegister.entries.filter(e =>
            e.knownBy !== undefined &&
            isActive(e) &&
            isKnownToAnyOnStage(e.knownBy, onStage, ledger)
        );
        if (scoped.length > 0) {
            const lines = scoped.map(e => {
                const who = labelKnowers(e.knownBy!);
                const whoStr = who ? ` (known to: ${who})` : '';
                return `• ${e.text}${whoStr} [#${e.sceneRef}]`;
            });
            const content = `[FACTS KNOWN TO ON-STAGE CHARACTERS]\n${lines.join('\n')}\n[END FACTS KNOWN TO ON-STAGE CHARACTERS]`;
            // Over its allowance, the newest facts are kept.
            worldBlocks.push({ source: 'Scoped Knowledge', content, tokens: countTokens(content), reason: `Per-fact knowledge bounded to present cast (${scoped.length})`, fit: (budget) => fitBlock(content, budget, 'last') });
        }
    }

    // ── Phase 2/3: agency + arc digest fold ──
    // Off-screen movement (NPC agency tick) and world undercurrent (Arc Engine tick) are
    // short per-turn prose strings accumulated in post-turn and consumed once by the next GM
    // call. Cleared at the top of runPostTurnPipeline after consumption.
    if (agencyDigest) {
        const text = `[OFF-SCREEN MOVEMENT]\n${agencyDigest}`;
        worldBlocks.push({ source: 'Agency Digest', content: text, tokens: countTokens(text), reason: 'Off-screen NPC agency tick digest' });
    }
    if (arcDigest) {
        const text = `[WORLD UNDERCURRENT]\n${arcDigest}`;
        worldBlocks.push({ source: 'Arc Digest', content: text, tokens: countTokens(text), reason: 'Arc Engine surface line' });
    }

    // Divergence Register — extracted separately for cache_control: ephemeral.
    // Phase 6 cache split: render PUBLIC/broadcast facts ONLY (publicOnly=true) with NO
    // cast args, so this block is cast-independent and the cached prefix stays
    // byte-identical across turns when the on-stage cast changes. Scoped (knownBy-defined)
    // facts are surfaced per-turn in the [FACTS KNOWN TO ON-STAGE CHARACTERS] world block
    // above. Not added to worldBlocks; emitted as its own cached system message by payloadBuilder.
    //
    // Context Allocation: the public facts are capped by the Canon Facts allowance (custom),
    // or by the shared pool (Automatic, today's "reserve facts first"). Over the cap, pinned
    // facts are kept first, then the newest. The cap does not change from turn to turn, so
    // the trimmed block stays byte-identical and the prompt cache still holds.
    const factsCap = allocation?.facts ?? allocation?.pool ?? budgetWorld;
    if (divergenceRegister && divergenceRegister.entries.length > 0) {
        const fullText = renderRegisterForPayload(divergenceRegister, chapters, undefined, undefined, true);
        const regText = fullText ? fitPublicFacts(divergenceRegister, chapters, fullText, factsCap) : '';
        const fullTokens = fullText ? countTokens(fullText) : 0;
        if (regText) {
            divergenceRegText = regText;
            divergenceTokens = countTokens(regText);
            const trimmedNote = regText !== fullText ? ` — trimmed from ${fullTokens} t to fit the Canon Facts allowance (${factsCap} t); pinned and newest kept` : '';
            collector.addTrace({ source: 'Established Facts', classification: 'world_context', tokens: divergenceTokens, reason: `Campaign canon — public facts (${divergenceRegister.entries.length} entries)${trimmedNote}`, included: true, position: 'system_cacheable', preview: regText });
            collector.addSection({ label: 'Established Facts', role: 'system', tokens: divergenceTokens, content: regText, classification: 'world_context' });
        } else if (fullText) {
            collector.addTrace({ source: 'Established Facts', classification: 'world_context', tokens: fullTokens, reason: `Omitted: no Canon Facts allowance left (${factsCap} t)`, included: false, position: 'system_cacheable' });
        }
    }

    if (semanticFactText) {
        worldBlocks.push({ source: 'Semantic Facts', content: semanticFactText, tokens: countTokens(semanticFactText), reason: 'Injected verified facts' });
    }

    // --- 4. Fit World Context to the Context Allocation ---
    // Each block belongs to one allocation row (WORLD_BLOCK_ROW). A row with a custom
    // allowance spends only that allowance; Automatic rows share one pool, as before:
    // public facts are charged first (above), then Active NPCs (their floor first, then
    // the pool), then the remaining blocks in their usual order. A block over what is
    // left is trimmed to fit — the full scene cut to an excerpt, NPCs reduced to their
    // core lines, the oldest facts dropped — and is omitted only when nothing useful fits.
    const custom: Partial<Record<WorldRow, number>> = {
        npcs: allocation?.npcs,
        facts: allocation?.facts,
        recall: allocation?.recall,
        lore: allocation?.lore,
    };
    const remaining: Partial<Record<WorldRow, number>> = {};
    for (const row of Object.keys(custom) as WorldRow[]) {
        if (custom[row] !== undefined) remaining[row] = custom[row]!;
    }
    let pool = Math.max(0, allocation?.pool ?? budgetWorld);
    let npcFloorLeft = custom.npcs === undefined ? Math.max(0, allocation?.npcFloor ?? npcBudgetFloor) : 0;
    if (divergenceTokens > 0) {
        if (remaining.facts !== undefined) remaining.facts = Math.max(0, remaining.facts - divergenceTokens);
        else pool = Math.max(0, pool - divergenceTokens);
    }
    const allowanceFor = (row: WorldRow) =>
        remaining[row] !== undefined ? remaining[row]! : pool + (row === 'npcs' ? npcFloorLeft : 0);
    const charge = (row: WorldRow, tokens: number) => {
        if (remaining[row] !== undefined) { remaining[row] = Math.max(0, remaining[row]! - tokens); return; }
        if (row === 'npcs') {
            const fromFloor = Math.min(npcFloorLeft, tokens);
            npcFloorLeft -= fromFloor;
            tokens -= fromFloor;
        }
        pool = Math.max(0, pool - tokens);
    };

    let worldContent = '';
    let currentWorldTokens = 0;
    const admit = (block: WorldBlock) => {
        const row = WORLD_BLOCK_ROW[block.source] ?? 'facts';
        const allowance = allowanceFor(row);
        const label = `${WORLD_ROW_LABEL[row]} allowance`;
        let content = block.content;
        let tokens = block.tokens;
        let reason = block.reason;
        if (tokens > allowance) {
            content = allowance > 0 ? (block.fit ? block.fit(allowance) : fitBlock(block.content, allowance)) : '';
            const fittedTokens = content ? countTokens(content) : 0;
            if (!content || fittedTokens > allowance) {
                collector.addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: `Omitted: ${block.tokens} t, ${allowance} t of the ${label} left`, included: false, position: 'system_dynamic' });
                return;
            }
            reason = `${block.reason} — trimmed from ${block.tokens} t to fit the ${label} (${allowance} t)`;
            tokens = fittedTokens;
        }
        charge(row, tokens);
        worldContent += (worldContent ? '\n\n' : '') + content;
        currentWorldTokens += tokens;
        collector.addTrace({ source: block.source, classification: 'world_context', tokens, reason, included: true, position: 'system_dynamic' });
        collector.addSection({ label: block.source, role: 'system', tokens, content, classification: 'world_context' });
    };

    const npcBlockIndex = worldBlocks.findIndex(b => b.source === 'Active NPCs');
    if (npcBlockIndex >= 0) admit(worldBlocks[npcBlockIndex]);
    for (let i = 0; i < worldBlocks.length; i++) {
        if (i !== npcBlockIndex) admit(worldBlocks[i]);
    }

    return { worldContent, currentWorldTokens, divergenceContent: divergenceRegText, divergenceTokens, plannerEventTypes, relationsBlock };
}
