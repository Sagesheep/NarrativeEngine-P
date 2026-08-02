// Arc Engine — Phase 3 port wrapper. Mobile source: turnPostProcess.ts:938-1070
// (runArcTick). Faithful port with the minimal desktop adaptations:
//   - The real AiTier gate is wired at the caller: `postTurnPipeline.ts:304` wraps both
//     the dynamic import of this module and the `runArcTick` call in
//     `if (tierAllows(state.settings.aiTier, 'arcTick'))`. On lite this function is never
//     entered, so the local stub below is a redundant inner guard, not a hole. The stub
//     stays because removing it would be a behaviour change this work order promises
//     none (WORKORDER-P5-01 §3).
//
// WO-P5-12 §3 (THE TRAP): Arc's state must NOT live on `context.arcs`. It lives in a
// mod-declared table (`mod.arc.arcs`). `runArcTick` is now a PURE function: it takes the
// current arcs as input and returns the writes (next arcs, digest, divergence facts)
// as output. The caller persists them — to the mod table for arcs, to `context.arcDigest`
// for the digest (a prompt contribution, §3), and to the divergence register for facts
// (`applyArcDivergenceFacts`). A pure tick is also what makes the Step 3 extraction to
// `arc.compute.js` clean: the mod's `postTurn` hook becomes
// "read table → run tick → write table + updateContext".

import type { ArcRecord, DivergenceEntry, DivergenceRegister } from '../../types';
import { uid } from '../../utils/uid';
import { mergeSealEntries } from '../campaign-state/divergenceRegister';

import { rollArcTick, rollArcOutcome, advanceRung } from './arcDice';
import { scanArcStance } from './arcStance';
import { arcSurfaceLine } from './arcSurface';

// Redundant inner guard — the caller in postTurnPipeline.ts already gates this on the
// real `tierAllows` before the dynamic import. On lite this function is never entered.
// Kept as a stub (returns true) because removing it is a behaviour change (WORKORDER-P5-01 §3).
function tierAllows(tier: unknown, feature: string): boolean {
    void tier;
    void feature;
    return true;
}

/** The writes a tick produces. The caller persists each to its destination. */
export interface ArcTickResult {
    /** Next arcs (null if unchanged — caller may skip the write). */
    arcs: ArcRecord[] | null;
    /** Fresh arcDigest string for the next GM call (null if no surface lines). */
    arcDigest: string | null;
    /** Avoidance/consequence facts to merge into the divergence register. */
    divergenceFacts: DivergenceEntry[];
}

/**
 * Run the Arc Engine tick. PURE: no store reads, no writes, no side effects.
 *
 * @param arcs        the campaign's current ArcRecords (read from the mod table by the caller)
 * @param archiveIndex tail entry used to derive the sceneId for `lastTickScene` / facts
 * @param aiTier      the tier scalar (redundant inner guard — the caller already gates)
 * @param displayInput  the player's turn input (for stance scan)
 * @param lastAssistantContent  the GM's last reply (for stance scan)
 */
export function runArcTick(
    arcs: ArcRecord[],
    archiveIndex: { sceneId: string }[],
    aiTier: unknown,
    displayInput: string,
    lastAssistantContent: string,
): ArcTickResult {
    if (!tierAllows(aiTier, 'arcTick')) {
        return { arcs: null, arcDigest: null, divergenceFacts: [] };
    }
    if (!arcs || arcs.length === 0) {
        return { arcs: null, arcDigest: null, divergenceFacts: [] };
    }

    const sceneId = archiveIndex.length > 0
        ? archiveIndex[archiveIndex.length - 1].sceneId
        : '000';

    // Stance scan — deterministic, +0. Returns only arcs whose stance is determinable
    // this turn; we merge those onto the working copies and persist them.
    const activeArcs = arcs.filter(a => a.status === 'active');
    if (activeArcs.length === 0) {
        return { arcs: null, arcDigest: null, divergenceFacts: [] };
    }

    const stanceUpdates = scanArcStance(displayInput, lastAssistantContent, activeArcs);
    const stanceById = new Map(stanceUpdates.map(u => [u.arcId, u.stance]));

    let arcsChanged = false;
    const nextArcs: ArcRecord[] = [];
    const digestLines: string[] = [];
    const divergenceFacts: DivergenceEntry[] = [];

    for (const arc of arcs) {
        if (arc.status !== 'active') {
            nextArcs.push(arc);
            continue;
        }

        // Apply stance update if one was determined this turn.
        const newStance = stanceById.get(arc.id) ?? arc.stance;
        const stanceChanged = newStance !== arc.stance;
        let working = stanceChanged ? { ...arc, stance: newStance } : arc;

        // Tempo roll — mirrors rollHeartbeat. DC persists regardless of fire.
        const tick = rollArcTick(working);
        if (tick.fired) {
            // Outcome roll — d20 + stance mod vs base DC, reusing the agency band mapper.
            const outcome = rollArcOutcome(working);
            const advanced = advanceRung(working, outcome.band);
            // lastTickScene marks "this arc moved this scene" — the recency signal
            // arcWorldState reads to decide 'live' vs 'stalled'.
            working = { ...advanced, lastTickScene: sceneId };
            arcsChanged = true;

            // Avoidance/consequence rule (contract §5): on a 'direct' rung (or
            // boiled_over) with ignored/fled stance, write the rung label as a FACT
            // into divergenceRegister. The world moved without the player.
            const currentRung = working.ladder[working.currentRung];
            const isDirectOrBoiled = currentRung?.surface === 'direct' || working.status === 'boiled_over';
            const isAvoidant = working.stance === 'ignored' || working.stance === 'fled';
            if (isDirectOrBoiled && isAvoidant) {
                divergenceFacts.push({
                    id: uid(),
                    chapterId: `arc:${working.id}`,
                    category: 'world_state',
                    text: currentRung?.label ?? working.seed,
                    sceneRef: sceneId,
                    npcIds: [],
                    pinned: false,
                    source: 'auto',
                });
                console.log(`[ArcTick] arc=${working.id} stance=${working.stance} rung=${working.currentRung} → divergence fact written`);
            }

            // Defused: opposed stance + outcome regressed the arc to rung 0.
            if (working.stance === 'opposed' && working.currentRung === 0 && outcome.band === 'critFail') {
                working = { ...working, status: 'defused' };
                console.log(`[ArcTick] arc=${working.id} defused (opposed + regress to rung 0)`);
            }

            console.log(`[ArcTick] tick fired arc=${working.id} band=${outcome.band} rung=${working.currentRung} status=${working.status}`);
        } else {
            // Miss — persist the reduced DC (pity timer). If only the DC moved (no
            // rung change) we still need to write it back so the next seam sees it.
            if (tick.nextDc !== working.tickDC) {
                working = { ...working, tickDC: tick.nextDc };
                arcsChanged = true;
            }
            if (stanceChanged) arcsChanged = true;
        }

        // Surface line — the current rung → one digest line, tagged by surface tier.
        const line = arcSurfaceLine(working);
        if (line) digestLines.push(line);

        nextArcs.push(working);
    }

    // Fold the surface lines into context.arcDigest for the next GM call.
    let arcDigest: string | null = null;
    if (digestLines.length > 0) {
        // Rebuild fresh from THIS tick's surface lines — never concat the prior digest
        // (stale rung lines were piling up across ticks). Dedupe as a safety net. (B1)
        arcDigest = Array.from(new Set(digestLines)).join('\n');
    }

    return {
        arcs: arcsChanged ? nextArcs : null,
        arcDigest,
        divergenceFacts,
    };
}

/**
 * Apply a tick's divergence facts to the live register. Returns the merged register
 * (for `setDivergenceRegister`), or `null` if the caller should fall back to surfacing
 * the facts as system messages (no live register available this turn).
 */
export function applyArcDivergenceFacts(
    register: DivergenceRegister | undefined,
    facts: DivergenceEntry[],
    sceneId: string,
): DivergenceRegister | null {
    if (facts.length === 0) return null;
    if (!register) return null;
    return mergeSealEntries(register, facts, sceneId);
}