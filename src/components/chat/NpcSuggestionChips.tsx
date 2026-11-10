import { useState } from 'react';
import { UserPlus, X, Loader2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { acceptNpcSuggestion } from '../npc-ledger/acceptNpcSuggestion';

const MAX_VISIBLE = 4;

/**
 * Auto-detected NPC names, offered right above the composer so the player can
 * add them without opening the NPC Ledger. Same OFFER contract as the ledger's
 * Suggestions panel: nothing is added until the player clicks Add.
 */
export function NpcSuggestionChips() {
    const suggestions = useAppStore(s => s.npcSuggestions);
    const dismissNpcSuggestion = useAppStore(s => s.dismissNpcSuggestion);
    const toggleNPCLedger = useAppStore(s => s.toggleNPCLedger);
    const [adding, setAdding] = useState<string | null>(null);

    if (!suggestions || suggestions.length === 0) return null;

    const visible = suggestions.slice(0, MAX_VISIBLE);
    const hidden = suggestions.length - visible.length;

    const add = async (name: string) => {
        if (adding) return;
        setAdding(name);
        try {
            await acceptNpcSuggestion(name);
        } finally {
            setAdding(null);
        }
    };

    return (
        <div data-ui="npc-suggestions" className="mx-2 sm:mx-4 mb-1 flex flex-wrap gap-1">
            {visible.map(s => (
                <span
                    key={s.name}
                    title={s.context}
                    className="flex items-center gap-1.5 px-1.5 py-0.5 text-[9px] bg-void-lighter border border-ice/30 rounded text-text-dim"
                >
                    <UserPlus size={9} className="text-ice" />
                    {adding === s.name
                        ? <span className="text-ice">Adding {s.name}…</span>
                        : <span>New NPC <span className="text-text-primary">{s.name}</span>?</span>}
                    <button
                        type="button"
                        onClick={() => add(s.name)}
                        disabled={!!adding}
                        title="Add to the NPC ledger"
                        className="flex items-center gap-0.5 text-terminal hover:underline uppercase tracking-wider disabled:opacity-40"
                    >
                        {adding === s.name ? <Loader2 size={9} className="animate-spin" /> : 'Add'}
                    </button>
                    <button
                        type="button"
                        onClick={() => dismissNpcSuggestion(s.name)}
                        disabled={!!adding}
                        title="Dismiss"
                        className="hover:text-text-primary transition-colors disabled:opacity-40"
                    >
                        <X size={9} />
                    </button>
                </span>
            ))}
            {hidden > 0 && (
                <button
                    type="button"
                    onClick={toggleNPCLedger}
                    title="Review all suggestions in the NPC Ledger"
                    className="px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-ice border border-ice/30 rounded hover:bg-ice/10"
                >
                    +{hidden} more
                </button>
            )}
        </div>
    );
}
