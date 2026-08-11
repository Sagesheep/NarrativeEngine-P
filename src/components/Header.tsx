import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Settings, PanelLeftOpen, PanelLeftClose, LogOut, Users, Archive, Save, Pin, Cpu, MapPin, UserCircle, Workflow } from 'lucide-react';
import { createBackup } from '../store/campaignStore';
import { flushAllPendingSaves } from '../store/slices/campaignSlice';
import { toast } from './Toast';
import { useAppStore } from '../store/useAppStore';
import { TokenGauge } from './TokenGauge';
import { BackgroundControl } from './BackgroundControl';
import { saveCampaignState } from '../store/campaignStore';
import type { AiTier } from '../types/llm';
import { APP_VERSION } from '../version';
import { useTranslation } from '../i18n/useTranslation';
import { readRegion, subscribeToRegion, type RegisteredChromeEntry } from '../services/mods/mounts/mountRegistry';
import { registerHeaderBuiltins, HEADER_BUILTIN_ID_SET } from '../services/mods/mounts/headerBuiltins';
import { renderHeaderModEntry } from '../services/mods/mounts/chromeRenderers';

const TIER_CYCLE: Record<AiTier, AiTier> = { lite: 'pro', pro: 'max', max: 'lite' };

// Register the header's built-in actions once at module load, before any
// mod's `activate` runs. Idempotent on a second import.
registerHeaderBuiltins();

/**
 * Subscribe to the header.actions region so the row re-renders on
 * add/remove/update. `useSyncExternalStore` is the React 18+ primitive for
 * external stores; it re-renders on every `notifyRegion` call.
 */
function useHeaderActions(): readonly RegisteredChromeEntry[] {
    return useSyncExternalStore(
        (listener) => subscribeToRegion('header.actions', listener),
        () => readRegion('header.actions'),
        () => readRegion('header.actions'),
    );
}

export function Header() {
    const {
        toggleSettings,
        toggleDrawer,
        toggleNPCLedger,
        togglePCPanel,
        toggleLocationLedger,
        toggleBlockView,
        toggleBackupModal,
        togglePinnedMemories,
        drawerOpen,
        activeCampaignId,
        setActiveCampaign,
        context,
        messages,
        condenser,
        divergenceRegister,
        settings,
        updateSettings,
    } = useAppStore();

    const pinnedExcerpts = useAppStore(s => s.pinnedExcerpts);
    const aiTier = (settings?.aiTier ?? 'pro') as AiTier;
    const { t } = useTranslation();
    const handleExit = async () => {
        if (activeCampaignId) {
            await saveCampaignState(activeCampaignId, { context, messages, condenser, pinnedExcerpts });
            if (divergenceRegister && (divergenceRegister.entries.length > 0 || (divergenceRegister.prunedLog ?? []).length > 0)) {
                try {
                    const { saveDivergenceRegister } = await import('../store/campaignStore');
                    await saveDivergenceRegister(activeCampaignId, divergenceRegister);
                } catch (e) { console.warn('[Header] saveDivergenceRegister failed:', e); }
            }
        }
        setActiveCampaign(null);
    };

    const handleBackup = async () => {
        if (!activeCampaignId) return;
        await flushAllPendingSaves();
        const result = await createBackup(activeCampaignId, { trigger: 'manual', label: 'Manual backup' });
        if (result?.skipped) {
            toast.info(t('header.backup.toast.noChanges'));
        } else if (result?.timestamp) {
            toast.success(t('header.backup.toast.created'));
        } else {
            toast.error(t('header.backup.toast.failed'));
        }
    };

    const ordered = useHeaderActions();

    return (
        <header className="h-12 bg-surface border-b border-border flex items-center px-2 sm:px-4 gap-1 sm:gap-2 shrink-0">
            <button
                onClick={toggleDrawer}
                className="flex items-center justify-center w-8 h-8 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer"
                title={drawerOpen ? t('header.drawer.close') : t('header.drawer.open')}
                aria-label={drawerOpen ? t('header.drawer.close') : t('header.drawer.open')}
            >
                {drawerOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
            </button>

            <h1 className="chrome-label hidden md:block text-terminal text-sm font-bold tracking-[0.3em] uppercase glow-green shrink-0">
                {t('header.title')}
            </h1>
            <span className="hidden md:inline text-[9px] font-mono text-text-dim shrink-0" title={t('header.version.tooltip', { version: APP_VERSION })}>
                v{APP_VERSION}
            </span>

            <div className="hidden md:flex flex-1 items-center gap-4">
                <TokenGauge />
            </div>

            <div className="flex items-center gap-1.5 ml-auto overflow-x-auto no-scrollbar py-1 shrink-0">
                <BackgroundControl />

                {/*
                  * Phase 4.2 — the right-hand action group is now the
                  * `header.actions` mount region. The registry returns the
                  * eleven built-ins in their declared order (each with its
                  * own bespoke renderer below) plus any mod entries that
                  * inserted between the leading built-ins and the trailing
                  * group (`settings` + `exit`). Mod entries render through
                  * the generic chrome renderer.
                  *
                  * Zero-mod output is byte-identical to the pre-4.2 header:
                  * the registry returns exactly the eleven built-ins in the
                  * same order, and each renders with its existing markup.
                  */}
                {ordered.map((entry) => {
                    if (entry.renderer === 'builtin' && HEADER_BUILTIN_ID_SET.has(entry.entryId)) {
                        return renderHeaderBuiltin(entry.entryId, {
                            t: t as unknown as (key: string, vars?: Record<string, string | number>) => string,
                            aiTier,
                            pinnedExcerpts,
                            onToggleSettings: toggleSettings,
                            onToggleNPCLedger: toggleNPCLedger,
                            onTogglePCPanel: togglePCPanel,
                            onToggleLocationLedger: toggleLocationLedger,
                            onToggleBlockView: toggleBlockView,
                            onToggleBackupModal: toggleBackupModal,
                            onTogglePinnedMemories: togglePinnedMemories,
                            onCycleTier: () => updateSettings({ aiTier: TIER_CYCLE[aiTier] }),
                            onBackup: handleBackup,
                            onExit: handleExit,
                        });
                    }
                    // Mod entry — generic chrome renderer.
                    return renderHeaderModEntry(entry, t as unknown as (key: string, vars?: Record<string, string | number>) => string, NO_LAST_GOOD);
                })}
            </div>
        </header>
    );
}

/**
 * Render a single built-in header button with its bespoke markup. Each
 * branch is byte-identical to the pre-4.2 button — this is how the zero-mod
 * pixel-identity rule stays winnable (MOUNTS.md §8.2). The `key` is the
 * built-in id (the registry's `qualifiedId` for a built-in is the bare id).
 */
function renderHeaderBuiltin(id: string, deps: {
    t: (key: string, vars?: Record<string, string | number>) => string;
    aiTier: AiTier;
    pinnedExcerpts: readonly { id: string }[];
    onToggleSettings: () => void;
    onToggleNPCLedger: () => void;
    onTogglePCPanel: () => void;
    onToggleLocationLedger: () => void;
    onToggleBlockView: () => void;
    onToggleBackupModal: () => void;
    onTogglePinnedMemories: () => void;
    onCycleTier: () => void;
    onBackup: () => void | Promise<void>;
    onExit: () => void | Promise<void>;
}): ReactNode {
    const { t, aiTier, pinnedExcerpts } = deps;
    switch (id) {
        case 'backup':
            return (
                <button
                    key="backup"
                    onClick={deps.onBackup}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.backup.tooltip')}
                    aria-label={t('header.backup.aria')}
                >
                    <Save size={13} />
                    <span className="hidden sm:inline">{t('header.backup.label')}</span>
                </button>
            );
        case 'backups':
            return (
                <button
                    key="backups"
                    onClick={deps.onToggleBackupModal}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.backups.tooltip')}
                    aria-label={t('header.backups.aria')}
                >
                    <Archive size={13} />
                    <span className="hidden sm:inline">{t('header.backups.label')}</span>
                </button>
            );
        case 'character':
            return (
                <button
                    key="character"
                    onClick={deps.onTogglePCPanel}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.character.tooltip')}
                    aria-label={t('header.character.aria')}
                >
                    <UserCircle size={13} />
                    <span>{t('header.character.label')}</span>
                </button>
            );
        case 'npcLedger':
            return (
                <button
                    key="npcLedger"
                    onClick={deps.onToggleNPCLedger}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.npcLedger.tooltip')}
                    aria-label={t('header.npcLedger.aria')}
                >
                    <Users size={13} />
                    <span>{t('header.npcLedger.label')}</span>
                </button>
            );
        case 'places':
            return (
                <button
                    key="places"
                    onClick={deps.onToggleLocationLedger}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.places.tooltip')}
                    aria-label={t('header.places.aria')}
                >
                    <MapPin size={13} />
                    <span className="hidden sm:inline">{t('header.places.label')}</span>
                </button>
            );
        case 'blockView':
            return (
                <button
                    key="blockView"
                    onClick={deps.onToggleBlockView}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.blockView.tooltip')}
                    aria-label={t('header.blockView.aria')}
                >
                    <Workflow size={13} />
                    <span className="hidden sm:inline">{t('header.blockView.label')}</span>
                </button>
            );
        case 'aiTier':
            return (
                <button
                    key="aiTier"
                    onClick={deps.onCycleTier}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.aiTier.tooltip', { tier: aiTier.toUpperCase() })}
                    aria-label={t('header.aiTier.aria', { tier: aiTier })}
                >
                    <Cpu size={13} />
                    <span className="hidden sm:inline">{aiTier}</span>
                </button>
            );
        case 'pinned':
            return (
                <button
                    key="pinned"
                    onClick={deps.onTogglePinnedMemories}
                    className={`chrome-label relative flex items-center gap-1.5 h-8 px-2.5 rounded-sm border transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono ${pinnedExcerpts.length > 0 ? 'border-terminal text-terminal bg-terminal/5' : 'border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal'}`}
                    title={t('header.pinned.tooltip')}
                    aria-label={t('header.pinned.aria')}
                >
                    <Pin size={13} />
                    <span className="hidden sm:inline">{t('header.pinned.label')}</span>
                    {pinnedExcerpts.length > 0 && (
                        <span className="min-w-[14px] h-3.5 bg-terminal text-void text-[8px] font-bold rounded-full flex items-center justify-center px-0.5">
                            {pinnedExcerpts.length}
                        </span>
                    )}
                </button>
            );
        case 'settings':
            return (
                <button
                    key="settings"
                    onClick={deps.onToggleSettings}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-terminal bg-void-lighter hover:bg-terminal/5 text-text-dim hover:text-terminal transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.settings.tooltip')}
                    aria-label={t('header.settings.aria')}
                >
                    <Settings size={13} />
                    <span className="hidden sm:inline">{t('header.settings.label')}</span>
                </button>
            );
        case 'exit':
            return (
                <button
                    key="exit"
                    onClick={deps.onExit}
                    className="chrome-label flex items-center gap-1.5 h-8 px-2.5 rounded-sm border border-border/40 hover:border-ember bg-void-lighter hover:bg-ember/5 text-text-dim hover:text-ember transition-colors shrink-0 cursor-pointer text-[10px] font-bold uppercase tracking-wider font-mono"
                    title={t('header.exit.tooltip')}
                    aria-label={t('header.exit.aria')}
                >
                    <LogOut size={13} />
                    <span className="hidden sm:inline">{t('header.exit.label')}</span>
                </button>
            );
        default:
            return null;
    }
}

/**
 * A stable `lastGoodRef` sentinel for mod entries. The "last good state"
 * refinement (MOUNTS.md §8.6) lands in a later pass; for now a `state()`
 * that throws renders from `undefined` (the entry shows its declared
 * values), and the fault store records the throw. One shared object so
 * every mod entry render uses the same no-op ref.
 */
const NO_LAST_GOOD: { current: import('../services/mods/mounts/mountTypes').ChromeState | undefined } = { current: undefined };