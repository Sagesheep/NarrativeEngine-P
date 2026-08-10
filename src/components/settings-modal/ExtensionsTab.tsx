import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, BookOpen, Loader2, Puzzle, RefreshCw, RotateCcw, Settings, Trash2, Workflow } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// The author's guide, inlined at build time rather than fetched.
//
// `docs/MODDING.md` is the single source of truth for the mod format — the same file a modder
// reads in the repo is the one rendered here, so the two can never drift. Bundling it (over a
// `/api/mods/guide` route) keeps documentation off the network: this screen already has a
// "could not reach the server" failure path for listing mods, and the guide explaining how to
// fix a broken mod is the last thing that should vanish when the server is unhappy.
import modGuideMarkdown from '../../../docs/MODDING.md?raw';
import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n/useTranslation';
import { createFinalUserRegistry } from '../../services/payload/contributions/builtins';
import type { FinalUserModuleInput } from '../../services/payload/contributions/builtins';
import type { ContributionModule } from '../../services/payload/contributions/registry';
import { refreshMods, enableNativeMod, disableNativeMod, cleanModData } from '../../services/mods/modBootstrap';
import { modToContributionModule } from '../../services/mods/modAdapter';
import type { ModFault, ValidatedMod } from '../../services/mods/modTypes';
import { getNativeTrustStore, needsNativeTrustWarning, recordNativeTrustAcceptance } from '../../services/mods/nativeTrustStore';
import { sandboxFaultStore } from '../../services/mods/sandbox/sandboxFaults';
import { screenFaultStore } from '../../services/mods/screenFaults';
import { lifecycleFaultStore } from '../../services/mods/lifecycle/lifecycleFaults';
import { reactiveFaultStore } from '../../services/mods/reactiveFaults';
import { eventFaultStore } from '../../services/mods/events';
import { macroFaultStore } from '../../services/mods/macros/macroFaults';
import { interceptorFaultStore } from '../../services/mods/interceptors';
import { roleFaultStore, serviceRoles, setRoleModuleEnabled } from '../../services/roles';
import { ModPanels } from './ModPanels';
import { ModScreens } from './ModScreens';
import { NativeTrustDialog } from './NativeTrustDialog';
import { ModDataDialog } from './ModDataDialog';
import { LoadOrderSection } from './LoadOrderSection';

/**
 * Project 2 / WO-P2-05 — the Extensions screen (Phase 6.1: Mod Management).
 *
 * Lists every prompt-contribution module the user may switch off, built-in and installed,
 * and writes the result to `settings.moduleEnabled`. That map is already the enablement
 * predicate `buildPayload` passes to `registry.collect`, so a toggle here takes effect on the
 * next turn with no other wiring — this screen owns the WRITE side and nothing else.
 *
 * Three rules this file must keep:
 *
 *  1. ABSENT MEANS ENABLED. `payloadBuilder` reads `moduleEnabled?.[id] !== false`, so the
 *     checkbox must too. Reading `?? defaultEnabled` instead would draw a checkbox that
 *     disagrees with the prompt for any module that ever defaults to off.
 *  2. STRUCTURAL MODULES ARE NOT OPTIONS. `toggleable === false` marks the player's own
 *     message, the world-state block, the confirmed ask-GM handoff, and the player's absolute
 *     command. They are the prompt, not features, and `collect` ignores the predicate for
 *     them — rendering them (even disabled) would advertise a switch that does nothing.
 *  3. FAULTS ARE VISIBLE. A rejected mod file is shown with its reason (acceptance criterion
 *     5). A broken mod that silently disappears is indistinguishable from one that never
 *     installed, which is the failure mode the fail-safe design exists to avoid. Phase 6.1
 *     surfaces the reason INLINE, next to the mod it rejected, not in a separate section a
 *     user must know to scroll to.
 */

/**
 * Where the guide lives on disk, shown above the rendered copy.
 *
 * Declared here rather than inside the translated sentence so it stays one literal that tracks the
 * `?raw` import above — the rendered guide and the path we tell the user to open are the same file.
 */
const GUIDE_PATH = 'docs/MODDING.md';

/** Row model — the only shape the list renderer knows about. */
type ModuleRow = {
    id: string;
    name: string;
    description: string;
    defaultEnabled: boolean;
    /** Mods only: `v1.2.0 · file.mod.json`, shown under the description. */
    meta?: string;
    /** Mods only — the source folder name, shown as `Folder: <folder>`. */
    folder?: string;
    /** Mods only — the author string, shown as `by <author>` when present. */
    author?: string;
    /** Mods only — the trust tier, shown as a small badge. Built-ins have no tier. */
    tier?: 'declarative' | 'sandboxed' | 'native';
    /**
     * Phase 6.3 — where the mod came from. `'bundled'` ships with the app; `'installed'`
     * the user dropped in. Shown as a small badge next to the tier so a user knows what
     * came with the app and that deleting a bundled mod is a different act from deleting
     * their own. Absent for built-ins (they are not mods).
     */
    provenance?: 'bundled' | 'installed';
    /** Mods only — true when this mod declares at least one panel (its own settings). */
    hasSettings?: boolean;
    /** Mods only — the inline fault for this mod, if any load/runtime fault matches its file. */
    fault?: ModFault;
    /** Mods only — roles this mod declares and whether its claimant is active. */
    roleReplacements?: readonly {
        name: string;
        active: boolean;
        overriddenBy?: string;
    }[];
};

/**
 * Every runtime fault store, read as one list.
 *
 * Was seven copies of the same spread, one per `subscribe` effect, and each
 * new store meant editing all of them — which is how `macroFaultStore` (Phase
 * 5.1) came to exist without ever reaching this screen. One function, one
 * place to add the eighth.
 */
const collectRuntimeFaults = (): ModFault[] => [
    ...sandboxFaultStore.getFaults(),
    ...screenFaultStore.getFaults(),
    ...lifecycleFaultStore.getFaults(),
    ...reactiveFaultStore.getFaults(),
    ...eventFaultStore.getFaults(),
    // Phase 5.1 — the macro registry's faults (a resolver that threw, a mod
    // shadowing a built-in slot). Wired here by Phase 5.2; 5.1 built the store
    // but never connected it, so a macro fault was invisible to the user.
    ...macroFaultStore.getFaults(),
    // Phase 5.2 — the prompt interceptor's faults: a throw, a deadline
    // overrun, a malformed return, and the refusal to suppress a structural
    // block. "Rejected with a reason" means the reason is on this screen.
    ...interceptorFaultStore.getFaults(),
    ...roleFaultStore.getFaults(),
];

/** The stores whose changes should refresh the list above. */
const RUNTIME_FAULT_STORES = [
    sandboxFaultStore,
    screenFaultStore,
    lifecycleFaultStore,
    reactiveFaultStore,
    eventFaultStore,
    macroFaultStore,
    interceptorFaultStore,
    roleFaultStore,
] as const;

/**
 * Phase 6.1 — determine a mod's trust tier for the badge.
 *
 * `TRUST.md` §B: "a manifest that includes any native entry point is a
 * native-tier mod for trust and warning purposes." So `native` wins over
 * `compute` wins over declarative-only. The tier badge is informational; the
 * trust dialog gates on `mod.native` directly (not on this label), so a mis-
 * classification here would be a cosmetic bug, not a security one.
 */
const tierOf = (mod: ValidatedMod): 'declarative' | 'sandboxed' | 'native' => {
    if (mod.native) return 'native';
    if (mod.compute) return 'sandboxed';
    return 'declarative';
};

const toRow = (module: ContributionModule<FinalUserModuleInput>, meta?: string): ModuleRow => ({
    id: module.id,
    name: module.name,
    description: module.description,
    defaultEnabled: module.defaultEnabled,
    meta,
});

/**
 * Phase 6.1 — build a mod row carrying the new metadata fields. The mod's
 * `file` is `<folder>/manifest.json`; the folder is what the user dropped and
 * what they need to see to find it on disk. The fault is matched against the
 * mod's `file` so a load-time or runtime fault for this exact mod appears
 * inline rather than only in the bottom "Rejected files" section.
 */
const toModRow = (mod: ValidatedMod, faults: readonly ModFault[]): ModuleRow => {
    const fault = faults.find((f) => f.file === mod.file || f.file === 'mod:' + mod.id);
    const roleReplacements = (mod.roles ?? []).flatMap((roleId) => {
        const role = serviceRoles.list().find((candidate) => candidate.id === roleId);
        if (!role) return [];
        const active = serviceRoles.activeProviderFor(roleId);
        const providerId = 'mod.' + mod.id;
        if (active?.providerId === providerId) {
            return [{ name: role.name, active: true }];
        }
        if (active?.source === 'mod') {
            return [{ name: role.name, active: false, overriddenBy: active.modId ?? active.providerId }];
        }
        // Phase 7.5 §3 item 4 — distinguish "core's default is running" from
        // "nothing is running". This branch used to report `core default`
        // unconditionally, so a user who had switched the default off AND whose
        // mod had not claimed the role was told a provider was answering that
        // was not. The absence is deliberate and harmless in the turn; saying
        // the wrong thing about it on the screen is not.
        if (!active) {
            return [{ name: role.name, active: false }];
        }
        return [{ name: role.name, active: false, overriddenBy: 'core default' }];
    });
    return {
        ...toRow(modToContributionModule(mod), `v${mod.version} · ${mod.file}`),
        folder: mod.folder,
        author: mod.author,
        tier: tierOf(mod),
        // Phase 6.3 — tag the row so the renderer can show a "Bundled" badge
        // and the user can tell what came with the app from what they added.
        // A server that has not been updated to stamp `provenance` defaults to
        // `'installed'` (the safe case — shows the delete affordance, which a
        // bundled mod should not have, but an old server's mods are the user's
        // own regardless).
        provenance: mod.provenance === 'bundled' ? 'bundled' : 'installed',
        hasSettings: Array.isArray(mod.panels) && mod.panels.length > 0,
        roleReplacements,
        fault,
    };
};

export function ExtensionsTab() {
    const settings = useAppStore((s) => s.settings);
    const updateSettings = useAppStore((s) => s.updateSettings);
    const toggleBlockView = useAppStore((s) => s.toggleBlockView);
    const toggleSettings = useAppStore((s) => s.toggleSettings);
    // Phase 6.4 — mod data is per campaign (`DATA_POLICY.md` §3), so the delete
    // action needs one open. With none, the button says why instead of failing.
    const activeCampaignId = useAppStore((s) => s.activeCampaignId);
    const { t } = useTranslation();

    const [mods, setMods] = useState<ValidatedMod[]>([]);
    const [faults, setFaults] = useState<ModFault[]>([]);
    const [runtimeFaults, setRuntimeFaults] = useState<ModFault[]>(collectRuntimeFaults);
    const [loading, setLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);
    const [guideOpen, setGuideOpen] = useState(false);
    // Bumped by the rescan button. The server re-reads the folder on every request, so a
    // rescan is all that stands between "drop a file in" and seeing it here — no restart.
    const [reloadToken, setReloadToken] = useState(0);

    // Phase 6.1 — the pending native-tier trust dialog. When set, a native
    // mod's enable is on hold until the user confirms or cancels. The toggle
    // does NOT write `moduleEnabled` until confirmation; a cancel leaves the
    // mod in its prior (off) state, which the checkbox reflects because no
    // write happened.
    const [pendingTrust, setPendingTrust] = useState<{ mod: ValidatedMod } | null>(null);

    /**
     * Phase 6.4 / `DATA_POLICY.md` §5 — the two blocking confirmations.
     *
     * `pendingDisable` holds a mod whose toggle-off is on hold. The write is
     * deferred exactly the way the trust dialog defers an enable: nothing is
     * written until the user confirms, so a cancel needs no revert — the
     * checkbox still reflects the state on disk because no write happened.
     *
     * `pendingDelete` holds a mod whose data is about to be erased. Confirming
     * runs `cleanModData` (the mod's `clean` hook, then the host's
     * unconditional clear); `deleteBusy` blocks a second click while it runs
     * and `deleteNote` reports the outcome inline on the row — including the
     * failure case, because "we could not delete it" is something the user has
     * to be told rather than left to assume.
     */
    const [pendingDisable, setPendingDisable] = useState<ValidatedMod | null>(null);
    const [pendingDelete, setPendingDelete] = useState<ValidatedMod | null>(null);
    const [deleteBusy, setDeleteBusy] = useState<string | null>(null);
    const [deleteNote, setDeleteNote] = useState<Record<string, string>>({});

    // Phase 6.1 — a ref to the scroll container so a mod row's "Settings"
    // link can scroll its ModPanels section into view. The container is the
    // scrollable content area of SettingsModal (the parent), not this div.
    const scrollRootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let cancelled = false;
        // `setLoading(true)` belongs to the rescan handler, not here — setting state
        // synchronously inside an effect triggers a cascading render. The initial `true`
        // comes from useState.
        // `refreshMods`, not `fetchMods`: this both lists the mods AND registers them as
        // contribution modules, so pressing Rescan after editing a file takes effect on the
        // next turn. Listing without registering would show mods that do nothing.
        refreshMods()
            .then((result) => {
                if (cancelled) return;
                setMods([...result.mods]);
                setFaults([...result.faults]);
                setLoadFailed(false);
            })
            .catch(() => {
                if (cancelled) return;
                setMods([]);
                setFaults([]);
                setLoadFailed(true);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [reloadToken]);

    // One effect per store, all re-reading the same list. Strikes and latching
    // are declined for the runtime stores (`EVENTS.md` §5.3): a throwing
    // listener, a throwing macro resolver and a throwing interceptor each cost
    // one try/catch, and surfacing them here is the whole remedy.
    useEffect(() => {
        const unsubscribes = RUNTIME_FAULT_STORES.map((store) =>
            store.subscribe(() => setRuntimeFaults(collectRuntimeFaults())));
        return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
    }, []);

    const allFaults = useMemo(() => {
        const loadFiles = new Set(faults.map((fault) => fault.file));
        // Dedup by file: a load-time fault and a runtime fault for the same
        // file would otherwise render twice. Load-time faults win (they are
        // the more actionable — the file itself is bad).
        const seen = new Set(loadFiles);
        const merged: ModFault[] = [...faults];
        for (const fault of runtimeFaults) {
            if (!seen.has(fault.file)) {
                seen.add(fault.file);
                merged.push(fault);
            }
        }
        return merged;
    }, [faults, runtimeFaults]);

    // A factory, not a singleton (see `createFinalUserRegistry`) — built once per mount.
    const builtinRows = useMemo<ModuleRow[]>(
        () => createFinalUserRegistry()
            .list()
            .filter((module) => module.toggleable !== false)
            .map((module) => toRow(module)),
        [],
    );

    const modRows = useMemo<ModuleRow[]>(
        () => mods.map((mod) => toModRow(mod, allFaults)),
        [mods, allFaults],
    );

    const moduleEnabled = settings.moduleEnabled;

    /** Mirrors `payloadBuilder`'s predicate exactly. Do not "improve" this. */
    const isEnabled = useCallback(
        (id: string) => moduleEnabled?.[id] !== false,
        [moduleEnabled],
    );

    /**
     * Phase 6.1 — write enablement AND fire the native lifecycle hooks.
     *
     * For a native-tier mod being turned ON, this checks the trust store
     * first. If the user has not yet accepted the native-tier warning for
     * this mod id (`needsNativeTrustWarning`), the write is deferred: the
     * dialog is shown and `pendingTrust` holds the mod. The checkbox stays
     * in its prior state because no write happened. On confirm, the dialog's
     * `onConfirm` records acceptance and calls `doEnable` directly, which
     * skips the check.
     */
    const setEnabled = (id: string, enabled: boolean) => {
        // Phase 6.4 / `DATA_POLICY.md` §5 — the disable disclosure. Switching a
        // mod off keeps its data (§1) but changes how the campaign plays, and
        // the GM keeps narrating what the mod used to track. There is no
        // graceful degradation coming (§6): this sentence is the mitigation,
        // so it blocks. Mods only — a built-in module has no mod data and no
        // hundreds of scenes written around it.
        if (!enabled && id.startsWith('mod.')) {
            const mod = mods.find((m) => m.id === id.slice(4));
            if (mod) {
                setPendingDisable(mod);
                return;
            }
        }
        // Phase 6.1 — the native-tier gate. Only a mod with a `native` block
        // triggers the dialog; declarative and sandboxed-compute mods skip it
        // entirely (TRUST.md §A: they do not receive page-level access).
        if (enabled && id.startsWith('mod.')) {
            const modId = id.slice(4);
            const mod = mods.find((m) => m.id === modId);
            if (mod?.native) {
                // The trust check is async; show the dialog when it resolves
                // true. The toggle is NOT written yet, so the checkbox's
                // `checked` reflects the prior state until the dialog resolves.
                needsNativeTrustWarning(getNativeTrustStore(), modId, true)
                    .then((needs) => {
                        if (needs) setPendingTrust({ mod });
                        else doEnable(id, mod, true);
                    })
                    .catch(() => {
                        // A trust-store failure is not a reason to enable a
                        // native mod without consent. Treat as "needs warning"
                        // so the user still sees the dialog.
                        setPendingTrust({ mod });
                    });
                return;
            }
        }
        doEnable(id, undefined, enabled);
    };

    /**
     * The actual write — split out so the trust dialog's confirm path can call
     * it directly without re-running the trust check. Fires the native
     * lifecycle hooks for native-tier mods (Phase 1.5).
     */
    const doEnable = (id: string, mod: ValidatedMod | undefined, enabled: boolean) => {
        const next = { ...(moduleEnabled ?? {}), [id]: enabled };
        updateSettings({ moduleEnabled: next });
        setRoleModuleEnabled(next);
        // Phase 1.5 — fire the lifecycle enable/disable hooks for native
        // mods. The settings write is the source of truth for enablement;
        // the lifecycle call is the side-effect that mounts/unmounts the
        // mod's code and CSS. A mod whose id starts with `mod.` and has a
        // `native` block is a native-tier mod. The call is fire-and-forget
        // (the host contains faults and surfaces them in the fault list
        // below), so a slow or throwing hook does not block the toggle.
        if (id.startsWith('mod.') && mod?.native) {
            if (enabled) {
                enableNativeMod(mod).catch((e) => console.warn('[mods] enable failed:', e));
            } else {
                disableNativeMod(mod).catch((e) => console.warn('[mods] disable failed:', e));
            }
        }
    };

    /**
     * Phase 6.1 — the trust dialog's affirmative action. Records acceptance,
     * clears the dialog, and performs the deferred enable.
     */
    const onTrustConfirm = () => {
        const pending = pendingTrust;
        if (!pending) return;
        const id = `mod.${pending.mod.id}`;
        recordNativeTrustAcceptance(getNativeTrustStore(), pending.mod.id, pending.mod.version)
            .catch((e) => console.warn('[mods] trust acceptance write failed:', e))
            .finally(() => {
                setPendingTrust(null);
                doEnable(id, pending.mod, true);
            });
    };

    /**
     * Phase 6.1 — the trust dialog's safe action. Clears the dialog without
     * writing enablement, so the checkbox reverts to its prior (off) state.
     */
    const onTrustCancel = () => {
        setPendingTrust(null);
    };

    /**
     * Phase 6.4 — the disable dialog's affirmative action. Performs the
     * deferred write; the mod's data is untouched either way (§1 freeze).
     */
    const onDisableConfirm = () => {
        const mod = pendingDisable;
        if (!mod) return;
        setPendingDisable(null);
        doEnable(`mod.${mod.id}`, mod, false);
    };

    /**
     * Phase 6.4 — the delete dialog's affirmative action, and the only path in
     * the app that erases mod data. `cleanModData` fires the mod's `clean`
     * hook and then clears the mod's provisioned tables unconditionally.
     */
    const onDeleteConfirm = () => {
        const mod = pendingDelete;
        if (!mod) return;
        setPendingDelete(null);
        setDeleteBusy(mod.id);
        cleanModData(mod)
            .then((removed) => {
                setDeleteNote((notes) => ({
                    ...notes,
                    [mod.id]: removed.length > 0
                        ? t('settings.extensions.modData.delete.done', { count: removed.length })
                        : t('settings.extensions.modData.delete.none'),
                }));
            })
            .catch((error: unknown) => {
                setDeleteNote((notes) => ({
                    ...notes,
                    [mod.id]: t('settings.extensions.modData.delete.failed', {
                        reason: error instanceof Error ? error.message : String(error),
                    }),
                }));
            })
            .finally(() => setDeleteBusy(null));
    };

    const allRows = useMemo(() => [...builtinRows, ...modRows], [builtinRows, modRows]);

    /**
     * Back to each module's `defaultEnabled`.
     *
     * Writes an explicit `false` only for modules that default to off; everything else is
     * omitted, because absent already means enabled. That also drops stale entries left by
     * mods the user has since deleted.
     */
    const resetToDefaults = () => {
        const next: Record<string, boolean> = {};
        for (const row of allRows) {
            if (!row.defaultEnabled) next[row.id] = false;
        }
        updateSettings({ moduleEnabled: next });
    };

    const atDefaults = allRows.every((row) => isEnabled(row.id) === row.defaultEnabled);

    /**
     * Phase 6.1 — scroll a mod's declared-settings section into view. The
     * ModPanels component renders one section per (mod × panel) with a
     * `data-mod-panel` attribute; the first one for this mod id is the
     * target. `scrollIntoView` is the browser-native, no-library scroll.
     */
    const scrollToModSettings = (modId: string) => {
        const el = scrollRootRef.current?.querySelector(`[data-mod-panel="${modId}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    const renderRow = (row: ModuleRow) => {
        const checked = isEnabled(row.id);
        const inputId = `extension-${row.id}`;
        return (
            <div
                key={row.id}
                className={`flex items-start justify-between gap-3 bg-void p-3 border rounded ${
                    row.fault ? 'border-danger/50' : 'border-border'
                }`}
            >
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                        <label
                            htmlFor={inputId}
                            className="chrome-label block text-[11px] text-text-primary uppercase tracking-wider font-bold cursor-pointer"
                        >
                            {row.name}
                        </label>
                        {row.tier && (
                            <span
                                className={`text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold ${
                                    row.tier === 'native'
                                        ? 'bg-danger/15 text-danger border border-danger/40'
                                        : row.tier === 'sandboxed'
                                          ? 'bg-terminal/10 text-terminal border border-terminal/30'
                                          : 'bg-text-dim/10 text-text-dim border border-text-dim/30'
                                }`}
                                title={t(`settings.extensions.mod.tier.${row.tier}`)}
                            >
                                {t(`settings.extensions.mod.tier.${row.tier}`)}
                            </span>
                        )}
                        {row.provenance === 'bundled' && (
                            <span
                                className="text-[8px] uppercase tracking-wider px-1.5 py-0.5 rounded font-bold bg-ember/10 text-ember border border-ember/30"
                                title={t('settings.extensions.mod.provenance.bundled')}
                            >
                                {t('settings.extensions.mod.provenance.bundled')}
                            </span>
                        )}
                    </div>
                    <p className="text-[9px] text-text-dim leading-tight">{row.description}</p>
                    {row.meta && (
                        <p className="text-[9px] text-text-dim/70 font-mono leading-tight mt-1">{row.meta}</p>
                    )}
                    {row.author && (
                        <p className="text-[9px] text-text-dim/70 leading-tight mt-0.5">
                            {t('settings.extensions.mod.author', { author: row.author })}
                        </p>
                    )}
                    {row.folder && (
                        <p className="text-[9px] text-text-dim/70 font-mono leading-tight mt-0.5">
                            {t('settings.extensions.mod.folder', { folder: row.folder })}
                        </p>
                    )}
                    {row.roleReplacements?.map((role) => (
                        <p key={role.name} className="text-[9px] text-text-dim/70 leading-tight mt-0.5">
                            {t('settings.extensions.mod.roleReplaces', { role: role.name })}
                            {role.active
                                ? ' · ' + t('settings.extensions.mod.roleActive')
                                : role.overriddenBy
                                    ? ' · ' + t('settings.extensions.mod.roleOverriddenBy', { mod: role.overriddenBy })
                                    : ' · ' + t('settings.extensions.mod.roleNoProvider')}
                        </p>
                    ))}
                    {/* Phase 6.1 — the inline fault. The reason appears next to
                     * the mod it rejected, not in a separate section the user
                     * must know to scroll to. The fault is matched to the mod
                     * by `mod.file` (the manifest label), so a load-time parse
                     * error or a runtime lifecycle throw both land here. */}
                    {row.fault && (
                        <p className="text-[9px] text-danger leading-tight mt-1.5 break-words">
                            {t('settings.extensions.mod.faultInline', { reason: row.fault.reason })}
                        </p>
                    )}
                    {/* Phase 6.1 — a link to the mod's declared settings. The
                     * ModPanels section for this mod is rendered below; the
                     * link scrolls it into view. Only shown when the mod
                     * declares at least one panel. */}
                    {row.hasSettings && (
                        <button
                            type="button"
                            onClick={() => scrollToModSettings(row.id.slice(4))}
                            className="text-[9px] uppercase tracking-wider text-terminal hover:text-terminal/80 mt-1.5 flex items-center gap-1"
                        >
                            <Settings size={9} />
                            {t('settings.extensions.mod.settings')}
                        </button>
                    )}
                    {/* Phase 6.4 — the delete action (`DATA_POLICY.md` §3).
                      * Mod rows only: a built-in module owns no mod tables.
                      * Bundled mods included — a bundled mod's data is the
                      * user's data, and clearing it is not the same act as
                      * removing the mod, which the app never does at all.
                      * The dialog is what makes this destructive click legal;
                      * this button only opens it. */}
                    {row.tier && (
                        <button
                            type="button"
                            onClick={() => {
                                const mod = mods.find((m) => `mod.${m.id}` === row.id);
                                if (mod) setPendingDelete(mod);
                            }}
                            disabled={!activeCampaignId || deleteBusy === row.id.slice(4)}
                            title={activeCampaignId ? undefined : t('settings.extensions.modData.delete.noCampaign')}
                            className="text-[9px] uppercase tracking-wider text-danger hover:text-danger/80 disabled:opacity-40 disabled:cursor-not-allowed mt-1.5 flex items-center gap-1"
                        >
                            <Trash2 size={9} />
                            {deleteBusy === row.id.slice(4)
                                ? t('settings.extensions.modData.delete.busy')
                                : t('settings.extensions.modData.delete.action')}
                        </button>
                    )}
                    {deleteNote[row.id.slice(4)] && (
                        <p className="text-[9px] text-text-dim leading-tight mt-1 break-words">
                            {deleteNote[row.id.slice(4)]}
                        </p>
                    )}
                </div>
                <input
                    id={inputId}
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setEnabled(row.id, e.target.checked)}
                    aria-label={t('settings.extensions.toggle.aria', { name: row.name })}
                    className="mt-0.5 shrink-0 w-4 h-4 accent-terminal cursor-pointer"
                />
            </div>
        );
    };

    return (
        <div className="space-y-6" ref={scrollRootRef}>
            <div className="flex items-start justify-between gap-3">
                <div>
                    <label className="chrome-label text-text-dim text-xs uppercase tracking-widest font-bold block mb-1 flex items-center gap-1.5">
                        <Puzzle size={12} /> {t('settings.extensions.title')}
                    </label>
                    {/* Locked decision D4 — global, not per-campaign. Said plainly, once. */}
                    <p className="text-[9px] text-text-dim leading-tight max-w-[420px]">
                        {t('settings.extensions.scope')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={resetToDefaults}
                    disabled={atDefaults}
                    className="shrink-0 text-[10px] uppercase tracking-widest bg-terminal/10 border border-terminal/30 text-terminal px-3 py-1.5 rounded hover:bg-terminal/20 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                >
                    <RotateCcw size={10} />
                    {t('settings.extensions.reset')}
                </button>
                {/* WO-P5-02 §3 — cross-link to the Block View. The two screens toggle the
                 * same `moduleEnabled` state; a user who finds one should find the other.
                 * The Block View is a Header-launched modal, so opening it from here closes
                 * Settings first (the two are mutually exclusive overlays). */}
                <button
                    type="button"
                    onClick={() => { toggleSettings(); toggleBlockView(); }}
                    title={t('blockview.link.extensions.help')}
                    className="shrink-0 text-[10px] uppercase tracking-widest bg-ember/10 border border-ember/30 text-ember px-3 py-1.5 rounded hover:bg-ember/20 flex items-center gap-1.5"
                >
                    <Workflow size={10} />
                    {t('blockview.link.extensions')}
                </button>
            </div>

            {/* ── Built-in ─────────────────────────────────────────────────── */}
            <div className="space-y-2">
                <div>
                    <label className="chrome-label block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
                        {t('settings.extensions.builtin.title')}
                    </label>
                    <p className="text-[9px] text-text-dim leading-tight max-w-[420px]">
                        {t('settings.extensions.builtin.help')}
                    </p>
                </div>
                <div className="md:grid md:grid-cols-2 md:gap-3 space-y-2 md:space-y-0">
                    {builtinRows.map(renderRow)}
                </div>
            </div>

            {/* ── Installed mods ───────────────────────────────────────────── */}
            <div className="space-y-2">
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <label className="chrome-label block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1">
                            {t('settings.extensions.mods.title')}
                        </label>
                        <p className="text-[9px] text-text-dim leading-tight max-w-[420px]">
                            {t('settings.extensions.mods.help')}
                        </p>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => setGuideOpen((open) => !open)}
                            aria-expanded={guideOpen}
                            aria-controls="extensions-mod-guide"
                            className="text-[10px] uppercase tracking-widest bg-terminal/10 border border-terminal/30 text-terminal px-3 py-1.5 rounded hover:bg-terminal/20 flex items-center gap-1.5"
                        >
                            <BookOpen size={10} />
                            {t(guideOpen ? 'settings.extensions.guide.hide' : 'settings.extensions.guide.show')}
                        </button>
                        <button
                            type="button"
                            onClick={() => { setLoading(true); setReloadToken((n) => n + 1); }}
                            disabled={loading}
                            className="text-[10px] uppercase tracking-widest bg-terminal/10 border border-terminal/30 text-terminal px-3 py-1.5 rounded hover:bg-terminal/20 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                        >
                            {loading ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
                            {t('settings.extensions.mods.rescan')}
                        </button>
                    </div>
                </div>

                {/*
                  * Rendered only while open: parsing a ~250-line document on every Settings mount
                  * to keep it hidden would be work nobody asked for.
                  *
                  * `gm-prose` is the app's existing markdown skin (headings, tables, code fences) —
                  * reused rather than restyled so the guide can't drift from the rest of the app.
                  * No `rehype-raw`: the guide renders as markdown only, never as HTML.
                  */}
                {guideOpen && (
                    <div
                        id="extensions-mod-guide"
                        className="bg-void border border-border rounded p-4 overflow-x-auto"
                    >
                        <p className="text-[9px] text-text-dim leading-tight mb-3 pb-3 border-b border-border">
                            {t('settings.extensions.guide.path', { path: GUIDE_PATH })}
                        </p>
                        <div className="gm-prose text-[11px]">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{modGuideMarkdown}</ReactMarkdown>
                        </div>
                    </div>
                )}

                {loading && (
                    <p className="text-[9px] text-text-dim italic">{t('settings.extensions.mods.loading')}</p>
                )}

                {!loading && loadFailed && (
                    <p className="text-[9px] text-danger leading-tight">{t('settings.extensions.mods.error')}</p>
                )}

                {!loading && !loadFailed && modRows.length === 0 && (
                    <p className="text-[9px] text-text-dim leading-tight max-w-[420px]">
                        {t('settings.extensions.mods.empty')}
                    </p>
                )}

                {modRows.length > 0 && (
                    <div className="md:grid md:grid-cols-2 md:gap-3 space-y-2 md:space-y-0">
                        {modRows.map(renderRow)}
                    </div>
                )}
            </div>

            {/* ── Load order (Phase 6.2) ──────────────────────────────────── */}
            {/*
              * The resolved load order with user-reorderable controls. Renders
              * only when at least one mod is installed. The user's override
              * persists to `settings.modLoadOrder` and beats the manifest's
              * `loadOrder` as the primary tiebreak in the server's topological
              * sort. Conflicts (fact claims) surface on the losing row with
              * the winner named. Dependency-violating moves are prevented in
              * the UI rather than allowed and faulted later.
              */}
            {!loading && !loadFailed && mods.length > 0 && (
                <LoadOrderSection mods={mods} />
            )}

            {/* ── Mod panels (WO-P5-16) ─────────────────────────────────── */}
            {/*
              * A mod that declares `panels[]` renders one panel per declaration,
              * nested under the mod that declared it (R4: launch is always
              * `nested`). The host resolves `bindsTo` against the store's
              * `modTables` map; the generic `PanelRenderer` receives rows and
              * a descriptor and cannot tell a mod panel from a host panel
              * (§4 — the renderer must not learn who owns the panel). Edits
              * round-trip to disk through `setModTable`'s fire-and-forget PUT.
              *
              * Phase 6.1 — a mod row's "Settings" link scrolls to its section
              * here via `data-mod-panel="<modId>"`.
              */}
            {!loading && !loadFailed && <ModPanels mods={mods} />}

            {/* ── Mod screens (WO-P5-17) ─────────────────────────────────── */}
            {/*
              * A mod that declares `screens[]` renders one isolated frame
              * per screen, nested under the mod that declared it (R4 of
              * WO-P5-16: mod UI lives in Extensions). The frame is
              * `sandbox="allow-scripts"` with no same-origin capability
              * (R1); the screen source ships as text and the server never
              * evaluates it (R2); the CSP `default-src 'none'` leaves the
              * frame no network (R3); one frame per screen, destroyed on
              * unmount (R4); a fault surfaces on the fault list below
              * (R5); no host API in 5.1 — the frame receives nothing and
              * sends nothing (R6). A 5.1 screen is useless on purpose.
              */}
            {!loading && !loadFailed && <ModScreens mods={mods} />}

            {/* ── Rejected files ───────────────────────────────────────────── */}
            {/*
              * Phase 6.1 — the section still exists, but a fault that matches
              * a mod now also appears inline in that mod's row (above). This
              * section shows the faults that have no matching mod row:
              *  • `<loader>` — the mods endpoint could not be reached.
              *  • A flat `.mod.json` file — rejected before a mod object exists.
              *  • A directory with no `manifest.json` — same.
              *  • A duplicate mod id — the second copy is dropped.
              * The inline view is the primary surface; this section is the
              * catch-all so nothing is silently swallowed.
              */}
            {allFaults.length > 0 && (
                <div className="space-y-2">
                    <div>
                        <label className="chrome-label block text-[11px] text-danger uppercase tracking-wider font-bold mb-1 flex items-center gap-1.5">
                            <AlertTriangle size={11} /> {t('settings.extensions.faults.title')}
                        </label>
                        <p className="text-[9px] text-text-dim leading-tight max-w-[420px]">
                            {t('settings.extensions.faults.help')}
                        </p>
                        <p className="text-[9px] text-text-dim leading-tight max-w-[420px] mt-1">
                            {t('settings.extensions.faults.runtime')}
                        </p>
                    </div>
                    <div className="space-y-2">
                        {allFaults.map((fault) => (
                            <div
                                key={fault.file}
                                className="bg-void p-3 border border-danger/40 rounded"
                            >
                                <div className="text-[11px] font-mono font-bold text-text-primary break-all">
                                    {fault.file}
                                </div>
                                <p className="text-[9px] text-danger leading-tight mt-1 break-words">
                                    {fault.reason}
                                </p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Phase 6.1 — the native-tier trust dialog. Rendered last so it
             * overlays everything (z-[200], above the Settings modal's z-[100]).
             * Only one dialog at a time; `pendingTrust` is the pending mod. */}
            {pendingTrust && (
                <NativeTrustDialog
                    modName={pendingTrust.mod.name}
                    onConfirm={onTrustConfirm}
                    onCancel={onTrustCancel}
                />
            )}

            {/* Phase 6.4 — the two data confirmations. Same layer as the trust
              * dialog and mutually exclusive with it in practice: the trust
              * dialog gates an enable, these gate a disable and a delete. */}
            {pendingDisable && (
                <ModDataDialog
                    variant="disable"
                    modName={pendingDisable.name}
                    onConfirm={onDisableConfirm}
                    onCancel={() => setPendingDisable(null)}
                />
            )}
            {pendingDelete && (
                <ModDataDialog
                    variant="delete"
                    modName={pendingDelete.name}
                    onConfirm={onDeleteConfirm}
                    onCancel={() => setPendingDelete(null)}
                />
            )}
        </div>
    );
}
