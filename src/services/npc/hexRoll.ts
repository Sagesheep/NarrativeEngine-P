import type { HexAxis, PersonalityHex } from '../../types';
import { TRAIT_VOCAB, type TraitEntry } from './agency/agencyPools';
import {
    ENVELOPES,
    MODIFIERS,
    GROUP_KEYS,
    type AxisEnvelope,
    type AxisSpread,
    type GroupEnvelope,
    type GroupModifiers,
} from './dispositionGroups';

// NPC Generation Refit (Phase 1) — the roll engine. No LLM. Deterministic given an injected
// rng. The model proposes groups + anchor traits; THIS module rolls the actual hexagon inside
// the proposed group's envelope, applies anchor-trait axis-mods, clamps at hard ±3, then draws
// 1–2 extra traits consistent with the rolled hex. See 00_SPEC.md §4 (pipeline) and §8 (primitives).
//
// GOLDEN RULE — weighted, never walled (00_SPEC §3.3): rollWeightedAxis keeps the FULL -3..+3
// reachable at every spread. Skew comes from a weighted distribution centered on the envelope's
// `center`, NOT from clipping bounds. The rare -3 "lazy fraud scholar" must stay possible.

const HEX_AXES: readonly HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];
const HARD_MIN = -3;
const HARD_MAX = 3;
const ALL_VALUES: readonly number[] = [-3, -2, -1, 0, 1, 2, 3];

// spread → σ for the Gaussian falloff. Tighter spread → narrower distribution (most mass near
// center). Even at `tight`, the floor in rollWeightedAxis keeps the extremes reachable.
const SPREAD_SIGMA: Record<AxisSpread, number> = {
    tight: 0.7,
    normal: 1.4,
    wide: 2.4,
};

// Minimum relative weight for any bucket (guarantees extremes stay reachable at every spread,
// even when the Gaussian would otherwise underflow them to ~0). 0.5% of the peak — rare but
// never impossible. This is the load-bearing line for the "weight, never wall" rule.
const MIN_WEIGHT_FLOOR = 0.005;

/**
 * Roll one personality axis inside an envelope, weighted toward `center` by a Gaussian falloff
 * whose width is set by `spread`. The full -3..+3 range stays reachable at every spread: every
 * bucket gets at least `MIN_WEIGHT_FLOOR` relative weight, so the rare extreme is always
 * possible (weighted, never walled). Result is an integer clamped to [-3,+3]. Pure: pass `rng`
 * to make it deterministic.
 */
export function rollWeightedAxis(env: AxisEnvelope, rng: () => number): number {
    const center = Math.max(HARD_MIN, Math.min(HARD_MAX, env.center));
    const sigma = SPREAD_SIGMA[env.spread] ?? SPREAD_SIGMA.normal;
    const twoSigmaSq = 2 * sigma * sigma;

    // Weight each integer bucket by its Gaussian distance from center, plus a floor so extremes
    // stay reachable. Peak (at the closest bucket to center) is the normalizer.
    const weights = ALL_VALUES.map(v => {
        const gauss = Math.exp(-((v - center) * (v - center)) / twoSigmaSq);
        return Math.max(gauss, MIN_WEIGHT_FLOOR);
    });
    const total = weights.reduce((a, b) => a + b, 0);

    let r = rng() * total;
    for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r <= 0) return ALL_VALUES[i];
    }
    // Floating-point tail fallback (shouldn't happen, but keep the roll honest).
    return ALL_VALUES[ALL_VALUES.length - 1];
}

/**
 * 00_SPEC §8 MODIFIERS table is SUPERSEDED — the secondary-group effect is DERIVED from the two
 * groups' own envelopes: pull the primary envelope's center ~40% toward the secondary group's
 * own envelope center per axis, and widen the spread one step where the two centers diverge.
 * This keeps the secondary as a trajectory bend (not a separately authored table) and reuses the
 * same authored envelope data. If `secondary` is unknown/absent, the primary envelope is used as-is.
 */
export function applySecondaryEnvelope(primary: GroupEnvelope, secondaryKey?: string): GroupEnvelope {
    if (!secondaryKey || !ENVELOPES[secondaryKey]) return primary;
    const secondary = ENVELOPES[secondaryKey];
    const out = {} as GroupEnvelope;
    const order: AxisSpread[] = ['tight', 'normal', 'wide'];
    for (const axis of HEX_AXES) {
        const p = primary[axis];
        const s = secondary[axis];
        // Pull primary center ~40% of the way toward the secondary center.
        const centerDelta = (s.center - p.center) * 0.4;
        const newCenter = Math.round(p.center + centerDelta);
        // Widen spread one step where the two centers diverge (|delta| >= 1 after rounding).
        const diverged = Math.abs(Math.round(s.center) - Math.round(p.center)) >= 1;
        const newSpread: AxisSpread = diverged
            ? order[Math.min(order.length - 1, order.indexOf(p.spread) + 1)]
            : p.spread;
        out[axis] = { center: Math.max(HARD_MIN, Math.min(HARD_MAX, newCenter)), spread: newSpread };
    }
    return out;
}

/** Collect the axisMods from a list of trait names (unknown traits contribute nothing). */
function traitModsFor(traitNames: string[]): Partial<Record<HexAxis, number>> {
    const byName = new Map<string, TraitEntry>();
    for (const t of TRAIT_VOCAB) byName.set(t.text, t);
    const mods: Partial<Record<HexAxis, number>> = {};
    for (const name of traitNames) {
        const entry = byName.get(name);
        if (!entry || !entry.axisMods) continue;
        for (const axis of HEX_AXES) {
            const m = entry.axisMods[axis];
            if (typeof m === 'number') mods[axis] = (mods[axis] ?? 0) + m;
        }
    }
    return mods;
}

/**
 * Roll a full personality hexagon for an NPC.
 *
 * 1. envelope = ENVELOPES[primary], shifted/widened by the derived secondary effect (see
 *    applySecondaryEnvelope). If `primary` is unknown, falls back to a neutral all-zero/normal
 *    envelope so generation never crashes on a bad proposal.
 * 2. for each axis: value = rollWeightedAxis(envelope[axis], rng)
 * 3. apply anchorTrait axis-mods (the model's 2 picks bias the roll AFTER the base roll — this
 *    is the §3.4 escape hatch that lets a trait defy the role), then clamp each axis to [-3,+3].
 *
 * Pure: pass `rng` to make it deterministic.
 */
export function rollHex(
    primary: string,
    secondary: string | undefined,
    anchorTraits: string[],
    rng: () => number,
): PersonalityHex {
    const baseEnvelope: GroupEnvelope = ENVELOPES[primary] ?? neutralEnvelope();
    const envelope = applySecondaryEnvelope(baseEnvelope, secondary);

    const hex = {} as PersonalityHex;
    for (const axis of HEX_AXES) {
        hex[axis] = rollWeightedAxis(envelope[axis], rng);
    }

    const mods = traitModsFor(anchorTraits);
    for (const axis of HEX_AXES) {
        const m = mods[axis];
        if (typeof m === 'number' && m !== 0) {
            hex[axis] = Math.max(HARD_MIN, Math.min(HARD_MAX, hex[axis] + m));
        }
    }
    return hex;
}

function neutralEnvelope(): GroupEnvelope {
    const env = {} as GroupEnvelope;
    for (const axis of HEX_AXES) env[axis] = { center: 0, spread: 'normal' as AxisSpread };
    return env;
}

/**
 * Pick a primary and secondary group from the candidate pool. Weighted pick (not uniform —
 * earlier candidates get slightly higher weight via the rng draw, mirroring the model's
 * scene-appropriateness ordering). primary !== secondary; both must exist in ENVELOPES.
 * Falls back to GROUP_KEYS if the candidate list is empty/garbage. If only one valid candidate
 * exists, secondary is undefined (the derived effect becomes a no-op).
 */
export function pickGroups(candidates: string[], rng: () => number): { primary: string; secondary: string | undefined } {
    const valid = (candidates.length > 0 ? candidates : Array.from(GROUP_KEYS))
        .filter(k => ENVELOPES[k] !== undefined);
    const deduped = Array.from(new Set(valid));
    if (deduped.length === 0) {
        // Last-resort fallback: pick from GROUP_KEYS directly (guaranteed non-empty by WO-2 stubs).
        const keys = Array.from(GROUP_KEYS);
        const primary = keys[Math.floor(rng() * keys.length)];
        return { primary, secondary: undefined };
    }
    const primary = deduped[Math.floor(rng() * deduped.length)];
    let secondary: string | undefined;
    if (deduped.length > 1) {
        const secondaries = deduped.filter(k => k !== primary);
        secondary = secondaries[Math.floor(rng() * secondaries.length)];
    }
    return { primary, secondary };
}

/**
 * Draw 1–2 extra vocab traits whose axisMods AGREE in sign with the rolled hex on their axes
 * (a 'brave' trait whose boldness +1 only qualifies if boldness rolled >= 0; the §3.4 gap
 * "brave at heart, currently cowed" is the ANCHOR trait's job, not the engine-drawn extras).
 * Skips mature-tier traits unless `matureMode`. Never duplicates `existing`. Caps total at 5
 * (existing + drawn). Pure: pass `rng` to make it deterministic.
 */
export function drawConsistentTraits(
    hex: PersonalityHex,
    existing: string[],
    rng: () => number,
    matureMode: boolean,
): string[] {
    const existingSet = new Set(existing);
    const drawn: string[] = [];
    const cap = 5;
    const remaining = cap - existingSet.size;
    if (remaining <= 0) return drawn;

    const eligible = TRAIT_VOCAB.filter(t => {
        if (existingSet.has(t.text)) return false;
        if (!matureMode && t.tier === 'mature') return false;
        if (!t.axisMods) return true; // no mods → neutral, always consistent
        // Agree in sign: for each axis the trait touches, the trait mod and rolled hex must not
        // disagree (a +1 on boldness is consistent with boldness >= 0; a -1 with boldness <= 0).
        for (const axis of HEX_AXES) {
            const mod = t.axisMods[axis];
            if (typeof mod !== 'number') continue;
            const val = hex[axis];
            if (mod > 0 && val < 0) return false;
            if (mod < 0 && val > 0) return false;
        }
        return true;
    });

    // Draw 1–2 via Fisher-Yates partial shuffle.
    const target = Math.min(2, remaining, eligible.length);
    const items = eligible.slice();
    for (let i = 0; i < target; i++) {
        const j = i + Math.floor(rng() * (items.length - i));
        [items[i], items[j]] = [items[j], items[i]];
        drawn.push(items[i].text);
    }
    return drawn;
}

/**
 * Roll a looks tier (attractive/plain/ugly), weighted ~25/50/25. Pure: pass `rng` to make it
 * deterministic.
 */
export function rollLooksTier(rng: () => number): 'attractive' | 'plain' | 'ugly' {
    const r = rng();
    if (r < 0.25) return 'attractive';
    if (r < 0.75) return 'plain';
    return 'ugly';
}

// Re-export the (empty, superseded) MODIFIERS table for any legacy caller that imports it from
// here. The derived effect in applySecondaryEnvelope is the source of truth.
export { MODIFIERS, type GroupModifiers };