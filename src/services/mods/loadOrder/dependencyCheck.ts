/**
 * Phase 6.2 — dependency-violation prevention for the load-order UI.
 *
 * The spec (`Phase 6.2 - Load order UI - Medium-low.md` §2.4): "A mod cannot
 * be ordered before something it depends on (1.3). Prevent it in the UI
 * rather than allowing it and faulting later."
 *
 * The loader's topological sort (`modLoader.js:resolveDependenciesAndSort`)
 * is the hard constraint: a dependency always precedes its dependent,
 * regardless of the user override. So a user-chosen order that violates
 * dependencies is not a load failure — the server re-sort fixes it — but
 * it IS a user-visible lie: the user dragged a mod above its dependency,
 * the row shows the new position, and the actual load order does not match.
 *
 * The right answer is to prevent the drag in the UI and show a reason,
 * so the user never sees a row that disagrees with reality. This module
 * provides the check the UI calls before accepting a reorder.
 *
 * The check is PURE — it reads the mod list and the proposed order, and
 * returns the first violation it finds, or `null` if the order is legal.
 * It does not mutate state or call the server.
 */
import type { ValidatedMod } from '../modTypes';

/**
 * A dependency-violation reason. The UI shows `message` on the row that
 * was blocked; `blockedBy` is the mod id the user tried to order around.
 */
export interface DependencyViolation {
    /** The mod id whose proposed position violates a dependency. */
    readonly modId: string;
    /** The mod id that must load before `modId` but would load after it. */
    readonly blockedBy: string;
    /** A human-readable reason for the row. */
    readonly message: string;
}

/**
 * Validate a proposed load order against the dependency graph.
 *
 * The proposed order is an array of mod ids in the user's chosen order.
 * For each mod, every id in its `dependencies` must appear EARLIER in the
 * array. The first violation found is returned; `null` means the order is
 * legal. Mods in the proposed list that are not in `mods` are ignored
 * (they may have been uninstalled since the user last reordered).
 *
 * Mods in `mods` that are not in the proposed list are fine — they fall
 * back to `loadOrder` then `id` among themselves, and the dependency
 * graph still constrains them. This check only validates the user's
 * explicit reorder.
 */
export function validateProposedLoadOrder(
    mods: readonly ValidatedMod[],
    proposedOrder: readonly string[],
): DependencyViolation | null {
    const byId = new Map(mods.map((m) => [m.id, m]));
    const position = new Map<string, number>();
    for (let i = 0; i < proposedOrder.length; i++) {
        position.set(proposedOrder[i], i);
    }

    for (const modId of proposedOrder) {
        const mod = byId.get(modId);
        if (!mod) continue; // uninstalled since the user last reordered
        const deps = mod.dependencies ?? {};
        const myPos = position.get(modId) ?? 0;
        for (const depId of Object.keys(deps)) {
            const dep = byId.get(depId);
            if (!dep) continue; // missing dep is a load fault, not a reorder issue
            const depPos = position.get(depId);
            // If the dependency is in the proposed list, it must be earlier.
            if (depPos !== undefined && depPos > myPos) {
                return {
                    modId,
                    blockedBy: depId,
                    message: `"${mod.name}" depends on "${dep.name}", which must load first`,
                };
            }
        }
    }
    return null;
}

/**
 * Compute the set of mod ids that a given mod cannot be moved above.
 *
 * This is the set of its dependencies AND their transitive dependencies,
 * since moving a mod above a transitive dependency would also violate the
 * graph. The UI uses this to disable the "move up" button when the target
 * position would land the mod above one of these.
 */
export function modsThatMustPrecede(mods: readonly ValidatedMod[], modId: string): ReadonlySet<string> {
    const byId = new Map(mods.map((m) => [m.id, m]));
    const result = new Set<string>();
    const visited = new Set<string>();
    const walk = (id: string): void => {
        if (visited.has(id)) return;
        visited.add(id);
        const mod = byId.get(id);
        if (!mod) return;
        for (const depId of Object.keys(mod.dependencies ?? {})) {
            if (!byId.has(depId)) continue;
            result.add(depId);
            walk(depId);
        }
    };
    walk(modId);
    return result;
}