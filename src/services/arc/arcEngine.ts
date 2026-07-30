// Arc Engine — Phase 3 port wrapper. Mobile source: turnPostProcess.ts:938-1070
// (runArcTick). Faithful port with the minimal desktop adaptations:
//   - The real AiTier gate is wired at the caller: `postTurnPipeline.ts:304` wraps both
//     the dynamic import of this module and the `runArcTick` call in
//     `if (tierAllows(state.settings.aiTier, 'arcTick'))`. On lite this function is never
//     entered, so the local stub below is a redundant inner guard, not a hole. The stub
//     stays because removing it would be a behaviour change this work order promises
//     none (WORKORDER-P5-01 §3).
//   - `mergeSealEntries` + `DivergenceEntry` are imported from desktop's divergenceRegister
//     module (signature matches mobile's).

import type { ArcRecord, DivergenceEntry } from '../../types';
import type { TurnState, TurnCallbacks } from '../turn/turnOrchestrator';
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

export function runArcTick(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    lastAssistantContent: string,
): void {
    if (!tierAllows(state.settings.aiTier, 'arcTick')) return;
    const arcs = state.context.arcs;
    if (!arcs || arcs.length === 0) return;

    const archiveIndex = state.archiveIndex;
    const sceneId = archiveIndex.length > 0
        ? archiveIndex[archiveIndex.length - 1].sceneId
        : '000';

    // Stance scan — deterministic, +0. Returns only arcs whose stance is determinable
    // this turn; we merge those onto the working copies and persist them.
    const activeArcs = arcs.filter(a => a.status === 'active');
    if (activeArcs.length === 0) return;

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

    if (arcsChanged) {
        callbacks.updateContext({ arcs: nextArcs });
    }

    // Fold the surface lines into context.arcDigest for the next GM call.
    if (digestLines.length > 0) {
        // Rebuild fresh from THIS tick's surface lines — never concat the prior digest
        // (stale rung lines were piling up across ticks). Dedupe as a safety net. (B1)
        const fresh = Array.from(new Set(digestLines)).join('\n');
        callbacks.updateContext({ arcDigest: fresh });
    }

    // Write avoidance facts to divergenceRegister (mergeSealEntries appends).
    if (divergenceFacts.length > 0) {
        const liveRegister = state.divergenceRegister;
        if (liveRegister && callbacks.setDivergenceRegister) {
            const merged = mergeSealEntries(liveRegister, divergenceFacts, sceneId);
            callbacks.setDivergenceRegister(merged);
            console.log(`[ArcTick] ${divergenceFacts.length} arc divergence fact(s) written`);
        } else {
            // No live register / callback this turn — surface the facts as a system
            // marker so they aren't lost (rare; the seal seam usually has the register).
            for (const f of divergenceFacts) {
                callbacks.addMessage({
                    id: uid(),
                    role: 'system',
                    name: 'arc-fact',
                    content: `[World moved] ${f.text}`,
                    timestamp: Date.now(),
                });
            }
        }
    }
}