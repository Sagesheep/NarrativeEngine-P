// NPC Agency Engine — Phase 2 port wrapper. Mobile source: turnPostProcess.ts:531-927
// (runAgencyTick + runTimeskipPath + bumpOnStageActivity). Faithful port with the minimal
// desktop adaptations:
//   - The real AiTier gate is wired at the caller: `postTurnPipeline.ts:257` wraps the
//     `runAgencyTick` call in `if (tierAllows(state.settings.aiTier, 'heartbeatTick'))`, so
//     `timeskipRun` inside it is unreachable on lite too. On lite this function is never
//     entered, so the local stub below is a redundant inner guard, not a hole. The stub
//     stays because removing it would be a behaviour change this work order promises
//     none (WORKORDER-P5-01 §3).
//   - `state.getFreshSummarizerProvider` (mobile) → `state.getUtilityEndpoint` (desktop has no
//     separate summarizer slot; the utility endpoint is the closest low-priority background LLM).
//   - Prompt-section helpers (TTRPG_PERSONA_GM_ASSISTANT, joinPromptSections, ANCHOR_BEFORE_INPUT,
//     INPUT_DELIMITER) are inlined since desktop has no shared infrastructure/utilityPrompts module.

import type { NPCEntry, SceneStakes } from '../../../types';
import type { TurnState, TurnCallbacks } from '../../turn/turnOrchestrator';
import type { HostFacade } from '../../turn/hostFacade';
import { uid } from '../../../utils/uid';
import { llmCall } from '../../../utils/llmCall';
import { backgroundQueue } from '../../infrastructure/backgroundQueue';

import { HEARTBEAT_DC, GOAL_BASE_DC, COLLISION_TANGLE_PROB, type Band } from './agencyConstants';
import { rollHeartbeat, buildProximityRoster } from './agencyHeartbeat';
import { selectTickTarget, activityBumpPatch, currentActivity } from './agencyAudition';
import { upgradeWantsToGoals } from './agencyGoals';
import { chooseTick } from './agencySelection';
import { rollGoal, nextFailStreak } from './agencyDice';
import { applyBandToGoal } from './agencyProgress';
import { applyGoalOutcomeNudge, applyTierCross } from './agencyDrift';
import { detectCollision, resolveTangle, buildTangleDeltas } from './agencyCollision';
import { buildDigest, visibilityFromBand, type TickDelta } from './agencyDigest';
import { detectTimeskip, runTimeskip } from './agencyTimeskipRun';
import { isAgencyEligible } from './agencyLifecycle';

// Redundant inner guard — the caller in postTurnPipeline.ts already gates this on the
// real `tierAllows` before the call. On lite this function is never entered (a no-op when
// no NPCs have goalRecords, which is all legacy NPCs until populateAgencyFields fills wants).
// Kept as a stub (returns true) because removing it is a behaviour change (WORKORDER-P5-01 §3).
function tierAllows(tier: unknown, feature: string): boolean {
    void tier;
    void feature;
    return true;
}

// Inlined from mobile's services/infrastructure/utilityPrompts (desktop has no equivalent).
const TTRPG_PERSONA_GM_ASSISTANT = 'You are a background GM assistant running silently.';
const ANCHOR_BEFORE_INPUT = 'Now produce the JSON described above for the INPUT below.';
const INPUT_DELIMITER = '----- INPUT -----';
function joinPromptSections(...sections: Array<string | null | undefined>): string {
    return sections.filter(Boolean).join('\n\n');
}

export function runAgencyTick(
    state: TurnState,
    callbacks: TurnCallbacks,
    npcLedger: NPCEntry[],
    displayInput: string,
    facade?: HostFacade,
): void {
    if (!npcLedger || npcLedger.length === 0) return;

    const writeCallbacks = facade
        ? { ...callbacks, updateContext: facade.write.updateContext, updateNPC: facade.write.updateNPC }
        : callbacks;
    const context = facade?.data.context ?? state.context;
    const aiTier = facade?.config.aiTier ?? state.settings.aiTier;
    const sceneStakes: SceneStakes = context.lastSceneStakes ?? 'calm';
    const currentTick = context.agencyTick ?? 0;
    const currentDc = context.agencyHeartbeatDC ?? HEARTBEAT_DC.initial;

    // ── Timeskip detection (§9.7 Piece D, +1 LLM) ──
    const timeskipResult = detectTimeskip(displayInput);
    if (timeskipResult && !('ambiguous' in timeskipResult) && timeskipResult.weeks > 0) {
        if (tierAllows(aiTier, 'timeskipRun')) {
            runTimeskipPath(state, callbacks, npcLedger, timeskipResult.weeks, currentTick, sceneStakes);
            return;
        }
    }

    // ── Heartbeat trickle (§5/§9.3#1, +0 LLM) ──
    if (!tierAllows(aiTier, 'heartbeatTick')) return;

    const heartbeat = rollHeartbeat({ dc: currentDc });
    writeCallbacks.updateContext({ agencyHeartbeatDC: heartbeat.nextDc });

    if (!heartbeat.fired) return;

    const pc = state.context.playerCharacter ?? npcLedger.find(n => n.isPC);
    const roster = buildProximityRoster(npcLedger, pc);
    if (roster.length === 0) return;

    const now = currentTick + 1;
    const { pick, isAudition, deepTier } = selectTickTarget(roster, now);
    if (!pick) return;
    if (isAudition) {
        console.log(`[AgencyTick] heartbeat tick=${now} audition pick=${pick.id} (deepTier=${deepTier.map(n => n.id).join(',')})`);
    }

    // ── Goal upgrade: idempotent wants→goalRecords migration (§9.6) ──
    const updatedNpc = { ...pick };
    if (!updatedNpc.goalRecords || updatedNpc.goalRecords.length === 0) {
        const goals = upgradeWantsToGoals(updatedNpc, now);
        if (goals.length > 0) {
            updatedNpc.goalRecords = goals;
            writeCallbacks.updateNPC(updatedNpc.id, { goalRecords: goals });
        }
    }

    // ── Choose tick (§9.5) ──
    const tickChoice = chooseTick(updatedNpc, now, sceneStakes);
    if (tickChoice.kind === 'idle') return;

    // ── Hard gate: pre-roll check, no karma (§9.6 exception 1) ──
    if (tickChoice.kind === 'goal') {
        const goal = tickChoice.goal;
        if (goal.state !== 'active') return;

        // ── WO-08 Piece E: event collision detection ──
        const collisionCandidates = [...deepTier, pick].filter(n => n.id !== pick.id);
        const collision = detectCollision(pick, goal, collisionCandidates, sceneStakes);
        if (collision && Math.random() < COLLISION_TANGLE_PROB) {
            const partner = collision.partner;
            const partnerGoal = collision.partnerGoal;

            const outcome = resolveTangle(pick, goal, partner, partnerGoal, collision.tone);

            // Pick (NPC a)
            const aUpdatedGoal = applyBandToGoal(goal, outcome.aBand, now);
            const aNewFailStreak = nextFailStreak(goal.failStreak, outcome.aBand);
            const aResolvedGoal = { ...aUpdatedGoal, failStreak: aNewFailStreak };
            const aGoalRecords = (updatedNpc.goalRecords ?? []).map(g =>
                g.text === goal.text && g.horizon === goal.horizon ? aResolvedGoal : g
            );
            writeCallbacks.updateNPC(updatedNpc.id, { goalRecords: aGoalRecords });

            // Partner (NPC b)
            const updatedPartner = { ...partner };
            const bUpdatedGoal = applyBandToGoal(partnerGoal, outcome.bBand, now);
            const bNewFailStreak = nextFailStreak(partnerGoal.failStreak, outcome.bBand);
            const bResolvedGoal = { ...bUpdatedGoal, failStreak: bNewFailStreak };
            const bGoalRecords = (updatedPartner.goalRecords ?? []).map(g =>
                g.text === partnerGoal.text && g.horizon === partnerGoal.horizon ? bResolvedGoal : g
            );
            writeCallbacks.updateNPC(updatedPartner.id, { goalRecords: bGoalRecords });

            writeCallbacks.updateContext({ agencyTick: now });

            const tangleDeltas = buildTangleDeltas(
                updatedNpc, goal, outcome.aBand,
                updatedPartner, partnerGoal, outcome.bBand,
                collision.tone,
            );

            const existingDigest = state.context.agencyDigest ?? '';
            const newDigest = buildDigest(tangleDeltas, 'player');
            if (newDigest) {
                const combined = existingDigest ? existingDigest + '\n' + newDigest : newDigest;
                writeCallbacks.updateContext({ agencyDigest: combined });
            }
            const debugDigest = buildDigest(tangleDeltas, 'debug');
            if (debugDigest) {
                console.log(`[AgencyTick] heartbeat tick=${now} tangle ${collision.tone} npc=${updatedNpc.id}+${updatedPartner.id}\n${debugDigest}`);
            }
            return;
        }

        // ── Solo path ──
        const result = rollGoal(goal, GOAL_BASE_DC);
        const band: Band = result.band;

        const updatedGoal = applyBandToGoal(goal, band, now);
        const newFailStreak = nextFailStreak(goal.failStreak, band);
        const resolvedGoal = { ...updatedGoal, failStreak: newFailStreak };

        const goalRecords = (updatedNpc.goalRecords ?? []).map(g =>
            g.text === goal.text && g.horizon === goal.horizon
                ? resolvedGoal
                : g
        );
        writeCallbacks.updateNPC(updatedNpc.id, { goalRecords });

        // WO-05 §D + WO-06 §1 — engine-resolve nudge (hex drift) AND rung-ladder tier-cross
        const nudge = applyGoalOutcomeNudge(updatedNpc, goal, band);
        const tierCross = applyTierCross(updatedNpc, resolvedGoal);
        if (nudge.hexPatch || tierCross) {
            const patch: Partial<NPCEntry> = {};
            if (tierCross) {
                patch.goalRecords = goalRecords.map(g =>
                    g.text === updatedGoal.text && g.horizon === updatedGoal.horizon
                        ? tierCross.updatedGoal
                        : g
                );
            }
            if (nudge.hexPatch) patch.personalityHex = nudge.hexPatch;
            if (tierCross && tierCross.rungPatch !== undefined) patch.skillRung = tierCross.rungPatch;
            patch.previousSnapshot = {
                personality: updatedNpc.personality || updatedNpc.disposition || '',
                voice: updatedNpc.voice || '',
                affinity: updatedNpc.affinity,
                personalityHex: updatedNpc.personalityHex,
                pcRelation: updatedNpc.pcRelation,
                skillRung: updatedNpc.skillRung,
            };
            patch.shiftTurnCount = 0;
            writeCallbacks.updateNPC(updatedNpc.id, patch);
            if (nudge.shiftLine) console.log(`[AgencyTick] hex nudge npc=${updatedNpc.id} ${nudge.shiftLine}`);
            if (tierCross && tierCross.rungShiftLine) console.log(`[AgencyTick] rung cross npc=${updatedNpc.id} ${tierCross.rungShiftLine}`);
        }

        writeCallbacks.updateContext({ agencyTick: now });

        const visibility = visibilityFromBand(band, goal.horizon);
        const delta: TickDelta = {
            npcId: updatedNpc.id,
            npcName: updatedNpc.name,
            goalText: goal.text,
            horizon: goal.horizon,
            band,
            visibility,
            note: '',
        };

        const existingDigest = state.context.agencyDigest ?? '';
        const newDigest = buildDigest([delta], 'player');
        if (newDigest) {
            const combined = existingDigest ? existingDigest + '\n' + newDigest : newDigest;
            writeCallbacks.updateContext({ agencyDigest: combined });
        }

        const debugDigest = buildDigest([delta], 'debug');
        if (debugDigest) {
            console.log(`[AgencyTick] heartbeat tick=${now} npc=${updatedNpc.id} band=${band} vis=${visibility}\n${debugDigest}`);
        }
    } else if (tickChoice.kind === 'color') {
        writeCallbacks.updateContext({ agencyTick: now });
        console.log(`[AgencyTick] heartbeat tick=${now} npc=${updatedNpc.id} kind=color (novelty whiplash — no goal delta)`);
    } else if (tickChoice.kind === 'need') {
        writeCallbacks.updateContext({ agencyTick: now });
        console.log(`[AgencyTick] heartbeat tick=${now} npc=${updatedNpc.id} kind=need (all goals blocked)`);
    }

    // WO-07 Piece D: activity bump on every non-idle, non-blocked tick.
    writeCallbacks.updateNPC(updatedNpc.id, activityBumpPatch(updatedNpc, now));
}

/**
 * WO-07 Piece D completion: bump activity for every NPC that was on-stage last turn. The on-stage
 * signal is the real driver: ALL on-stage NPCs get +1 per turn, vs one NPC per heartbeat via the
 * tick. With 3 on-stage NPCs, that's +3/turn total vs +1/heartbeat — sustained on-stage presence
 * reaches ACTIVITY_PROMOTE in ~5 turns; off-stage NPCs decay to 0 in ~6 beats. The deep tier
 * naturally tracks the player's active social circle and rotates between scenes.
 *
 * Pure, synchronous, +0 LLM. Runs unconditionally (not tier-gated). `state.onStageNpcIds` is the
 * previous turn's on-stage set (set via callbacks.setOnStageNpcIds during the previous turn's
 * post-processing).
 */
export function bumpOnStageActivity(
    state: TurnState,
    callbacks: TurnCallbacks,
    npcLedger: NPCEntry[],
): void {
    const onStageIds = state.onStageNpcIds;
    if (!onStageIds || onStageIds.length === 0) return;

    const now = (state.context.agencyTick ?? 0) + 1;

    const npcById = new Map<string, NPCEntry>();
    for (const npc of npcLedger) npcById.set(npc.id, npc);

    for (const id of onStageIds) {
        const npc = npcById.get(id);
        if (!npc) continue;
        if (!isAgencyEligible(npc)) continue;
        callbacks.updateNPC(id, activityBumpPatch(npc, now));
    }
}

// ── Timeskip path (+1 batched LLM for narration, engine state only otherwise) ──
function runTimeskipPath(
    state: TurnState,
    callbacks: TurnCallbacks,
    npcLedger: NPCEntry[],
    weeks: number,
    currentTick: number,
    sceneStakes: SceneStakes,
): void {
    const pc = state.context.playerCharacter ?? npcLedger.find(n => n.isPC);
    const roster = buildProximityRoster(npcLedger, pc);

    // Upgrade wants→goals for all roster NPCs idempotently before simulation
    const upgradedRoster = roster.map(npc => {
        if (!npc.goalRecords || npc.goalRecords.length === 0) {
            const goals = upgradeWantsToGoals(npc, currentTick);
            if (goals.length > 0) {
                const upgraded = { ...npc, goalRecords: goals };
                callbacks.updateNPC(npc.id, { goalRecords: goals });
                return upgraded;
            }
        }
        return npc;
    });

    // Desktop has no dedicated summarizer slot; the utility endpoint is the closest low-priority
    // background LLM. Fall back to the main provider if no utility endpoint is configured.
    const provider = state.getUtilityEndpoint?.() ?? state.getFreshProvider();

    const result = runTimeskip({
        provider,
        roster: upgradedRoster,
        weeks,
        now: currentTick,
        sceneStakes,
        advanceTick: (by: number) => {
            const newTick = currentTick + by;
            callbacks.updateContext({ agencyTick: newTick });
            return newTick;
        },
    });

    // Persist NPC state deltas from the timeskip simulation.
    for (const npc of result.updatedNPCs) {
        const changed = !!npc.previousSnapshot;
        if (npc.goalRecords && !changed) {
            callbacks.updateNPC(npc.id, { goalRecords: npc.goalRecords });
        } else if (changed) {
            const patch: Partial<NPCEntry> = {};
            if (npc.goalRecords) patch.goalRecords = npc.goalRecords;
            if (npc.personalityHex !== undefined) patch.personalityHex = npc.personalityHex;
            if (npc.skillRung !== undefined) patch.skillRung = npc.skillRung;
            if (npc.previousSnapshot) patch.previousSnapshot = npc.previousSnapshot;
            if (npc.shiftTurnCount !== undefined) patch.shiftTurnCount = npc.shiftTurnCount;
            callbacks.updateNPC(npc.id, patch);
        }
    }

    callbacks.updateContext({ agencyTick: currentTick + result.ticksConsumed });

    // Build and store the digest (player-visible deltas, folded into next GM call, +0)
    if (result.deltas.length > 0) {
        const digestText = buildDigest(result.deltas, 'player');
        if (digestText) {
            const existing = state.context.agencyDigest ?? '';
            const combined = existing ? existing + '\n' + digestText : digestText;
            callbacks.updateContext({ agencyDigest: combined });
        }

        const debugText = buildDigest(result.deltas, 'debug');
        if (debugText) {
            console.log(`[AgencyTick] timeskip weeks=${weeks} ticks=${result.ticksConsumed}\n${debugText}`);
        }
    }

    // Timeskip narration: +1 LLM call (the ONLY additional LLM cost).
    if (result.narration && provider) {
        backgroundQueue.push('Timeskip-Narration', async () => {
            try {
                const narrationPrompt = joinPromptSections(
                    TTRPG_PERSONA_GM_ASSISTANT,
                    `Write the "what you return to" beat after a time-skip of about ${weeks.toFixed(1)} weeks.`,
                    `While the player was away, the world kept moving. Below are the off-screen developments that are now visible to the player — already decided, NOT for you to change. Weave them into a single cohesive in-fiction paragraph that lands when the player steps back into the scene: the sense that time genuinely passed and people pursued their own lives.`,
                    `RULES:
- 2-4 sentences, second person ("you return to find…"), present the changes as discovered, not narrated as a report.
- Dramatize ONLY the developments listed. Do NOT invent new characters, events, deaths, or plot twists beyond them.
- Use the characters' names exactly as given. Keep each development recognizable.
- No game mechanics, numbers, dice, percentages, or meta language — pure fiction.
- If the developments conflict in tone, hold them side by side; do not resolve or editorialize.`,
                    ANCHOR_BEFORE_INPUT,
                    INPUT_DELIMITER,
                    `OFF-SCREEN DEVELOPMENTS:\n${result.narration}`,
                );
                const narrationText = await llmCall(provider, narrationPrompt, { priority: 'low', maxTokens: 300, thinkingEffort: 'off' });
                if (narrationText && narrationText.trim()) {
                    callbacks.addMessage({
                        id: uid(),
                        role: 'system',
                        name: 'timeskip-seam',
                        content: `[Time passes] ${narrationText.trim()}`,
                        timestamp: Date.now(),
                    });
                }
            } catch (err) {
                console.warn('[AgencyTick] Timeskip narration failed, using deterministic fallback:', err);
                if (result.narration) {
                    callbacks.addMessage({
                        id: uid(),
                        role: 'system',
                        name: 'timeskip-seam',
                        content: `[Time passes] ${result.narration}`,
                        timestamp: Date.now(),
                    });
                }
            }
        }).catch((e) => console.warn('[AgencyTick] Timeskip-Narration queue push failed:', e));
    }
}

// Re-export `currentActivity` for callers/tests that need to inspect lazy-decay activity.
export { currentActivity };