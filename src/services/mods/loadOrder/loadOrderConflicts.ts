/**
 * Phase 6.2 — conflict surfacing for the load-order UI.
 *
 * The spec (`Phase 6.2 - Load order UI - Medium-low.md` §2.3): "Where two
 * mods contend — same region, same suppression, same fact — say so on the
 * row, and say **who wins**. A conflict the user cannot see is a bug report
 * you will receive instead."
 *
 * The registries already detect conflicts at registration time and record
 * faults. This module aggregates those faults into a per-mod summary the
 * load-order row can render, with the winner named. It does NOT re-detect
 * conflicts — it reads the stores the registries already populate. That is
 * the stop-condition discipline: "if surfacing conflicts requires each
 * subsystem to report its own contention, that is real work — do it, but
 * note which subsystems had to be taught."
 *
 * Three subsystems report contention today:
 *
 *   1. **Facts (`factFaultStore`, kind `'conflict'`)** — two mods claim the
 *      same core fact. The earlier in resolved load order wins; the later
 *      one is faulted. The fault `reason` is formatted with the winner's
 *      mod name by `formatFactFaultReason`.
 *   2. **Mounts (`mountFaultStore`, kind `'duplicate'`)** — the same mod
 *      registered the same entry id twice in one region. This is a
 *      per-mod programming bug, NOT a cross-mod conflict, and is not
 *      surfaced here as a conflict (it is already surfaced as a fault).
 *   3. **Mounts (cross-mod region contention)** — `MOUNTS.md` §4 rules
 *      that chrome regions are additive (no conflict) and `chat.rail` is
 *      tabs (no conflict — both render). So there is no cross-mod mount
 *      conflict to surface in v1; the budget cap is a per-mod fault, not
 *      a cross-mod conflict.
 *
 * Suppression conflicts (two mods suppress the same id) are resolved by
 * the arbiter with "first suppressor wins" (`assemble.ts:88-101`). The
 * arbiter does not record a fault for this — suppression is a declared
 * relationship, and two mods suppressing the same id is legal (both are
 * honoured; the attribution goes to the first). So there is no suppression
 * conflict to surface in v1: the behaviour is correct, and the user does
 * not need to arbitrate.
 *
 * The one cross-mod conflict that exists today is the fact claim, so this
 * module surfaces it. If future phases add cross-mod contention to other
 * subsystems, they record faults in their stores and this module is the
 * one place to teach.
 */
import { factFaultStore } from '../facts/factFaults';
import type { FactFaultRecord } from '../facts/factFaults';
import { roleFaultStore } from '../../roles/roleFaults';
import type { RoleFaultRecord } from '../../roles/roleFaults';

/**
 * A per-mod conflict summary for the load-order row.
 *
 * `winner` is the mod name (not id) of the mod that won the contention, as
 * the user sees it in the Extensions list. `kind` is the subsystem that
 * reported the conflict, so the row can say "fact conflict" vs "region
 * conflict" when more than one kind exists.
 */
export interface ModConflictSummary {
    /** The mod id that LOST the conflict (the one whose row this is). */
    readonly modId: string;
    /** The kind of conflict, named by the subsystem that reported it. */
    readonly kind: 'fact' | 'role';
    /** The fact/region/suppression id the mods contended over. */
    readonly name: string;
    /** The mod name (display) that won the conflict. */
    readonly winner: string;
    /** The fault reason, verbatim from the store, for the tooltip. */
    readonly reason: string;
}

/**
 * Collect every cross-mod conflict from the fault stores, keyed by the
 * LOSING mod's id. A mod that lost more than one conflict gets one entry
 * per conflict (the row renders each).
 *
 * Reads the stores the registries already populate; does NOT re-detect.
 * Called by the load-order UI on every render — the stores are tiny (one
 * row per mod) and in-memory, so the cost is negligible.
 */
export function collectLoadOrderConflicts(): readonly ModConflictSummary[] {
    const summaries: ModConflictSummary[] = [];
    // Facts — the one cross-mod conflict in v1.
    for (const record of factFaultStore.getRecords()) {
        if (record.kind !== 'conflict') continue;
        if (!record.name) continue;
        // The fault record carries the loser's mod id; the winner's mod
        // name is in the `reason` string (formatted by
        // `formatFactFaultReason`). Extract it rather than re-deriving
        // from the registry — the registry's claim map is the authority
        // for who currently owns the claim, but the fault is the record
        // of who contended and lost.
        const winner = extractWinnerFromReason(record.reason);
        summaries.push({
            modId: record.modId,
            kind: 'fact',
            name: record.name,
            winner: winner ?? 'another mod',
            reason: record.reason,
        });
    }
    for (const record of roleFaultStore.getRecords()) {
        if (record.kind !== 'conflict' || !record.roleId) continue;
        summaries.push({
            modId: record.modId,
            kind: 'role',
            name: record.roleId,
            winner: record.winner ?? extractWinnerFromReason(record.reason) ?? 'another provider',
            reason: record.reason,
        });
    }
    return summaries;
}

/**
 * The fact fault reason is formatted as:
 *   `<modName>: fact publisher "<name>" lost a conflict with <winner> (resolved by loading_order)`
 * The winner's name is between "with " and " (resolved". Extract it so
 * the row can say "loses to <winner>" without re-parsing the registry.
 */
function extractWinnerFromReason(reason: string): string | undefined {
    const match = /lost a conflict with (.+?) \(resolved by loading_order\)/.exec(reason);
    return match?.[1];
}

/**
 * Group conflicts by the losing mod id, so the row can look up its
 * conflicts in O(1). A mod with no conflict gets no entry.
 */
export function conflictsByModId(): ReadonlyMap<string, readonly ModConflictSummary[]> {
    const all = collectLoadOrderConflicts();
    const byMod = new Map<string, ModConflictSummary[]>();
    for (const summary of all) {
        const list = byMod.get(summary.modId);
        if (list) list.push(summary);
        else byMod.set(summary.modId, [summary]);
    }
    return byMod;
}

/**
 * Re-export the fault record type for tests that want to assert on the
 * store directly.
 */
export type { FactFaultRecord };
export type { RoleFaultRecord };
