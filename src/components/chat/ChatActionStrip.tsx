import { Save, Loader2, Zap, Scroll, Search, Package, Dices } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { toast } from '../Toast';
// PARKED (Full Modularity 2.9.3) — `ArcInjectorButton` is hidden while the Arc
// Engine is parked. The component and `arcSpawn.ts` are untouched; only the
// mount is removed. See the note in this file below and `API.md` §8.6 item 2.
// import { ArcInjectorButton } from '../ArcInjectorButton';
import { OneShotInjectorButton } from '../OneShotInjectorButton';
import { AbsoluteCommandButton } from '../AbsoluteCommandButton';

/**
 * The horizontal button strip above the composer: Save, Trim, Deep Search,
 * Dice Me, Roll Loot, One-Shot injector, Absolute Command, Ask GM, Archive.
 * Extracted from ChatArea; arming state lives in the store.
 *
 * The Arc injector is parked and unmounted — see the block comment at its old
 * position below.
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

    return (
        <div className="px-2 md:px-4 pb-1 flex gap-2 overflow-x-auto no-scrollbar">
            <button
                onClick={onForceSave}
                disabled={isSaving}
                className="flex-shrink-0 flex items-center gap-1.5 bg-void border border-emerald-500/30 hover:border-emerald-500 text-emerald-500 text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-emerald-500/5 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
            >
                {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                <span className="hidden xs:inline">{isSaving ? 'SAVING...' : 'SAVE CAMPAIGN'}</span>
                {!isSaving && <span className="inline xs:hidden">SAVE</span>}
            </button>
            <button
                onClick={onTrim}
                disabled={isStreaming || messagesCount < 6}
                className="flex-shrink-0 flex items-center gap-1.5 bg-void border border-terminal/30 hover:border-terminal text-terminal text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-terminal/5 disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap"
                title="Trim history"
            >
                <Zap size={13} />
                Trim
            </button>
            {settings.deepContextSearch && (
                <button
                    onClick={() => setDeepArmed(!deepArmed)}
                    disabled={isStreaming || !activeCampaignId}
                    className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap ${deepArmed ? 'border-amber-500 text-amber-500 bg-amber-500/10 hover:bg-amber-500/20' : 'border-amber-500/30 hover:border-amber-500 text-amber-500 hover:bg-amber-500/5'}`}
                    title={deepArmed ? 'Deep Search armed — type to send normally, or Esc to disarm' : 'Arm Deep Archive Search (sends on next Enter)'}
                >
                    <Search size={13} />
                    <span className="hidden xs:inline">{deepArmed ? 'DEEP SEARCH ARMED' : 'Deep Search'}</span>
                    <span className="inline xs:hidden">{deepArmed ? 'ARMED' : 'Deep'}</span>
                </button>
            )}

            {/* Dice Me — opens 3-gate roll configurator modal */}
            <button
                onClick={() => {
                    if (armedRoll) {
                        setArmedRoll(null);
                    } else {
                        openDiceRollModal();
                    }
                }}
                disabled={isStreaming || !activeCampaignId}
                className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all disabled:opacity-30 disabled:cursor-not-allowed whitespace-nowrap ${
                    armedRoll
                        ? 'border-amber-500 text-amber-500 bg-amber-500/10 hover:bg-amber-500/20 animate-pulse'
                        : 'border-terminal/30 text-terminal hover:bg-terminal/5'
                }`}
                title={armedRoll ? 'Dice armed — click to disarm, or send to roll' : 'Open dice roll configurator'}
            >
                <Dices size={13} />
                <span className="hidden xs:inline">{armedRoll ? 'DICE ARMED' : 'Dice Me'}</span>
                <span className="inline xs:hidden">{armedRoll ? 'ARMED' : 'Dice'}</span>
            </button>

            {/* Loot Engine WO-05: manual loot drop trigger. Mirrors the dice button. */}
            {context?.lootTree && (
                <button
                    onClick={() => {
                        if (!context?.lootTree) {
                            toast.warning('No loot table for this world');
                                return;
                        }
                        openLootRollModal();
                    }}
                    className={`flex-shrink-0 flex items-center gap-1.5 bg-void border text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all whitespace-nowrap ${
                        armedLoot
                            ? 'border-amber-500 text-amber-500 bg-amber-500/10 hover:bg-amber-500/20 animate-pulse'
                            : 'border-terminal/30 text-terminal/60 hover:text-terminal hover:bg-terminal/5'
                    }`}
                    title={
                        armedLoot
                            ? `Loot armed (${armedLoot.rolls}) — send to drop`
                            : 'Roll loot — arm a drop, send to resolve'
                    }
                >
                    <Package size={13} />
                    <span className="hidden xs:inline">{armedLoot ? `LOOT ARMED (${armedLoot.rolls})` : 'Roll Loot'}</span>
                    <span className="inline xs:hidden">{armedLoot ? `ARMED (${armedLoot.rolls})` : 'Loot'}</span>
                </button>
            )}

            {/*
              * PARKED — "Inject Arc" button hidden (Full Modularity, Phase 2.9.3).
              *
              * The Arc Engine's post-turn tick is broken at HEAD: 2.3 migrated
              * `mods/arc/compute.js` to the `getContext()` v1 surface while the
              * sandbox binding still hands mods the raw `HostFacade` shape, so the
              * tick throws on its first statement every turn (`API.md` §11.3).
              * Offering a "spawn an arc" button for an engine that cannot then
              * advance the arc it spawned is worse than offering nothing — it costs
              * an LLM call (`arcSpawn.ts`) and produces a thread that never moves.
              *
              * Nothing is deleted. `ArcInjectorButton.tsx`, `arcSpawn.ts`,
              * `openThreads.ts` and `mods/arc/` all remain; only this mount is gone,
              * so restoring it is uncommenting two lines.
              *
              * Reintroduction is Phase 4.2 (header button registry) — the button
              * comes back as a mount point the arc mod claims for itself, which is
              * where `mods/arc/compute.js:14-20` always said it belonged.
              */}
            {activeCampaignId && (
                <OneShotInjectorButton />
            )}
            {activeCampaignId && (
                <AbsoluteCommandButton />
            )}
            <button
                onClick={onOpenOoc}
                className="flex-shrink-0 flex items-center gap-1.5 bg-void border border-terminal/30 hover:border-terminal text-terminal text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-terminal/5 whitespace-nowrap"
                title="Open Ask GM side chat"
            >
                Ask GM
            </button>
            <button
                onClick={onOpenArchive}
                disabled={!activeCampaignId}
                className="flex-shrink-0 flex items-center gap-1.5 bg-void border border-ice/30 hover:border-ice text-ice text-[10px] sm:text-[11px] uppercase tracking-wider px-3 h-[32px] rounded-sm transition-all hover:bg-ice/5 disabled:opacity-30 disabled:cursor-not-allowed ml-auto whitespace-nowrap"
            >
                <Scroll size={13} />
                Archive
            </button>
        </div>
    );
}
