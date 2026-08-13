import type { ChatMessage, LoreChunk, NPCEntry, ArchiveScene, ArchiveIndexEntry, TimelineEvent, DivergenceRegister, DivergenceEntry, ArchiveChapter, SceneEvent, SceneEventType } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { buildDriftAlert, buildKnowledgeBoundary, buildReactionMenuLine } from '../npc/npcBehaviorDirective';
import { relationBand, describeHex } from '../npc/agency/agencyBands';
import { readPcAffinity, relationToward } from '../npc/affinityAccess';
import { minifyLoreChunk, minifyNPC } from '../turn/contextMinifier';
import { resolveTimeline, formatResolvedForContext } from '../campaign-state/timelineResolver';
import { isFactActive, renderRegisterForPayload } from '../campaign-state/divergenceRegister';
import { isKnownToAnyOnStage, parseKnownByToken } from '../campaign-state/knowledgeScope';
import { dedupElevatedScenes, type ElevatedScene } from '../archive-memory/dynamicElevation';
import { renderSlottedRagBlock, type SlottedRagSnippet } from '../archive-memory/slottedRag';
import type { TraceCollector } from './traceCollector';

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

export function buildCoreDirective(npc: NPCEntry, relationshipMemoryEnabled = false): string {
    const parts: string[] = [];
    // Routed through the one affinity accessor (WO-4 §2). The `pcRelation` arm
    // preserves the pre-refactor `npc.pcRelation !== undefined` branch exactly;
    // the legacy/none arms emit no label (matching the old `undefined` path).
    const affinityRead = readPcAffinity(npc, relationshipMemoryEnabled);
    const affinityLabel = affinityRead.kind === 'pcRelation' ? relationBand(affinityRead.value) : undefined;
    if (affinityLabel) parts.push(`[Aff: ${affinityLabel}]`);
    if (npc.personalityHex) parts.push(`Personality: ${describeHex(npc.personalityHex)}`);
    if (npc.wants?.short?.[0]) {
        const s = npc.wants.short[0];
        parts.push(`NOW: ${s.length > 40 ? s.substring(0, 40) + '\u2026' : s}`);
    } else if (npc.drives?.sceneWant) {
        const sw = npc.drives.sceneWant;
        parts.push(`NOW: ${sw.length > 40 ? sw.substring(0, 40) + '\u2026' : sw}`);
    }
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
): string {
    const parts: string[] = [];
    if (npc.wants?.long) {
        parts.push(`GOAL: ${npc.wants.long.length > 80 ? npc.wants.long.substring(0, 80) + '\u2026' : npc.wants.long}`);
    }
    if (npc.wants?.medium?.[0]) {
        const m = npc.wants.medium[0];
        parts.push(`PURSUING: ${m.length > 60 ? m.substring(0, 60) + '\u2026' : m}`);
    } else if (npc.drives && !npc.wants) {
        const driveParts: string[] = [];
        if (npc.drives.sessionWant) driveParts.push(npc.drives.sessionWant.length > 80 ? npc.drives.sessionWant.substring(0, 80) + '\u2026' : npc.drives.sessionWant);
        if (npc.drives.coreWant) driveParts.push(npc.drives.coreWant.length > 80 ? npc.drives.coreWant.substring(0, 80) + '\u2026' : npc.drives.coreWant);
        if (driveParts.length > 0) parts.push(`WANTS: ${driveParts.join(' \u2190 ')}`);
    }
    if (npc.hardBoundaries?.length && fieldTagMatches('hardBoundaries', npc.fieldTags, plannerTags)) {
        parts.push(`WON'T: ${npc.hardBoundaries.map(b => b.length > 40 ? b.substring(0, 40) + '\u2026' : b).join('; ')}`);
    }
    if (npc.softBoundaries?.length && fieldTagMatches('softBoundaries', npc.fieldTags, plannerTags)) {
        parts.push(`RESENTS: ${npc.softBoundaries.map(b => b.length > 40 ? b.substring(0, 40) + '\u2026' : b).join('; ')}`);
    }
    if (npc.behavioralTriggers?.length && fieldTagMatches('behavioralTriggers', npc.fieldTags, plannerTags)) {
        for (const t of npc.behavioralTriggers) {
            parts.push(`ON "${t.keyword}": ${t.shift.length > 50 ? t.shift.substring(0, 50) + '\u2026' : t.shift}`);
        }
    }
    if (npc.voice && fieldTagMatches('voice', npc.fieldTags, plannerTags)) {
        parts.push(`Voice: ${npc.voice.length > 60 ? npc.voice.substring(0, 60) + '\u2026' : npc.voice}`);
    }
    if (npc.exampleOutput && fieldTagMatches('exampleOutput', npc.fieldTags, plannerTags)) {
        parts.push(`Example: ${npc.exampleOutput.length > 80 ? npc.exampleOutput.substring(0, 80) + '\u2026' : npc.exampleOutput}`);
    }
    return parts.length > 0 ? parts.join(' | ') : '';
}

function renderSceneEvents(events: SceneEvent[]): string {
    if (!events || events.length === 0) return '';
    return events
        .slice()
        .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
        .map(e => {
            const parts = [`[${e.eventType}] ${e.text}`];
            if (e.cause && e.result) parts.push(`(${e.cause} → ${e.result})`);
            else if (e.cause) parts.push(`(cause: ${e.cause})`);
            else if (e.result) parts.push(`(result: ${e.result})`);
            return parts.join(' ');
        })
        .join('\n');
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
    plannerEventTypes?: SceneEventType[];
    matureMode?: boolean;
    isDebug: boolean;
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
        plannerEventTypes: plannerEventTypesOpt,
        matureMode,
        isDebug,
        collector,
        elevatedScenes,
        slottedRagSnippets,
        relationshipMemoryEnabled = false,
    } = opts;

    // --- 3. Gather trimmable World Context (Medium Priority) ---
    const worldBlocks: { source: string; content: string; tokens: number; reason: string }[] = [];
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

    // Archive Recall
    if (archiveRecall && archiveRecall.length > 0) {
        // Simple dedupe against active history
        const activeAssistantContents = history
            .slice((condensedUpToIndex ?? -1) + 1)
            .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 20)
            .map(m => m.content as string);

        let filteredRecall = archiveRecall.filter(scene => {
            if (activeAssistantContents.some(asst => scene.content.includes(asst))) return false;
            return true;
        });

        // Perceptual archive filtering: only include scenes witnessed by active NPCs
        if (archiveIndex && npcLedger && archiveIndex.some(e => e.witnesses && e.witnesses.length > 0)) {
            const activeNpcIds = new Set(
                npcLedger.filter(n => !n.archived).map(n => n.id)
            );
            if (onStageNpcIds) {
                for (const id of onStageNpcIds) activeNpcIds.add(id);
            }
            const sceneWitnessMap = new Map(archiveIndex.map(e => [e.sceneId, e.witnesses]));
            filteredRecall = filteredRecall.filter(scene => {
                const witnesses = sceneWitnessMap.get(scene.sceneId);
                if (!witnesses || witnesses.length === 0) return true; // broadcast — no witness data
                return witnesses.some(w => activeNpcIds.has(w));
            });
            if (isDebug) {
                const filtered = archiveRecall.length - filteredRecall.length;
                if (filtered > 0) collector.addTrace({ source: 'Archive Recall', classification: 'world_context', tokens: 0, reason: `Perceptual filter removed ${filtered} scenes (not witnessed by active NPCs)`, included: false });
            }
        }

        if (filteredRecall.length > 0) {
            // WO-F (2be3ad5) — drop the internal scene number from the header so it never leaks
            // into the GM prompt. The scene id is a storage detail; the AI should recall scenes by
            // content, not by number (and surgical deletes can leave gaps that would confuse it).
            const text = `[ARCHIVE RECALL — VERBATIM PAST SCENES]\n${filteredRecall.map(s => `[PAST SCENE]\n${s.content}`).join('\n\n')}\n[END ARCHIVE RECALL]`;
            worldBlocks.push({ source: 'Archive Recall', content: text, tokens: countTokens(text), reason: `Verbatim history (${filteredRecall.length} scenes)` });
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

            const includedEvents: SceneEvent[] = [];
            for (const event of sortedEvents) {
                const tempText = renderSceneEvents([...includedEvents, event]);
                if (countTokens(tempText) <= SCENE_EVENTS_TOKEN_BUDGET) {
                    includedEvents.push(event);
                } else {
                    break;
                }
            }

            if (includedEvents.length > 0) {
                const eventsText = renderSceneEvents(includedEvents);
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
    // undefined, [], or non-empty. Dedup uses the post-filter regular-recall IDs
    // (empty set when no regular recall rendered). Perceptual filter: elevated
    // scenes are subject to the same witness semantics as regular recall — broadcast
    // scenes (no witness data) always pass; witnessed scenes only if at least one
    // witness is in the active/on-stage NPC set. An unwitnessed elevated scene must
    // not surface merely because ordinary recall is empty. The scope was already
    // restricted to synopsis-tier scenes at gather time (computeSynopsisScope), so
    // the LOD history from WO-09 is never touched — elevation is a new path beside
    // it, not a modification. The elevated block stays a worldBlocks entry with
    // source: 'Dynamic Elevation' so it rides below the cache boundary (never in
    // history, stable, pinned, divergence, or a system message).
    if (elevatedScenes && elevatedScenes.length > 0) {
        let elevated = dedupElevatedScenes(elevatedScenes, regularRecallIds);

        // Perceptual filter — mirrors the archiveRecall filter above. Applies in
        // every shape (including when ordinary recall is empty) so an unwitnessed
        // elevated scene never leaks through.
        if (archiveIndex && npcLedger && archiveIndex.some(e => e.witnesses && e.witnesses.length > 0)) {
            const activeNpcIds = new Set(npcLedger.filter(n => !n.archived).map(n => n.id));
            if (onStageNpcIds) {
                for (const id of onStageNpcIds) activeNpcIds.add(id);
            }
            const sceneWitnessMap = new Map(archiveIndex.map(e => [e.sceneId, e.witnesses]));
            const before = elevated.length;
            elevated = elevated.filter(scene => {
                const witnesses = sceneWitnessMap.get(scene.sceneId);
                if (!witnesses || witnesses.length === 0) return true; // broadcast
                return witnesses.some(w => activeNpcIds.has(w));
            });
            if (isDebug && before > elevated.length) {
                collector.addTrace({ source: 'Dynamic Elevation', classification: 'world_context', tokens: 0, reason: `Perceptual filter removed ${before - elevated.length} elevated scene(s) (not witnessed by active NPCs)`, included: false });
            }
        }

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
                const body = scenes.map(s => `[PAST SCENE]\n${s.content}`).join('\n\n');
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
            const npcSegments: { npcId: string; content: string; tokens: number }[] = [];

            for (const npc of activeNPCs) {
                // Core tier — always injected.
                const coreParts: string[] = [minifyNPC(npc, relationshipMemoryEnabled)];
                const coreDirective = buildCoreDirective(npc, relationshipMemoryEnabled);
                if (coreDirective) coreParts.push(coreDirective);
                const coreLine = coreParts.join(' | ');

                // Extended tier — scene-tagged.
                const extParts: string[] = [];
                const extDirective = buildExtendedDirective(npc, plannerTags);
                if (extDirective) extParts.push(extDirective);
                const drift = buildDriftAlert(npc);
                if (drift && fieldTagMatches('drift', npc.fieldTags, plannerTags)) extParts.push(drift);
                if (archiveIndex && fieldTagMatches('knowledgeBoundary', npc.fieldTags, plannerTags)) {
                    const divergenceFacts = divergenceRegister?.entries;
                    const boundary = buildKnowledgeBoundary(npc, archiveIndex, divergenceFacts);
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
                npcSegments.push({ npcId: npc.id, content: fullLine, tokens: countTokens(fullLine) });
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

            const npcText = `[ACTIVE NPC CONTEXT]\n${npcSegments.map(s => s.content).join('\n')}\n[END NPC CONTEXT]`;
            worldBlocks.push({
                source: 'Active NPCs',
                content: npcText,
                tokens: countTokens(npcText),
                reason: `NPCs detected in context (${activeNPCs.length}, tiered core+extended)`,
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
            worldBlocks.push({ source: 'Scoped Knowledge', content, tokens: countTokens(content), reason: `Per-fact knowledge bounded to present cast (${scoped.length})` });
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
    if (divergenceRegister && divergenceRegister.entries.length > 0) {
        const regText = renderRegisterForPayload(divergenceRegister, chapters, undefined, undefined, true);
        if (regText) {
            divergenceRegText = regText;
            divergenceTokens = countTokens(regText);
            collector.addTrace({ source: 'Established Facts', classification: 'world_context', tokens: divergenceTokens, reason: `Campaign canon — public facts (${divergenceRegister.entries.length} entries)`, included: true, position: 'system_cacheable', preview: regText });
            collector.addSection({ label: 'Established Facts', role: 'system', tokens: divergenceTokens, content: regText, classification: 'world_context' });
        }
    }

    if (semanticFactText) {
        worldBlocks.push({ source: 'Semantic Facts', content: semanticFactText, tokens: countTokens(semanticFactText), reason: 'Injected verified facts' });
    }

    // --- 4. Budget & Trim World Context (two-phase: NPC floor decoupled) ---
    // Divergence is emitted as its own (high-priority, cacheable) system message but draws from
    // the same world allocation, so reserve its tokens up front rather than letting the trimmable
    // blocks consume the full budget and overrun once divergence is added back in payloadBuilder.
    //
    // Phase 2 (877c6eb): the [ACTIVE NPC CONTEXT] block gets a guaranteed `npcBudgetFloor` slice,
    // decoupled from the world budget so lore/archive pressure can never starve the scene's
    // actors. The NPC block is trimmed first against its floor; any unused floor flows back to
    // the general world pool for the remaining blocks. Fixes the packing-order problem where NPCs
    // (packed mid-stream) could be starved by lore pressure.
    const npcBlockIndex = worldBlocks.findIndex(b => b.source === 'Active NPCs');
    const npcBlock = npcBlockIndex >= 0 ? worldBlocks[npcBlockIndex] : null;

    let worldContent = '';
    let currentWorldTokens = 0;

    // Phase 1: the NPC block (if present) is admitted against its dedicated floor. Unused floor
    // flows back to the world pool. If the block exceeds the floor it still gets admitted (NPCs
    // are the headline of a scene) but the overflow counts against the general world budget.
    let npcFloorUsed = 0;
    if (npcBlock) {
        if (npcBlock.tokens <= npcBudgetFloor) {
            worldContent = npcBlock.content;
            currentWorldTokens = npcBlock.tokens;
            npcFloorUsed = npcBlock.tokens;
            collector.addTrace({ source: npcBlock.source, classification: 'world_context', tokens: npcBlock.tokens, reason: npcBlock.reason, included: true, position: 'system_dynamic' });
            collector.addSection({ label: npcBlock.source, role: 'system', tokens: npcBlock.tokens, content: npcBlock.content, classification: 'world_context' });
        } else {
            // Block exceeds the floor — admit it whole (NPCs headline the scene) but the overflow
            // counts against the world budget; the remaining blocks get the residual.
            worldContent = npcBlock.content;
            currentWorldTokens = npcBlock.tokens;
            npcFloorUsed = npcBudgetFloor; // only the floor portion is "decoupled"; overflow is on the world budget
            collector.addTrace({ source: npcBlock.source, classification: 'world_context', tokens: npcBlock.tokens, reason: `${npcBlock.reason} (exceeded ${npcBudgetFloor}t NPC floor; overflow charged to world budget)`, included: true, position: 'system_dynamic' });
            collector.addSection({ label: npcBlock.source, role: 'system', tokens: npcBlock.tokens, content: npcBlock.content, classification: 'world_context' });
        }
    }
    // Unused NPC floor flows back to the world pool.
    const worldPoolAfterNpc = Math.max(0, budgetWorld - divergenceTokens - npcFloorUsed);

    // Phase 2: trim the remaining blocks against the residual world pool.
    for (let i = 0; i < worldBlocks.length; i++) {
        if (i === npcBlockIndex) continue; // already admitted
        const block = worldBlocks[i];
        if (currentWorldTokens + block.tokens <= worldPoolAfterNpc + npcFloorUsed) {
            worldContent += (worldContent ? '\n\n' : '') + block.content;
            currentWorldTokens += block.tokens;
            collector.addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: block.reason, included: true, position: 'system_dynamic' });
            collector.addSection({ label: block.source, role: 'system', tokens: block.tokens, content: block.content, classification: 'world_context' });
        } else {
            collector.addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: `Dropped: Exceeds World budget (${worldPoolAfterNpc + npcFloorUsed} t residual after ${divergenceTokens} t divergence reserve + ${npcFloorUsed} t NPC floor)`, included: false, position: 'system_dynamic' });
        }
    }

    return { worldContent, currentWorldTokens, divergenceContent: divergenceRegText, divergenceTokens, plannerEventTypes, relationsBlock };
}
