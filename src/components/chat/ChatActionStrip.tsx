import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Save, Loader2, Zap, Scroll, Search, Package, Dices } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../Toast';
import { OneShotInjectorButton } from '../OneShotInjectorButton';
import { AbsoluteCommandButton } from '../AbsoluteCommandButton';
import { useTranslation } from '../../i18n/useTranslation';
import { readRegion, subscribeToRegion, type RegisteredChromeEntry } from '../../services/mods/mounts/mountRegistry';
import { registerComposerBuiltins, COMPOSER_BUILTIN_ID_SET } from '../../services/mods/mounts/composerBuiltins';
import { renderComposerModEntry } from '../../services/mods/mounts/chromeRenderers';
import type { ChromeState } from '../../services/mods/mounts/mountTypes';

// Register the composer strip's built-in actions once at module load, before
// any mod's `activate` runs. Idempotent on a second import.
registerComposerBuiltins();

/**
 * Subscribe to the composer.actions region so the row re-renders on
 * add/remove/update.
 */
function useComposerActions(): readonly RegisteredChromeEntry[] {
    return useSyncExternalStore(
        (listener) => subscribeToRegion('composer.actions', listener),
        () => readRegion('composer.actions'),
        () => readRegion('composer.actions'),
    );
}

/**
 * `MOUNTS.md` §8.8 — drain a pending commit before dispatching a mod entry's
 * `onSelect` from `composer.actions`. The work a chat-adjacent mod triggers
 * typically reads engine state the commit derives, and `CONTRACT.md` L3
 * forbids a mod committing a turn itself — so the host does it. Lazy-imported
 * so this module stays testable without the turn pipeline.
 */
async function drainPendingCommit(): Promise<void> {
    try {
        const { commitPendingTurn } = await import('../../services/turn/pendingCommit');
        await commitPendingTurn().catch((e) => console.warn('[composer.actions] commit drain failed:', e));
    } catch (e) {
        console.warn('[composer.actions] commit drain import failed:', e);
    }
}

/**
 * The horizontal button strip above the composer: Save, Trim, Deep Search,
 * Dice Me, Roll Loot, One-Shot injector, Absolute Command, Ask GM, Archive.
 * Extracted from ChatArea; arming state lives in the store.
 *
 * Phase 4.2 — the strip is now the `composer.actions` mount region. The
 * registry returns the nine built-ins in their declared order (each with
 * its own bespoke renderer below) plus any mod entries that inserted between
 * the leading built-ins and the trailing group (`archive`). The arc mod's
 * "Inject Arc" button returns as a mod-claimed entry it registers from its
 * `activate` hook (`MOUNTS.md` §2.3), NOT as a host-owned component.
 *
 * Zero-mod output is byte-identical to the pre-4.2 strip — except the arc
 * button is absent until the arc mod's `activate` registers it, which is
 * the un-parking 4.0 always said 4.2 would do.
 */
export function ChatActionStrip({
    isStreaming,
    isSaving,
    messagesCount,
    onForceSave,
    onTrim,
    onOpenOoc,
    onOpenArchive,
}: {
    isStreaming: boolean;
    isSaving: boolean;
    messagesCount: number;
    onForceSave: () => void;
    onTrim: () => void;
    onOpenOoc: () => void;
    onOpenArchive: () => void;
}) {
    const settings = useAppStore(s => s.settings);
    const context = useAppStore(s => s.context);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const deepArmed = useAppStore(s => s.deepArmed);
    const setDeepArmed = useAppStore(s => s.setDeepArmed);
    const armedRoll = useAppStore(s => s.armedRoll);
    const setArmedRoll = useAppStore(s => s.setArmedRoll);
    const openDiceRollModal = useAppStore(s => s.openDiceRollModal);
    const armedLoot = useAppStore(s => s.armedLoot);
    const openLootRollModal = useAppStore(s => s.openLootRollModal);
    const { t } = useTranslation();

    const ordered = useComposerActions();

    return (
        <div className="px-2 md:px-4 pb-1 flex gap-2 overflow-x-auto no-scrollbar">
            {ordered.map((entry) => {
                if (entry.renderer === 'builtin' && COMPOSER_BUILTIN_ID_SET.has(entry.entryId)) {
                    return renderComposerBuiltin(entry.entryId, {
                        t: t as unknown as (key: string, vars?: Record<string, string | number>) => string,
                        isStreaming,
                        isSaving,
                        messagesCount,
                        onForceSave,
                        onTrim,
                        onOpenOoc,
                        onOpenArchive,
                        settings,
                        context,
                        activeCampaignId,
                        deepArmed,
                        setDeepArmed,
                        armedRoll,
                        setArmedRoll: setArmedRoll as (v: unknown) => void,
                        openDiceRollModal,
                        armedLoot,
                        openLootRollModal,
                    });
                }
                // Mod entry — generic chrome renderer. The §8.8
                // pending-commit drain fires before `onSelect`.
                return (
                    <ModComposerEntry
                        key={entry.qualifiedId}
                        entry={entry}
                        t={t as unknown as (key: string, vars?: Record<string, string | number>) => string}
                    />
                );
            })}
        </div>
    );
}

/**
 * A mod's composer entry. The §8.8 pending-commit drain fires before the
 * mod's `onSelect`, and the drain is handed to the renderer rather than
 * wrapped around `onSelect`.
 *
 * The wrapper this replaced drained INSIDE the dispatch — but the renderer's
 * Phase 9.2 context refresh runs before it calls `onSelect`, so the mod was
 * handed a context snapshotted ahead of the commit it was supposed to see.
 * Passing `drainPendingCommit` through keeps the order the region promises:
 * drain, then refresh, then dispatch. `message.actions` already worked this
 * way; this is the same shape.
 */
function ModComposerEntry({
    entry,
    t,
}: {
    entry: RegisteredChromeEntry;
    t: (key: string, vars?: Record<string, string | number>) => string;
}) {
    return <>{renderComposerModEntry(entry, t, NO_LAST_GOOD, drainPendingCommit)}</>;
}

/** A stable `lastGoodRef` sentinel — see Header.tsx's NO_LAST_GOOD. */
const NO_LAST_GOOD: { current: ChromeState | undefined } = { current: undefined };

/** Render a single built-in composer button with its bespoke markup. */
function renderComposerBuiltin(id: string, deps: {
    t: (key: string, vars?: Record<string, string | number>) => string;
    isStreaming: boolean;
    isSaving: boolean;
    messagesCount: number;
    onForceSave: () => void;
    onTrim: () => void;
    onOpenOoc: () => void;
    onOpenArchive: () => void;
    settings: { deepContextSearch?: boolean } | null;
    context: { lootTree?: unknown } | null;
    activeCampaignId: string | null;
    deepArmed: boolean;
    setDeepArmed: (v: boolean) => void;
    armedRoll: unknown;
    setArmedRoll: (v: unknown) => void;
    openDiceRollModal: () => void;
    armedLoot: { rolls: number } | null;
    openLootRollModal: () => void;
}): ReactNode {
    switch (id) {
        case 'save':
            return (
                <button
                    key="save"
                    onClick={deps.onForceSave}
                    disabled={deps.isSaving}
                    className="flex-shrink-0 flex items-center gap-1.5 bg-void border border-emerald-500/30 hover:border-emerald-500 text-emerald-500 text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-emerald-500/5 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                    {deps.isSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    <span className="hidden xs:inline">{deps.isSaving ? 'SAVING...' : 'SAVE CAMPAIGN'}</span>
                    {!deps.isSaving && <span className="inline xs:hidden">SAVE</span>}
                </button>
            );
        case 'trim':
            return (
                <button
                    key="trim"
                    onClick={deps.onTrim}
                    disabled={deps.isStreaming || deps.messagesCount < 6}
                    className="flex-shrink-0 flex items-center gap-1.5 bg-void border border-terminal/30 hover:border-terminal text-terminal text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-terminal/5 disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap"
                    title="Trim history"
                >
                    <Zap size={13} />
                    Trim
                </button>
            );
        case 'deepSearch':
            return deps.settings?.deepContextSearch ? (
                <button
                    key="deepSearch"
                    onClick={() => deps.setDeepArmed(!deps.deepArmed)}
                    disabled={deps.isStreaming || !deps.activeCampaignId}
                    className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap ${deps.deepArmed ? 'border-amber-500 text-amber-500 bg-amber-500/10 hover:bg-amber-500/20' : 'border-amber-500/30 hover:border-amber-500 text-amber-500 hover:bg-amber-500/5'}`}
                    title={deps.deepArmed ? 'Deep Search armed — type to send normally, or Esc to disarm' : 'Arm Deep Archive Search (sends on next Enter)'}
                >
                    <Search size={13} />
                    <span className="hidden xs:inline">{deps.deepArmed ? 'DEEP SEARCH ARMED' : 'Deep Search'}</span>
                    <span className="inline xs:hidden">{deps.deepArmed ? 'ARMED' : 'Deep'}</span>
                </button>
            ) : null;
        case 'diceMe':
            return (
                <button
                    key="diceMe"
                    onClick={() => {
                        if (deps.armedRoll) {
                            deps.setArmedRoll(null);
                        } else {
                            deps.openDiceRollModal();
                        }
                    }}
                    disabled={deps.isStreaming || !deps.activeCampaignId}
                    className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap ${
                        deps.armedRoll
                            ? 'border-amber-500 text-amber-500 bg-amber-500/10 hover:bg-amber-500/20 animate-pulse'
                            : 'border-terminal/30 text-terminal hover:bg-terminal/5'
                    }`}
                    title={deps.armedRoll ? 'Dice armed — click to disarm, or send to roll' : 'Open dice roll configurator'}
                >
                    <Dices size={13} />
                    <span className="hidden xs:inline">{deps.armedRoll ? 'DICE ARMED' : 'Dice Me'}</span>
                    <span className="inline xs:hidden">{deps.armedRoll ? 'ARMED' : 'Dice'}</span>
                </button>
            );
        case 'rollLoot':
            return deps.context?.lootTree ? (
                <button
                    key="rollLoot"
                    onClick={() => {
                        if (!deps.context?.lootTree) {
                            toast.warning('No loot table for this world');
                            return;
                        }
                        deps.openLootRollModal();
                    }}
                    className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all whitespace-nowrap ${
                        deps.armedLoot
                            ? 'border-amber-500 text-amber-500 bg-amber-500/10 hover:bg-amber-500/20 animate-pulse'
                            : 'border-terminal/30 text-terminal/60 hover:text-terminal hover:bg-terminal/5'
                    }`}
                    title={
                        deps.armedLoot
                            ? `Loot armed (${deps.armedLoot.rolls}) — send to drop`
                            : 'Roll loot — arm a drop, send to resolve'
                    }
                >
                    <Package size={13} />
                    <span className="hidden xs:inline">{deps.armedLoot ? `LOOT ARMED (${deps.armedLoot.rolls})` : 'Roll Loot'}</span>
                    <span className="inline xs:hidden">{deps.armedLoot ? `ARMED (${deps.armedLoot.rolls})` : 'Loot'}</span>
                </button>
            ) : null;
        case 'oneShot':
            return deps.activeCampaignId ? <OneShotInjectorButton key="oneShot" /> : null;
        case 'absoluteCommand':
            return deps.activeCampaignId ? <AbsoluteCommandButton key="absoluteCommand" /> : null;
        case 'askGm':
            return (
                <button
                    key="askGm"
                    onClick={deps.onOpenOoc}
                    className="flex-shrink-0 flex items-center gap-1.5 bg-void border border-terminal/30 hover:border-terminal text-terminal text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-terminal/5 whitespace-nowrap"
                    title="Open Ask GM side chat"
                >
                    Ask GM
                </button>
            );
        case 'archive':
            return (
                <button
                    key="archive"
                    onClick={deps.onOpenArchive}
                    disabled={!deps.activeCampaignId}
                    className="flex-shrink-0 flex items-center gap-1.5 bg-void border border-ice/30 hover:border-ice text-ice text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-ice/5 disabled:opacity-30 disabled:cursor-not-allowed ml-auto whitespace-nowrap"
                >
                    <Scroll size={13} />
                    Archive
                </button>
            );
        default:
            return null;
    }
}