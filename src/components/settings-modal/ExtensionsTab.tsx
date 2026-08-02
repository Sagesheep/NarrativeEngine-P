import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BookOpen, Loader2, Puzzle, RefreshCw, RotateCcw, Workflow } from 'lucide-react';
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
import { refreshMods } from '../../services/mods/modBootstrap';
import { modToContributionModule } from '../../services/mods/modAdapter';
import type { ModFault, ValidatedMod } from '../../services/mods/modTypes';
import { sandboxFaultStore } from '../../services/mods/sandbox/sandboxFaults';
import { screenFaultStore } from '../../services/mods/screenFaults';
import { ModPanels } from './ModPanels';
import { ModScreens } from './ModScreens';

/**
 * Project 2 / WO-P2-05 — the Extensions screen.
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
 *     installed, which is the failure mode the fail-safe design exists to avoid.
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
    /** Mods only: `v1.2.0 · grimdark.mod.json`, shown under the description. */
    meta?: string;
};

const toRow = (module: ContributionModule<FinalUserModuleInput>, meta?: string): ModuleRow => ({
    id: module.id,
    name: module.name,
    description: module.description,
    defaultEnabled: module.defaultEnabled,
    meta,
});

export function ExtensionsTab() {
    const settings = useAppStore((s) => s.settings);
    const updateSettings = useAppStore((s) => s.updateSettings);
    const toggleBlockView = useAppStore((s) => s.toggleBlockView);
    const toggleSettings = useAppStore((s) => s.toggleSettings);
    const { t } = useTranslation();

    const [mods, setMods] = useState<ValidatedMod[]>([]);
    const [faults, setFaults] = useState<ModFault[]>([]);
    const [runtimeFaults, setRuntimeFaults] = useState<ModFault[]>(() => [
        ...sandboxFaultStore.getFaults(),
        ...screenFaultStore.getFaults(),
    ]);
    const [loading, setLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);
    const [guideOpen, setGuideOpen] = useState(false);
    // Bumped by the rescan button. The server re-reads the folder on every request, so a
    // rescan is all that stands between "drop a file in" and seeing it here — no restart.
    const [reloadToken, setReloadToken] = useState(0);

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

    useEffect(() => sandboxFaultStore.subscribe(() => {
        setRuntimeFaults([...sandboxFaultStore.getFaults(), ...screenFaultStore.getFaults()]);
    }), []);

    useEffect(() => screenFaultStore.subscribe(() => {
        setRuntimeFaults([...sandboxFaultStore.getFaults(), ...screenFaultStore.getFaults()]);
    }), []);

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
        () => mods.map((mod) => toRow(
            modToContributionModule(mod),
            t('settings.extensions.mod.meta', { version: mod.version, file: mod.file }),
        )),
        [mods, t],
    );

    const moduleEnabled = settings.moduleEnabled;

    /** Mirrors `payloadBuilder`'s predicate exactly. Do not "improve" this. */
    const isEnabled = useCallback(
        (id: string) => moduleEnabled?.[id] !== false,
        [moduleEnabled],
    );

    const setEnabled = (id: string, enabled: boolean) => {
        updateSettings({ moduleEnabled: { ...(moduleEnabled ?? {}), [id]: enabled } });
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

    const renderRow = (row: ModuleRow) => {
        const checked = isEnabled(row.id);
        const inputId = `extension-${row.id}`;
        return (
            <div
                key={row.id}
                className="flex items-start justify-between gap-3 bg-void p-3 border border-border rounded"
            >
                <div className="min-w-0">
                    <label
                        htmlFor={inputId}
                        className="chrome-label block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1 cursor-pointer"
                    >
                        {row.name}
                    </label>
                    <p className="text-[9px] text-text-dim leading-tight">{row.description}</p>
                    {row.meta && (
                        <p className="text-[9px] text-text-dim/70 font-mono leading-tight mt-1">{row.meta}</p>
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
        <div className="space-y-6">
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

            {/* ── Mod panels (WO-P5-16) ─────────────────────────────────── */}
            {/*
              * A mod that declares `panels[]` renders one panel per declaration,
              * nested under the mod that declared it (R4: launch is always
              * `nested`). The host resolves `bindsTo` against the store's
              * `modTables` map; the generic `PanelRenderer` receives rows and
              * a descriptor and cannot tell a mod panel from a host panel
              * (§4 — the renderer must not learn who owns the panel). Edits
              * round-trip to disk through `setModTable`'s fire-and-forget PUT.
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
        </div>
    );
}
