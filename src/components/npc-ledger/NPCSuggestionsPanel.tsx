import { useState } from 'react';
import { UserPlus, X, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { addNpcFromSelection } from '../../services/npc/manualAdd';
import { toast } from '../Toast';
import type { NpcSuggestion } from '../../types';

type Props = {
    suggestions: NpcSuggestion[];
};

/**
 * Auto-detected names the player hasn't promoted yet. One-tap accept (runs the
 * same add/update pass as the toolbar button) or one-tap delete (no confirm),
 * plus bulk accept/delete of the selected subset or all.
 *
 * WO-11.3 — desktop port of mobile's NPCSuggestionsPanel. Detection already
 * runs server-side (postTurnPipeline feeds `addNpcSuggestions`); this is the
 * surface only.
 */
export function NPCSuggestionsPanel({ suggestions }: Props) {
    const dismissNpcSuggestion = useAppStore(s => s.dismissNpcSuggestion);
    const clearNpcSuggestions = useAppStore(s => s.clearNpcSuggestions);

    const [expanded, setExpanded] = useState(true);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [activeName, setActiveName] = useState<string | null>(null);

    if (suggestions.length === 0) return null;

    const toggle = (name: string) => setChecked(prev => {
        const n = new Set(prev);
        if (n.has(name)) n.delete(name); else n.add(name);
        return n;
    });

    const acceptOne = async (name: string): Promise<boolean> => {
        const state = useAppStore.getState();
        if (!state.activeCampaignId) {
            toast.warning('No active campaign.');
            return false;
        }
        const result = await addNpcFromSelection({
            rawText: name,
            ledger: state.npcLedger ?? [],
            messages: state.messages,
            campaignId: state.activeCampaignId,
            storyProvider: state.getActiveStoryEndpoint() ?? state.getActiveUtilityEndpoint(),
            updateProvider: state.getActiveUtilityEndpoint() ?? state.getActiveStoryEndpoint(),
            addNPC: state.addNPC,
            updateNPC: state.updateNPC,
        });
        if (result.ok) {
            dismissNpcSuggestion(name);
            toast.success(result.message);
            return true;
        }
        if (result.kind === 'ambiguous') toast.warning(result.message);
        else toast.error(result.message);
        return false;
    };

    const acceptMany = async (names: string[]) => {
        if (busy || names.length === 0) return;
        setBusy(true);
        for (const name of names) {
            setActiveName(name);
            await acceptOne(name);
        }
        setActiveName(null);
        setBusy(false);
        setChecked(new Set());
    };

    const dismissMany = (names: string[]) => {
        names.forEach(dismissNpcSuggestion);
        setChecked(new Set());
    };

    const selected = suggestions.filter(s => checked.has(s.name)).map(s => s.name);

    return (
        <div className="border border-ice/30 rounded bg-ice/5 overflow-hidden">
            <button
                onClick={() => setExpanded(v => !v)}
                className="w-full flex items-center gap-2 px-2.5 py-2 text-[10px] uppercase tracking-wider text-ice"
            >
                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Suggestions ({suggestions.length})
                {busy && <Loader2 size={11} className="animate-spin ml-auto" />}
            </button>

            {expanded && (
                <div className="px-2 pb-2 space-y-1.5">
                    <div className="max-h-44 overflow-y-auto space-y-1">
                        {suggestions.map(s => (
                            <div
                                key={s.name}
                                className={`flex items-center gap-1.5 px-1.5 py-1 rounded ${checked.has(s.name) ? 'bg-ice/10' : ''}`}
                            >
                                <input
                                    type="checkbox"
                                    checked={checked.has(s.name)}
                                    onChange={() => toggle(s.name)}
                                    disabled={busy}
                                    className="accent-ice shrink-0"
                                />
                                <span className="flex-1 text-xs text-text-primary truncate">
                                    {activeName === s.name ? <span className="text-ice">Adding {s.name}…</span> : s.name}
                                </span>
                                <button
                                    onClick={() => acceptMany([s.name])}
                                    disabled={busy}
                                    title="Add to ledger"
                                    className="p-1 text-text-dim hover:text-terminal disabled:opacity-40"
                                >
                                    <UserPlus size={13} />
                                </button>
                                <button
                                    onClick={() => dismissNpcSuggestion(s.name)}
                                    disabled={busy}
                                    title="Dismiss"
                                    className="p-1 text-text-dim hover:text-red-400 disabled:opacity-40"
                                >
                                    <X size={13} />
                                </button>
                            </div>
                        ))}
                    </div>

                    <div className="flex gap-1.5 h-8">
                        <button
                            onClick={() => acceptMany(selected)}
                            disabled={busy || selected.length === 0}
                            className="flex-1 border border-terminal/30 rounded text-[10px] uppercase tracking-wider text-terminal disabled:opacity-30"
                        >
                            Accept ({selected.length})
                        </button>
                        <button
                            onClick={() => dismissMany(selected)}
                            disabled={busy || selected.length === 0}
                            className="flex-1 border border-red-500/30 rounded text-[10px] uppercase tracking-wider text-red-500 disabled:opacity-30"
                        >
                            Delete ({selected.length})
                        </button>
                    </div>
                    <div className="flex gap-1.5 h-8">
                        <button
                            onClick={() => acceptMany(suggestions.map(s => s.name))}
                            disabled={busy}
                            className="flex-1 border border-terminal/30 rounded text-[10px] uppercase tracking-wider text-terminal disabled:opacity-30"
                        >
                            Accept All
                        </button>
                        <button
                            onClick={() => { clearNpcSuggestions(); setChecked(new Set()); }}
                            disabled={busy}
                            className="flex-1 border border-red-500/30 rounded text-[10px] uppercase tracking-wider text-red-500 disabled:opacity-30"
                        >
                            Delete All
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}