/**
 * Phase 6.4 — the two blocking confirmations from `DATA_POLICY.md` §5.
 *
 * Same shape as `NativeTrustDialog` (`TRUST.md` §D): state the consequence,
 * do not scold, the safe action is Cancel and it is what the backdrop and the
 * Escape-equivalent (clicking away) do. The affirmative action is the one that
 * carries the verb — "Disable anyway", "Delete permanently" — so a user who
 * reads only the buttons still knows which one is the irreversible one.
 *
 * Two variants, one component, because they differ only in copy and in which
 * button is styled as destructive:
 *
 *   • `disable` — nothing is destroyed. The warning is about OUTPUT QUALITY:
 *     the story keeps referring to what the mod tracked. This is the case
 *     `DATA_POLICY.md` §6 refuses to engineer around; the disclosure is the
 *     whole mitigation, so the wording is load-bearing.
 *   • `delete` — data is destroyed, with no undo and no export. Styled
 *     danger, and it says plainly what survives (the story text) and what
 *     does not (everything the mod tracked).
 *
 * The copy is PM-approved and is not to be softened. It may be translated;
 * unlike the native-tier warning it is product copy, not a security
 * disclosure, so it lives in the locale files rather than in a constant here.
 */
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';

export type ModDataDialogVariant = 'disable' | 'delete';

export interface ModDataDialogProps {
    variant: ModDataDialogVariant;
    /** The display name of the mod, substituted into the warning body. */
    modName: string;
    /** Affirmative action: perform the disable, or the clean. */
    onConfirm: () => void;
    /** Safe action: change nothing. */
    onCancel: () => void;
}

export function ModDataDialog({ variant, modName, onConfirm, onCancel }: ModDataDialogProps) {
    const { t } = useTranslation();
    const isDelete = variant === 'delete';
    const titleId = `mod-data-${variant}-title`;
    const bodyId = `mod-data-${variant}-body`;

    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
        >
            {/* Backdrop — clicking it is Cancel, the safe action. */}
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
            <div
                className={`relative bg-surface border rounded-lg shadow-2xl max-w-lg w-full mx-4 p-5 space-y-4 ${
                    isDelete ? 'border-danger/50' : 'border-ember/50'
                }`}
            >
                <div className="flex items-center gap-2">
                    <AlertTriangle size={16} className={`shrink-0 ${isDelete ? 'text-danger' : 'text-ember'}`} />
                    <h3
                        id={titleId}
                        className={`chrome-label text-sm font-bold uppercase tracking-wider ${
                            isDelete ? 'text-danger' : 'text-ember'
                        }`}
                    >
                        {t(`settings.extensions.modData.${variant}.title`)}
                    </h3>
                </div>
                <p id={bodyId} className="text-[11px] text-text-primary leading-relaxed">
                    {t(`settings.extensions.modData.${variant}.body`, { modName })}
                </p>
                <div className="flex justify-end gap-2 pt-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="text-[11px] uppercase tracking-widest bg-void border border-border text-text-primary px-4 py-2 rounded hover:bg-border/40"
                        autoFocus
                    >
                        {t('settings.extensions.modData.cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className={`text-[11px] uppercase tracking-widest px-4 py-2 rounded font-bold ${
                            isDelete
                                ? 'bg-danger/20 border border-danger text-danger hover:bg-danger/30'
                                : 'bg-ember/20 border border-ember text-ember hover:bg-ember/30'
                        }`}
                    >
                        {t(`settings.extensions.modData.${variant}.confirm`)}
                    </button>
                </div>
            </div>
        </div>
    );
}
