import type { HexAxis, NPCEntry, PersonalityHex } from '../../types';
import { REACTION_VOCAB, type ReactionEntry } from './agency/agencyPools';
import { pcRelationOf } from './affinityAccess';

// Re-export so existing import sites (`reactionRepression.ts`) keep working.
// The implementation lives in `affinityAccess.ts` — the one accessor every
// affinity reader goes through (WO-4 §2).
export { pcRelationOf };

// NPC Generation Refit (Phase 2 §9.1) — engine-built reaction menu.
//
// The story AI is a sycophant: asked "how does X react?" it invents the gentlest, most
// agreeable reaction. Fix: the engine builds the menu of allowed reactions from the NPC's
// fixed hex+traits; the AI only picks which one fits the moment. Out-of-character reactions
// never appear on the menu, so the AI cannot reach for them (jealousy is never offered to a
// loyal/high-empathy Kakashi).
//
// Pure engine, no LLM call. Runs per on-stage NPC per turn. Inject `rng` for deterministic
// tests (matches the codebase convention — see agencyWantDraw.ts / hexRoll.ts).

// Config constants (tunable per §9.1):
const CANDIDATE_POOL = 5;             // eligibility frontier ("made the top 5")
const SAMPLE_COUNT   = 2;             // surfaced besides rank-1
const SAMPLE_RANKS   = [1, 2, 3] as const; // 0-based indices into the top pool (= ranks 2–4)
const TRAIT_BONUS    = 2;             // per matching traitKey
const RELATION_CLOSE = 2;             // pcRelation >= this counts as a "close" bond (loyalty gates engage)

export type ReactionContext = 'peaceful' | 'dangerous';

/**
 * Fit score for a reaction against an NPC's hex+traits AND their relationship to the PC.
 * = Σ axisWeights[a] * hex[a]            (personality fit)
 *   + (relationWeight ?? 0) * pcRel      (relationship fit — a NEGATIVE weight, e.g. betrayal,
 *                                          scores HIGH at low/neutral trust and fades when liked)
 *   + (|traitKeys ∩ traits|) * TRAIT_BONUS.
 * Higher = more in-character right now. Pure: no mutation, no I/O.
 */
export function scoreReaction(r: ReactionEntry, npc: NPCEntry, pcRel: number): number {
    const hex: PersonalityHex | undefined = npc.personalityHex;
    let score = 0;
    if (hex) {
        const axes = Object.keys(r.axisWeights) as HexAxis[];
        for (const a of axes) {
            const w = r.axisWeights[a];
            if (typeof w === 'number') score += w * (hex[a] ?? 0);
        }
    }
    score += (r.relationWeight ?? 0) * pcRel;
    const traits = npc.traits ?? [];
    if (r.traitKeys && r.traitKeys.length > 0 && traits.length > 0) {
        const traitSet = new Set(traits);
        let hits = 0;
        for (const k of r.traitKeys) if (traitSet.has(k)) hits++;
        score += hits * TRAIT_BONUS;
    }
    return score;
}

/**
 * Hard include/exclude gate (trait-based, reuses the trait-hook vocabulary).
 * - `requireTraitAny`: if present, NPC must have ≥1 of the listed traits, else fail.
 * - `forbidTraitAny`: UNCONDITIONAL exclude — NPC must have NONE of the listed traits.
 * - `forbidTraitWhenClose`: RELATIONSHIP-scoped exclude — NPC must have NONE of these *only when
 *   the bond is close* (pcRel >= RELATION_CLOSE). Mirrors the `loyal` hook "won't betray
 *   Close/Devoted": a loyal NPC can still betray a stranger, never a trusted ally.
 * - `mature` tier entries fail unless `matureMode` is true (mirrors agencyWantDraw gating).
 * Returns true when the reaction is eligible for the NPC.
 */
export function passesGate(r: ReactionEntry, npc: NPCEntry, pcRel: number, matureMode: boolean): boolean {
    if (r.tier === 'mature' && !matureMode) return false;
    const traits = npc.traits ?? [];
    const traitSet = new Set(traits);
    const gate = r.gate;
    if (gate) {
        if (gate.requireTraitAny && gate.requireTraitAny.length > 0) {
            const hasAny = gate.requireTraitAny.some(t => traitSet.has(t));
            if (!hasAny) return false;
        }
        if (gate.forbidTraitAny && gate.forbidTraitAny.length > 0) {
            const hasAny = gate.forbidTraitAny.some(t => traitSet.has(t));
            if (hasAny) return false;
        }
        if (gate.forbidTraitWhenClose && gate.forbidTraitWhenClose.length > 0 && pcRel >= RELATION_CLOSE) {
            const hasAny = gate.forbidTraitWhenClose.some(t => traitSet.has(t));
            if (hasAny) return false;
        }
    }
    return true;
}

/**
 * Build the reaction menu the story AI must pick from.
 *
 * 1. filter REACTION_VOCAB by `context` and `passesGate`
 * 2. score survivors, sort desc, take top `CANDIDATE_POOL`
 * 3. result = `[ top[0] ]` (ALWAYS) + `SAMPLE_COUNT` sampled (via injected `rng`) from
 *    `SAMPLE_RANKS` (i.e. ranks 2–4)
 * 4. dedupe; if the pool is short, return what exists (never throw)
 *
 * Returns the reaction *texts* (short behavioural moves) for the directive line.
 */
export function buildReactionMenu(
    npc: NPCEntry,
    context: ReactionContext,
    rng: () => number = Math.random,
    matureMode: boolean = false,
    relationshipMemoryEnabled = false,
): string[] {
    // Legacy NPC with no hex → no engine menu (directive omits the line).
    if (!npc.personalityHex) return [];

    const pcRel = pcRelationOf(npc, relationshipMemoryEnabled);
    const eligible = REACTION_VOCAB.filter(r => r.context === context && passesGate(r, npc, pcRel, matureMode));
    if (eligible.length === 0) return [];

    const scored = eligible
        .map(r => ({ r, s: scoreReaction(r, npc, pcRel) }))
        .sort((a, b) => b.s - a.s);
    const top = scored.slice(0, CANDIDATE_POOL).map(x => x.r);

    const result: string[] = [top[0].text];

    // Sample SAMPLE_COUNT distinct entries from SAMPLE_RANKS indices of `top` (ranks 2–4).
    // Indices beyond `top.length-1` are skipped; never throws on short pools.
    const availableIdx = SAMPLE_RANKS.filter(i => i < top.length);
    const want = Math.min(SAMPLE_COUNT, availableIdx.length);
    // Fisher-Yates partial shuffle over availableIdx, then take `want`.
    const idxCopy = availableIdx.slice();
    for (let i = 0; i < want; i++) {
        const j = i + Math.floor(rng() * (idxCopy.length - i));
        [idxCopy[i], idxCopy[j]] = [idxCopy[j], idxCopy[i]];
    }
    const pickedIdx = idxCopy.slice(0, want);

    for (const i of pickedIdx) {
        const text = top[i].text;
        if (!result.includes(text)) result.push(text);
    }
    return result;
}
