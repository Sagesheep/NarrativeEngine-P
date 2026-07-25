import { AlertTriangle, Save, Trash2 } from 'lucide-react';

interface UnsavedChangesDialogProps {
    onSave: () => void;
    onDiscard: () => void;
    onCancel: () => void;
}

/**
 * Presentational guard dialog shown when the user attempts to close the
 * Character Ledger while the Sheet tab has un-saved edits. Mirrors the
 * `ImportChoiceDialog` overlay style (absolute inset-0 inside the modal's
 * stopPropagation container). Three actions:
 *  - Save    → commit edits via the Sheet tab's save handler, then close.
 *  - Discard → drop edits via the Sheet tab's discard handler, then close.
 *  - Cancel  → dismiss this dialog and return to editing.
 */
export function UnsavedChangesDialog({ onSave, onDiscard, onCancel }: UnsavedChangesDialogProps) {
    return (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-void/80 backdrop-blur-sm p-4" onClick={onCancel}>
            <div className="w-full max-w-md bg-surface border border-border rounded-lg shadow-2xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2 text-terminal font-bold uppercase tracking-widest text-sm">
                    <AlertTriangle size={16} /> Unsaved Changes
                </div>
                <p className="text-xs text-text-dim leading-relaxed">
                    You have unsaved edits to your character sheet. Save them before closing, or discard them.
                </p>
                <div className="space-y-2">
                    <button onClick={onSave} className="w-full flex items-center gap-2 p-3 border border-terminal rounded hover:bg-terminal/5 transition-colors text-left">
                        <Save size={14} className="text-terminal shrink-0" />
                        <span className="text-xs font-bold uppercase tracking-wider text-text-primary">Save Changes</span>
                        <span className="text-[11px] text-text-dim ml-auto">Commit edits, then close</span>
                    </button>
                    <button onClick={onDiscard} className="w-full flex items-center gap-2 p-3 border border-danger/40 rounded hover:bg-danger/5 transition-colors text-left">
                        <Trash2 size={14} className="text-danger shrink-0" />
                        <span className="text-xs font-bold uppercase tracking-wider text-text-primary">Discard Changes</span>
                        <span className="text-[11px] text-text-dim ml-auto">Lose edits, then close</span>
                    </button>
                </div>
                <button onClick={onCancel} className="w-full py-1.5 text-[11px] uppercase tracking-wider text-text-dim hover:text-text-primary transition-colors">
                    Cancel (keep editing)
                </button>
            </div>
        </div>
    );
}