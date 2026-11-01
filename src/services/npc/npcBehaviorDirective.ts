import type { NPCEntry, HexAxis, ArchiveIndexEntry, DivergenceEntry } from '../../types';
import { relationBand, describeHex, formatHexShift, formatRungShift } from './agency/agencyBands';
import { buildReactionMenu, type ReactionContext } from './reactionMenu';
import { applyRepressionToMenu } from './reactionRepression';
import { readPcAffinity } from './affinityAccess';
import { parseKnownByToken, parseFactions } from '../campaign-state/knowledgeScope';
import { createWitnessResolver, type WitnessResolver } from './witnessResolve';

function truncate(s: string, max: number): string {
    if (!s || s.length <= max) return s;
    return s.substring(0, max) + '…';
}

export type BehaviorDirectiveOpts = {
    context?: ReactionContext; // Phase 2 §9.1 — peaceful/dangerous filters the reaction menu
    rng?: () => number;         // injected for deterministic tests
    matureMode?: boolean;       // mirrors agencyWantDraw mature gating
    relationshipMemoryEnabled?: boolean;
};

export function buildBehaviorDirective(npc: NPCEntry, opts: BehaviorDirectiveOpts = {}): string {
    const parts: string[] = [];

    // PC edge as a word band (-3..+3); numbers never reach the LLM. Routed through the
    // one affinity accessor (WO-4 §2). Unset reads Neutral.
    const affinityRead = readPcAffinity(npc, opts.relationshipMemoryEnabled);
    if (affinityRead.kind !== 'stance') {
        parts.push(`[Aff: ${relationBand(affinityRead.kind === 'pcRelation' ? affinityRead.value : 0)}]`);
    }

    if (npc.personalityHex) {
        parts.push(`Personality: ${describeHex(npc.personalityHex)}`);
    } else if (npc.personality) {
        // Hex-less NPC: show free-text personality so the model still has a read.
        parts.push(npc.personality);
    }

    if (npc.wants) {
        if (npc.wants.long) parts.push(`GOAL: ${truncate(npc.wants.long, 80)}`);
        if (npc.wants.medium?.[0]) parts.push(`PURSUING: ${truncate(npc.wants.medium[0], 60)}`);
        if (npc.wants.short?.[0]) parts.push(`NOW: ${truncate(npc.wants.short[0], 40)}`);
    }

    if (npc.hardBoundaries && npc.hardBoundaries.length > 0) {
        parts.push(`WON'T: ${npc.hardBoundaries.map(b => truncate(b, 40)).join('; ')}`);
    }

    if (npc.softBoundaries && npc.softBoundaries.length > 0) {
        parts.push(`RESENTS: ${npc.softBoundaries.map(b => truncate(b, 40)).join('; ')}`);
    }

    if (npc.behavioralTriggers && npc.behavioralTriggers.length > 0) {
        parts.push(`ON "${npc.behavioralTriggers[0].keyword}": ${truncate(npc.behavioralTriggers[0].shift, 50)}`);
        for (let i = 1; i < npc.behavioralTriggers.length; i++) {
            const t = npc.behavioralTriggers[i];
            parts.push(`ON "${t.keyword}": ${truncate(t.shift, 50)}`);
        }
    }

    const voice = npc.voice || '';
    if (voice) parts.push(`Voice: ${truncate(voice, 60)}`);

    const example = npc.exampleOutput || '';
    if (example) parts.push(`Example: ${truncate(example, 80)}`);

    // Phase 2 §9.1 — engine-built reaction menu (extracted to buildReactionMenuLine so the
    // payload world-context path can inject the same line for on-stage NPCs; see world.ts).
    const menuLine = buildReactionMenuLine(npc, opts);
    if (menuLine) parts.push(menuLine);

    return `PLAY AS: ${parts.join(' | ')}`;
}

/**
 * Phase 2 §9.1 — the engine-built reaction menu line, as a standalone string.
 *
 * The engine scores REACTION_VOCAB against the NPC's fixed hex+traits and surfaces rank-1 + 2
 * sampled alternatives. The story AI may only pick ONE — the load-bearing enforcement clause
 * prevents it inventing a softer, out-of-character reaction (the sycophant-smoothing failure mode).
 * Returns '' for legacy hex-less NPCs or when the menu is empty.
 *
 * Exported because the payload assembler (`payload/world.ts`) injects this same line for on-stage
 * NPCs — `buildBehaviorDirective` is no longer the production payload path. Keep ONE implementation
 * here so both callers stay in lockstep.
 *
 * NOTE: `context` defaults to 'peaceful'; wire it from encounter/combat state at the call site (a
 * later refinement). `matureMode` threads the same gate the want/action draws use.
 *
 * The repression `event` (pressure delta / catharsis) is intentionally DISCARDED here — this is a
 * read path that can re-run, so booking happens once-per-turn elsewhere (postTurnPipeline), never in
 * payload assembly. See reactionRepression.ts.
 */
export function buildReactionMenuLine(npc: NPCEntry, opts: BehaviorDirectiveOpts = {}): string {
    if (!npc.personalityHex) return '';
    const context = opts.context ?? 'peaceful';
    const rng = opts.rng ?? Math.random;
    const matureMode = opts.matureMode ?? false;
    const rawMenu = buildReactionMenu(npc, context, rng, matureMode, opts.relationshipMemoryEnabled);
    const { menu } = applyRepressionToMenu(rawMenu, npc, context, rng);
    if (menu.length === 0) return '';
    // Fallback switch point — if playtest shows the AI still always grabs the gentlest, replace the
    // menu with a single engine-picked reaction (rank-1 or weighted-random) asserted as fact, same
    // principle as the dice forcing function. Ship AI-picks-from-menu first; keep engine-picks in reserve.
    return `REACTIONS (choose ONE and play it — do NOT invent a softer reaction; prefer the less obvious when several fit): ${menu.join(' | ')}`;
}

export function buildDriftAlert(npc: NPCEntry): string | null {
    if (!npc.previousSnapshot) return null;
    if (npc.shiftTurnCount !== undefined && npc.shiftTurnCount >= 3) return null;

    const shifts: string[] = [];
    const prev = npc.previousSnapshot;

    const currentPersonality = npc.personality || '';
    if (prev.personality !== undefined && prev.personality !== currentPersonality && prev.personality !== '' && currentPersonality !== '') {
        shifts.push('personality changed');
    }

    if (prev.voice !== undefined && prev.voice !== '' && npc.voice !== '' && prev.voice !== npc.voice) {
        shifts.push('voice changed');
    }

    // WO-05 §C — hex-axis drift surfaces as a word-band SHIFT (never the raw integer).
    // Only emit when the band word actually changes; a sub-band ±1 move that stays in the same
    // word isn't worth surfacing (formatHexShift returns '' in that case).
    if (prev.personalityHex && npc.personalityHex) {
        const axes: HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];
        for (const axis of axes) {
            const line = formatHexShift(axis, prev.personalityHex[axis], npc.personalityHex[axis]);
            if (line) shifts.push(line.replace('SHIFT: ', ''));
        }
    }

    // WO-05 §A — pcRelation drift surfaces as a word-band SHIFT (never the raw -3..+3 integer).
    if (prev.pcRelation !== undefined && npc.pcRelation !== undefined
        && prev.pcRelation !== npc.pcRelation) {
        const fromWord = relationBand(prev.pcRelation);
        const toWord = relationBand(npc.pcRelation);
        if (fromWord !== toWord) {
            shifts.push(`feeling toward PC ${fromWord} → ${toWord}`);
        }
    }

    // WO-06 §2 — rung bump surfaces as a word-band SHIFT (never the integer 0..4).
    if (prev.skillRung !== undefined && npc.skillRung !== undefined
        && prev.skillRung !== npc.skillRung) {
        const rungShift = formatRungShift(prev.skillRung, npc.skillRung);
        if (rungShift) shifts.push(rungShift.replace('SHIFT: ', ''));
    }

    if (shifts.length === 0) return null;
    return `SHIFT: ${shifts.join(', ')}`;
}

export function buildKnowledgeBoundary(
    npc: NPCEntry,
    archiveIndex: ArchiveIndexEntry[],
    divergenceFacts?: DivergenceEntry[],
    resolveWitness?: WitnessResolver,
): string {
    const parts: string[] = [];

    // ── Layer 1: scene-witness filter ──
    // Witness lists hold names that may be short ("Rin" for "Rin Holmes") or an
    // alias; resolve them against the ledger rather than comparing names exactly.
    if (archiveIndex && archiveIndex.length > 0) {
        const resolve = resolveWitness ?? createWitnessResolver([npc]);
        const witnessedSceneIds = new Set(
            archiveIndex
                .filter(e => (e.witnesses ?? []).some(w =>
                    resolve(w).some(n => n.id === npc.id)
                ))
                .map(e => e.sceneId)
        );

        const unknownEvents = archiveIndex.filter(
            e => !witnessedSceneIds.has(e.sceneId) && e.importance && e.importance >= 6
        );

        if (unknownEvents.length > 0) {
            const snippets = unknownEvents
                .slice(0, 5)
                .map(e => `Scene ${e.sceneId}: ${e.userSnippet}`)
                .join('; ');
            parts.push(`KNOWLEDGE LIMITS: This NPC was NOT present for: [${snippets}]. Do not reference these events in dialogue unless another character told them about it.`);
        }
    }

    // ── Layer 2: divergence-fact knownBy tokens (additive) ──
    if (divergenceFacts && divergenceFacts.length > 0) {
        const npcFactions = parseFactions(npc.faction);
        const unknownFacts: string[] = [];
        for (const fact of divergenceFacts) {
            if (fact.enabled === false) continue;
            if (fact.knownBy === undefined) continue; // public — everyone knows
            if (fact.knownBy.length === 0) {
                // secret — nobody knows; treat as unknown to this NPC too
                unknownFacts.push(fact.text);
                continue;
            }
            let npcKnows = false;
            for (const tok of fact.knownBy) {
                const parsed = parseKnownByToken(tok);
                if (!parsed) continue;
                if (parsed.kind === 'npc' && parsed.id === npc.id) { npcKnows = true; break; }
                if (parsed.kind === 'faction' && npcFactions.includes(parsed.name)) { npcKnows = true; break; }
            }
            if (!npcKnows) unknownFacts.push(fact.text);
        }
        if (unknownFacts.length > 0) {
            const snippets = unknownFacts.slice(0, 5).map(t => `[${t}]`).join(' ');
            parts.push(`UNKNOWN FACTS: This NPC does not know: ${snippets}. Do not reference these in dialogue unless another character told them.`);
        }
    }

    return parts.join('\n  ');
}
