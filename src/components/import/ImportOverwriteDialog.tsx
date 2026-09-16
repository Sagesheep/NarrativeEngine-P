import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ImportOverwriteDialogProps {
    /** The character name that collided (display casing). */
    name: string;
    /**
     * `existing` — the card matches an NPC already in the campaign (WO-C §9.4).
     * `duplicate` — the same name appears twice in one multi-card drop.
     */
    kind: 'existing' | 'duplicate';
    onOverwrite: () => void;
    onCancel: () => void;
}

/**
 * WO-C §9.4 — presentational Overwrite / Cancel prompt for a name collision.
 *
 * Modeled on `npc-ledger/ImportChoiceDialog.tsx` (same absolute overlay, same
 * vocabulary) so it can sit inside either the NPC Ledger or the import wizard.
 * Pure: the caller owns the overwrite itself (`overwriteImportedNPC`).
 */
export function ImportOverwriteDialog({ name, kind, onOverwrite, onCancel }: ImportOverwriteDialogProps) {
    const isExisting = kind === 'existing';
    return (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-void/80 backdrop-blur-sm p-4" onClick={onCancel}>
            <div className="w-full max-w-md bg-surface border border-border rounded-lg shadow-2xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2 text-amber-400 font-bold uppercase tracking-widest text-sm">
                    <AlertTriangle size={16} /> {isExisting ? 'Existing character detected' : 'Duplicate card'}
                </div>
                <p className="text-xs text-text-dim leading-relaxed">
                    {isExisting ? (
                        <>
                            <span className="text-text-primary font-semibold">{name}</span> already exists in this campaign.
                            Overwrite their imported profile with this card? Campaign history and relationships will be preserved.
                        </>
                    ) : (
                        <>
                            <span className="text-text-primary font-semibold">{name}</span> appears more than once in this drop.
                            Use the later card in place of the earlier one, or skip it?
                        </>
                    )}
                </p>
                <div className="space-y-2">
                    <button onClick={onOverwrite} className="w-full text-left p-3 border border-border rounded hover:border-terminal hover:bg-terminal/5 transition-colors">
                        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-text-primary"><RefreshCw size={13} /> Overwrite</div>
                        <div className="text-[11px] text-text-dim mt-1">
                            {isExisting
                                ? 'Replaces the card-owned profile (description, personality, example dialogue, portrait). Keeps id, status, location, relationships, kit and history.'
                                : 'The later card wins. Its profile replaces the earlier one in this import.'}
                        </div>
                    </button>
                </div>
                <button onClick={onCancel} className="w-full py-1.5 text-[11px] uppercase tracking-wider text-text-dim hover:text-text-primary transition-colors">
                    {isExisting ? 'Cancel' : 'Skip this card'}
                </button>
            </div>
        </div>
    );
}
