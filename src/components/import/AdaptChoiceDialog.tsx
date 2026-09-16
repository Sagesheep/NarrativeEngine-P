import { Sparkles, WifiOff } from 'lucide-react';
import type { AdaptationEndpointInfo } from '../../services/import/adaptationTypes';

export type AdaptChoice = 'living-world' | 'direct';

interface AdaptChoiceDialogProps {
    /** How many NEW characters this drop added — overwritten rows are never offered (§9.4). */
    count: number;
    /** What the Living-world option will actually call, or `null` when nothing is configured. */
    endpoint: AdaptationEndpointInfo | null;
    onChoose: (choice: AdaptChoice) => void;
    onCancel: () => void;
}

/** The same sentence the wizard shows on a dead endpoint — one phrasing, two surfaces. */
const NO_ENDPOINT_COPY = 'no utility or story endpoint is configured';

/**
 * WO-C §9.3 (order "C2") — the Living-world / Direct choice, for the NPC-Ledger
 * quick-add.
 *
 * The wizard asks this question on its Review step, *before* anything is
 * written. The ledger cannot: quick-add has no review step, the NPCs are in the
 * store the moment the file is read, and §9.3 wants the import persisted first
 * anyway. So the question arrives after the fact — "these landed, do you want a
 * model to give them motivations?" — and declining is free, because the
 * mechanical pool wants are already on every row.
 *
 * Presentational only, modeled on `ImportOverwriteDialog` (same absolute
 * overlay, same vocabulary) so it sits inside the ledger's relative shell. It
 * owns no model call and no consent default: §9.3 forbids a pre-checked
 * control, so there is nothing selected here to begin with — only two buttons.
 */
export function AdaptChoiceDialog({ count, endpoint, onChoose, onCancel }: AdaptChoiceDialogProps) {
    const noun = count === 1 ? 'character' : 'characters';
    return (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-void/80 backdrop-blur-sm p-4" onClick={onCancel}>
            <div className="w-full max-w-md bg-surface border border-border rounded-lg shadow-2xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2 text-terminal font-bold uppercase tracking-widest text-sm">
                    <Sparkles size={16} /> Adapt {count} imported {noun}?
                </div>
                <p className="text-xs text-text-dim leading-relaxed">
                    {count === 1 ? 'The character is' : 'They are'} already in the ledger on mechanical pool
                    motivations. A model can replace those with motivations drawn from the card itself — the
                    card is canonical, no web search, nothing outside it.
                </p>
                <div className="space-y-2">
                    <button
                        type="button"
                        disabled={!endpoint}
                        onClick={() => onChoose('living-world')}
                        className="w-full text-left p-3 border border-border rounded hover:border-terminal hover:bg-terminal/5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-border disabled:hover:bg-transparent"
                    >
                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-text-primary">
                            <Sparkles size={13} /> Living-world adaptation
                            <span className="text-terminal normal-case tracking-normal font-normal">— Recommended</span>
                        </div>
                        <div className="text-[11px] text-text-dim mt-1">
                            {endpoint
                                ? `Uses ${endpoint.label} (${endpoint.modelName}) to infer provisional motivations from `
                                  + 'bounded card text. Nothing else is touched, and stopping it keeps the import.'
                                : NO_ENDPOINT_COPY}
                        </div>
                    </button>
                    <button
                        type="button"
                        onClick={() => onChoose('direct')}
                        className="w-full text-left p-3 border border-border rounded hover:border-terminal hover:bg-terminal/5 transition-colors"
                    >
                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-text-primary">
                            <WifiOff size={13} /> Direct import
                            <span className="text-text-dim normal-case tracking-normal font-normal">— Offline</span>
                        </div>
                        <div className="text-[11px] text-text-dim mt-1">
                            No model call. Generic pool motivations now; the story fills them in over play.
                        </div>
                    </button>
                </div>
                <button
                    type="button"
                    onClick={onCancel}
                    className="w-full py-1.5 text-[11px] uppercase tracking-wider text-text-dim hover:text-text-primary transition-colors"
                >
                    Not now
                </button>
            </div>
        </div>
    );
}
