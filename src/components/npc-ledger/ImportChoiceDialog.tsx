import { Upload, Users, Trash2, Sparkles } from 'lucide-react';
import type { NpcImportMode } from '../../services/npc/importTransform';

interface ImportChoiceDialogProps {
    /** Number of records parsed from the import file. */
    count: number;
    /** Noun for the records being imported, e.g. "NPC" or "character". Pluralized with a trailing "s". */
    label: string;
    onChoose: (mode: NpcImportMode) => void;
    onCancel: () => void;
}

/**
 * Presentational choice dialog for cross-campaign import (Full / Strip / Isekai).
 * Shared between the NPC Ledger and the Character Ledger — the underlying
 * transform (`prepareImportedNpcs`) is identical since `PlayerCharacter` is an
 * `NPCEntry` (see `src/types/gamecontext.ts`).
 */
export function ImportChoiceDialog({ count, label, onChoose, onCancel }: ImportChoiceDialogProps) {
    return (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-void/80 backdrop-blur-sm p-4" onClick={onCancel}>
            <div className="w-full max-w-md bg-surface border border-border rounded-lg shadow-2xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2 text-terminal font-bold uppercase tracking-widest text-sm">
                    <Upload size={16} /> Import {count} {label}{count > 1 ? 's' : ''}
                </div>
                <p className="text-xs text-text-dim leading-relaxed">
                    These records carry story details from their origin campaign (plot hooks, immediate goals,
                    factions, relationships). Choose how to bring them across:
                </p>
                <div className="space-y-2">
                    <button onClick={() => onChoose('full')} className="w-full text-left p-3 border border-border rounded hover:border-terminal hover:bg-terminal/5 transition-colors">
                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-text-primary"><Users size={13} /> Full import</div>
                        <div className="text-[11px] text-text-dim mt-1">Keep everything verbatim. Origin-campaign details may surface in the story.</div>
                    </button>
                    <button onClick={() => onChoose('strip')} className="w-full text-left p-3 border border-border rounded hover:border-terminal hover:bg-terminal/5 transition-colors">
                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-text-primary"><Trash2 size={13} /> Strip plot</div>
                        <div className="text-[11px] text-text-dim mt-1">Clean local record: keeps appearance, voice, personality, skills &amp; ambitions; drops plot hooks, immediate goals, factions, region &amp; relationships.</div>
                    </button>
                    <button onClick={() => onChoose('isekai')} className="w-full text-left p-3 border border-amber-500/40 rounded hover:border-amber-400 hover:bg-amber-500/10 transition-colors">
                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-400"><Sparkles size={13} /> Isekai</div>
                        <div className="text-[11px] text-text-dim mt-1">Full import + transmigration framing: the GM treats their old memories as past-life recollections from another world.</div>
                    </button>
                </div>
                <button onClick={onCancel} className="w-full py-1.5 text-[11px] uppercase tracking-wider text-text-dim hover:text-text-primary transition-colors">
                    Cancel
                </button>
            </div>
        </div>
    );
}
