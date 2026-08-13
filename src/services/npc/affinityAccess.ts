import type { NPCEntry } from '../../types';
import { affinityToPcRelation } from './agency/agencyBands';
import { resolveRelationTarget } from './relationResolve';

/**
 * WO-4 §2 — the one affinity accessor every reader goes through.
 *
 * Today at least six places read relationship state directly. Route them all
 * through here so the later v3 switch is one change instead of six. **Do not
 * add a v3 branch here** — WO-5 adds it, in one place, because this order
 * exists.
 *
 * Semantics are preserved exactly, including the `?? 0` and `?? 50` fallbacks
 * — a "tidy-up" that changes a default is a behaviour change wearing a
 * refactor's clothes.
 *
 * Two reads:
 *   - `readPcAffinity(npc)` — the NPC→PC edge as a structured value. This is
 *     the seam for WO-5: the v3 branch will live here, and every PC-edge
 *     reader sees it. Callers that need a -3..+3 number use `pcRelationOf`;
 *     callers that need to pick a label by source (band word vs legacy
 *     descriptor) read the structured form.
 *   - `relationToward(source, target)` — the directed NPC↔NPC edge (or NPC→PC
 *     when `target.isPC`). Routes through the canonical relation-key resolver
 *     (`relationResolve.ts`), fixing the live bug where the collision path
 *     read `undefined → 0` for every name-keyed edge. NPC↔NPC stays on the
 *     stored scalar in v1 (DESIGN-STAGING §2.8), so WO-5 does NOT branch here.
 */

/**
 * The stored PC-edge relationship, before any derivation. The `kind` tells
 * callers which rendering/fallback to use, preserving today's per-caller
 * branching exactly:
 *   - `pcRelation`   → `relationBand(value)` (the re-homed -3..+3 slot)
 *   - `legacyAffinity` → the legacy 0..100 affinity (callers apply their own
 *     descriptor or `affinityToPcRelation`)
 *   - `none`          → both undefined; callers apply their own default
 *     (the pre-refactor code used `affinity ?? 50` and `affinityDescriptor(undefined)`)
 */
export type PcAffinityRead =
    | { kind: 'pcRelation'; value: number }
    | { kind: 'legacyAffinity'; value: number }
    | { kind: 'none' }
    | { kind: 'stance' };

/**
 * WO-5: this is the only relationship-feature branch. Readers keep their old
 * values when the feature is off; when it is on the stance is the source of
 * truth and scalar relationship reads become intentionally empty/neutral.
 */
function readRelationshipValue<T>(
    featureEnabled: boolean | undefined,
    legacy: () => T,
    enabled: () => T,
): T {
    if (featureEnabled) return enabled();
    return legacy();
}

/**
 * Read the stored PC-edge relationship. The single seam for the v3 switch
 * (WO-5): when v3 is on, this returns the v3-derived stance instead, and every
 * PC-edge reader sees it through one change. In this order it returns today's
 * stored values and nothing else.
 */
export function readPcAffinity(npc: NPCEntry, featureEnabled = false): PcAffinityRead {
    return readRelationshipValue<PcAffinityRead>(
        featureEnabled,
        () => {
            if (npc.pcRelation !== undefined) return { kind: 'pcRelation', value: npc.pcRelation };
            if (npc.affinity !== undefined) return { kind: 'legacyAffinity', value: npc.affinity };
            return { kind: 'none' };
        },
        () => ({ kind: 'stance' }),
    );
}

/**
 * The NPC's relationship toward the PC as a -3..+3 band. Prefers the dedicated
 * `pcRelation` slot; falls back to deriving it from legacy `affinity` so
 * un-homed NPCs (bug B2) still read a sensible relationship instead of
 * defaulting everyone to a stranger. The `?? 50` and the
 * `affinityToPcRelation` fallback are both preserved verbatim.
 *
 * Moved here from `reactionMenu.ts` so every affinity reader goes through one
 * function. The `pcRelationOf` name is re-exported from `reactionMenu.ts` for
 * back-compat with existing import sites.
 */
export function pcRelationOf(npc: NPCEntry, featureEnabled = false): number {
    const read = readPcAffinity(npc, featureEnabled);
    if (read.kind === 'stance') return 0;
    if (read.kind === 'pcRelation') return read.value;
    // legacyAffinity → derive; none → default to 50 (the pre-refactor `?? 50`).
    const affinity = read.kind === 'legacyAffinity' ? read.value : 50;
    return affinityToPcRelation(affinity);
}

/**
 * The directed relation value from `source` to `target` (NPC↔NPC, or NPC↔PC
 * when `target.isPC`). Routes through the canonical relation-key resolver so
 * name-keyed edges (the overwhelming majority) read non-zero in the collision
 * path. Falls back to `0` — the pre-refactor default every reader used.
 *
 * When `target.isPC` and `source.pcRelation` is set, the dedicated PC slot
 * wins (mirrors the pre-refactor behaviour in `agencyCollision.relationTone`).
 */
export function relationToward(source: NPCEntry, target: NPCEntry, featureEnabled = false): number {
    return readRelationshipValue(
        featureEnabled,
        () => {
            if (target.isPC && source.pcRelation !== undefined) return source.pcRelation;
            return resolveRelationTarget(source, target) ?? 0;
        },
        () => 0,
    );
}
