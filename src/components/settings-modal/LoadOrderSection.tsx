import { useCallback, useMemo } from 'react';
import { ArrowDown, ArrowUp, RotateCcw, Trophy } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n/useTranslation';
import { refreshMods } from '../../services/mods/modBootstrap';
import type { ValidatedMod } from '../../services/mods/modTypes';
import {
    conflictsByModId,
} from '../../services/mods/loadOrder/loadOrderConflicts';
import {
    modsThatMustPrecede,
    validateProposedLoadOrder,
} from '../../services/mods/loadOrder/dependencyCheck';

/**
 * Phase 6.2 — the load-order section inside Mod Management.
 *
 * Renders the resolved load order (the order the loader returned `mods[]`
 * in), with up/down reorder controls per row. The user's override persists
 * to `settings.modLoadOrder` and beats the manifest's `loadOrder` as the
 * primary tiebreak in the topological sort (the dependency graph is still
 * a hard constraint).
 *
 * Three behaviours the spec requires:
 *
 *   1. **Visible order.** Each row shows its resolved position (`#1`,
 *      `#2`, …), so the user can see the order rather than infer it from
 *      an alphabetical list.
 *   2. **User override.** Up/down writes a new `modLoadOrder` to settings
 *      and calls `refreshMods()`, which re-fetches from the server with
 *      the override as a query param. The server re-runs the topological
 *      sort and returns the new resolved order. No restart.
 *   3. **Conflict surfacing.** A mod that lost a fact conflict shows the
 *      conflict and the winner on its row. The winner is the mod earlier
 *      in the resolved order (the one whose claim registered first).
 *
 * Dependency-violating moves are PREVENTED in the UI (spec §2.4) rather
 * than allowed and faulted later: the "move up" button is disabled when
 * the mod would land above one of its dependencies, with a reason in the
 * tooltip. This is the UI-level guard; the server's topological sort is
 * the hard constraint that makes the guard honest.
 */
interface LoadOrderSectionProps {
    /** The mods in resolved load order, as returned by the server. */
    readonly mods: readonly ValidatedMod[];
}

export function LoadOrderSection({ mods }: LoadOrderSectionProps) {
    const settings = useAppStore((s) => s.settings);
    const updateSettings = useAppStore((s) => s.updateSettings);
    const { t } = useTranslation();

    // The user's current override, as persisted in settings. `undefined`
    // or empty = manifest default (the server's resolved order).
    const userOrder: string[] = useMemo(
        () => (Array.isArray(settings?.modLoadOrder) ? [...settings.modLoadOrder!] : []),
        [settings?.modLoadOrder],
    );

    // The resolved order is what the server returned — `mods[]` is already
    // in resolved load order (loader contract). The user override may or
    // may not match it exactly (the server re-sorts under the dependency
    // constraint), so this is the source of truth for what the user sees.
    const resolvedIds = useMemo(() => mods.map((m) => m.id), [mods]);

    // The user-facing order: if the user has an override, show the mods in
    // the override order (filtered to installed mods); otherwise show the
    // resolved order. This is what the up/down buttons act on.
    const displayOrder = useMemo(() => {
        if (userOrder.length === 0) return resolvedIds;
        // Filter the user order to installed mods, then append any installed
        // mods not in the user order (newly installed) in resolved order.
        const installedSet = new Set(resolvedIds);
        const ordered = userOrder.filter((id) => installedSet.has(id));
        const seen = new Set(ordered);
        for (const id of resolvedIds) {
            if (!seen.has(id)) ordered.push(id);
        }
        return ordered;
    }, [userOrder, resolvedIds]);

    const modById = useMemo(() => new Map(mods.map((m) => [m.id, m])), [mods]);

    // Conflict summaries keyed by the losing mod's id. Read on every render
    // — the fault stores are tiny (one row per mod) and in-memory, and the
    // parent `ExtensionsTab` re-renders when any fault store changes (via
    // its `RUNTIME_FAULT_STORES` subscriptions), so this stays current
    // without a separate subscription. No `useMemo` here because the stores
    // are external mutable state React cannot track.
    const conflicts = conflictsByModId();

    // Per-mod: the set of ids that must precede it (transitive deps).
    // Precomputed once per `mods` change so the move-up disabled check is O(1).
    const mustPrecede = useMemo(() => {
        const map = new Map<string, ReadonlySet<string>>();
        for (const mod of mods) {
            map.set(mod.id, modsThatMustPrecede(mods, mod.id));
        }
        return map;
    }, [mods]);

    // Per-mod: the set of ids that must FOLLOW it (transitive dependents).
    // A "move down" that lands the mod below one of its dependents is a
    // violation too. Derived by inverting the dependency graph.
    const mustFollow = useMemo(() => {
        const map = new Map<string, Set<string>>();
        for (const mod of mods) {
            map.set(mod.id, new Set<string>());
        }
        for (const mod of mods) {
            for (const depId of Object.keys(mod.dependencies ?? {})) {
                const dependents = map.get(depId);
                if (dependents) dependents.add(mod.id);
            }
        }
        // Transitive closure: if A depends on B and B depends on C, then
        // C must follow A too. Walk the dependents graph.
        const closure = new Map<string, Set<string>>();
        for (const mod of mods) {
            const set = new Set<string>();
            const walk = (id: string) => {
                const direct = map.get(id);
                if (!direct) return;
                for (const dep of direct) {
                    if (set.has(dep)) continue;
                    set.add(dep);
                    walk(dep);
                }
            };
            walk(mod.id);
            closure.set(mod.id, set);
        }
        return closure;
    }, [mods]);

    /** Write a new user order to settings and re-fetch from the server. */
    const applyOrder = useCallback((nextOrder: string[]) => {
        updateSettings({ modLoadOrder: nextOrder });
        // `refreshMods` reads `settings.modLoadOrder` from the store and
        // passes it as `?order=` to the server. The server re-runs the
        // topological sort with the override as the primary tiebreak and
        // returns the new resolved order. Fire-and-forget — the Extensions
        // tab's `reloadToken` effect re-renders when the fetch resolves.
        refreshMods().catch((e) => console.warn('[loadOrder] refresh failed:', e));
    }, [updateSettings]);

    /** Move a mod up one position, if the dependency graph allows it. */
    const moveUp = useCallback((modId: string) => {
        const idx = displayOrder.indexOf(modId);
        if (idx <= 0) return;
        const target = idx - 1;
        // The mod at `target` would load before this mod after the swap.
        // If the mod at `target` is a dependency of this mod, moving up
        // would put this mod above its dependency — a violation.
        const blockers = mustPrecede.get(modId) ?? new Set();
        if (blockers.has(displayOrder[target])) return; // prevented
        // Also check: if the mod being moved HAS a dependent at `target`,
        // moving it up is fine (the dependent would load after, which is
        // correct). So no `mustFollow` check on move-up.
        const next = [...displayOrder];
        [next[idx], next[target]] = [next[target], next[idx]];
        // Validate the full proposed order before applying — belt-and-braces
        // for the case where a transitive dep is between the two.
        const violation = validateProposedLoadOrder(mods, next);
        if (violation) return; // prevented; the UI should have disabled this
        applyOrder(next);
    }, [displayOrder, mustPrecede, mods, applyOrder]);

    /** Move a mod down one position, if the dependency graph allows it. */
    const moveDown = useCallback((modId: string) => {
        const idx = displayOrder.indexOf(modId);
        if (idx < 0 || idx >= displayOrder.length - 1) return;
        const target = idx + 1;
        // The mod at `target` would load after this mod after the swap.
        // If the mod at `target` is a dependent of this mod, moving down
        // would put this mod below its dependent — a violation.
        const followers = mustFollow.get(modId) ?? new Set();
        if (followers.has(displayOrder[target])) return; // prevented
        const next = [...displayOrder];
        [next[idx], next[target]] = [next[target], next[idx]];
        const violation = validateProposedLoadOrder(mods, next);
        if (violation) return;
        applyOrder(next);
    }, [displayOrder, mustFollow, mods, applyOrder]);

    /** Clear the user override and revert to the manifest's `loadOrder`. */
    const resetToManifest = useCallback(() => {
        updateSettings({ modLoadOrder: [] });
        refreshMods().catch((e) => console.warn('[loadOrder] refresh failed:', e));
    }, [updateSettings]);

    // A move-up is blocked if the mod immediately above is a transitive
    // dependency. Precompute per-row so the button is disabled with a
    // reason rather than silently no-oping on click.
    const moveUpBlocker = useCallback((modId: string, idx: number): string | null => {
        if (idx <= 0) return null;
        const above = displayOrder[idx - 1];
        if ((mustPrecede.get(modId) ?? new Set()).has(above)) {
            const dep = modById.get(above);
            return t('settings.extensions.loadOrder.moveUp.blocked', { dep: dep?.name ?? above });
        }
        return null;
    }, [displayOrder, mustPrecede, modById, t]);

    const moveDownBlocker = useCallback((modId: string, idx: number): string | null => {
        if (idx < 0 || idx >= displayOrder.length - 1) return null;
        const below = displayOrder[idx + 1];
        if ((mustFollow.get(modId) ?? new Set()).has(below)) {
            const dependent = modById.get(below);
            return t('settings.extensions.loadOrder.moveDown.blocked', { dependent: dependent?.name ?? below });
        }
        return null;
    }, [displayOrder, mustFollow, modById, t]);

    if (mods.length === 0) return null;

    const hasOverride = userOrder.length > 0;

    return (
        <div className="space-y-2">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <label className="chrome-label block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
                        {t('settings.extensions.loadOrder.title')}
                    </label>
                    <p className="text-[9px] text-text-dim leading-tight max-w-[420px]">
                        {t('settings.extensions.loadOrder.help')}
                    </p>
                </div>
                {hasOverride && (
                    <button
                        type="button"
                        onClick={resetToManifest}
                        className="shrink-0 text-[10px] uppercase tracking-widest bg-terminal/10 border border-terminal/30 text-terminal px-3 py-1.5 rounded hover:bg-terminal/20 flex items-center gap-1.5"
                    >
                        <RotateCcw size={10} />
                        {t('settings.extensions.loadOrder.reset')}
                    </button>
                )}
            </div>

            <div className="space-y-1">
                {displayOrder.map((modId, idx) => {
                    const mod = modById.get(modId);
                    if (!mod) return null;
                    const modConflicts = conflicts.get(modId) ?? [];
                    const upBlock = moveUpBlocker(modId, idx);
                    const downBlock = moveDownBlocker(modId, idx);
                    return (
                        <div
                            key={modId}
                            className="flex items-center gap-2 bg-void p-2 border border-border rounded"
                        >
                            <span className="text-[9px] font-mono text-text-dim shrink-0 w-8 text-center">
                                {t('settings.extensions.loadOrder.position', { n: idx + 1 })}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                    <span className="chrome-label text-[11px] text-text-primary uppercase tracking-wider font-bold truncate">
                                        {mod.name}
                                    </span>
                                    {modConflicts.map((c) => (
                                        <span
                                            key={`${c.kind}-${c.name}`}
                                            className="text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold bg-ember/15 text-ember border border-ember/40 flex items-center gap-1"
                                            title={c.reason}
                                        >
                                            <Trophy size={8} />
                                            {t(
                                                c.kind === 'role'
                                                    ? 'settings.extensions.loadOrder.conflict.role'
                                                    : 'settings.extensions.loadOrder.conflict.fact',
                                                { winner: c.winner, role: c.name },
                                            )}
                                        </span>
                                    ))}
                                </div>
                                {modConflicts.length > 0 && (
                                    <p className="text-[9px] text-ember/80 leading-tight mt-0.5">
                                        {t('settings.extensions.loadOrder.winner')}: {modConflicts[0].winner}
                                    </p>
                                )}
                            </div>
                            <div className="shrink-0 flex items-center gap-1">
                                <button
                                    type="button"
                                    onClick={() => moveUp(modId)}
                                    disabled={idx === 0 || upBlock !== null}
                                    title={upBlock ?? t('settings.extensions.loadOrder.moveUp')}
                                    aria-label={t('settings.extensions.loadOrder.moveUp')}
                                    className="text-text-dim hover:text-terminal disabled:opacity-30 disabled:cursor-not-allowed p-1"
                                >
                                    <ArrowUp size={12} />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => moveDown(modId)}
                                    disabled={idx >= displayOrder.length - 1 || downBlock !== null}
                                    title={downBlock ?? t('settings.extensions.loadOrder.moveDown')}
                                    aria-label={t('settings.extensions.loadOrder.moveDown')}
                                    className="text-text-dim hover:text-terminal disabled:opacity-30 disabled:cursor-not-allowed p-1"
                                >
                                    <ArrowDown size={12} />
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
