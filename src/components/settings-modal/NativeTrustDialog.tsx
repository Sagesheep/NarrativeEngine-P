/**
 * Phase 6.1 — the native-tier trust confirmation dialog (`TRUST.md` §D).
 *
 * Shown when the user toggles a native-tier mod ON for the first time (or
 * again, only if the mod later adds a native entry point after having been
 * accepted as non-native — `nativeTrustStore.ts`). The dialog is BLOCKING:
 * the mod is not enabled until the user confirms, and a cancel reverts the
 * toggle to its prior state.
 *
 * The warning text is a REQUIRED security disclosure (`TRUST.md` §D): it is
 * pasted verbatim, not rewritten or paraphrased. The only substitution is
 * `{modName}` → the mod's display name, which the document itself specifies.
 *
 * The affirmative action is "Enable native mod"; the safe action is "Cancel".
 * These labels are also part of the required wording and are not localised
 * beyond the English source (translators may localise the labels; the warning
 * body stays verbatim English per §D's "must paste it without editing").
 */
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';

export interface NativeTrustDialogProps {
    /** The display name of the mod being enabled. Substituted into the warning text. */
    modName: string;
    /** Affirmative action: write `moduleEnabled[mod.<id>] = true` and fire the lifecycle. */
    onConfirm: () => void;
    /** Safe action: revert the toggle to its prior (off) state. */
    onCancel: () => void;
}

/**
 * The verbatim warning body from `TRUST.md` §D (lines 80–85). The only
 * substitution is `{modName}` → the mod's display name. This text MUST NOT be
 * edited — it is a required security disclosure, not prose.
 *
 * Kept as a module-level constant rather than a translation key so it cannot
 * drift across locales and a translator cannot accidentally weaken it. The
 * `{modName}` placeholder is replaced here, not through the i18n interpolator,
 * because the warning is not a translatable string.
 */
const NATIVE_TRUST_WARNING_BODY = (modName: string): string =>
    `This mod contains native code that will run inside Narrative Engine with the same access as the app. It can read and change your campaigns, settings, and data available to the app, including API keys currently available in the browser. Only enable it if you trust its author and source. Sandboxed-compute and declarative mods do not receive this access. Do you want to enable **${modName}**?`;

export function NativeTrustDialog({ modName, onConfirm, onCancel }: NativeTrustDialogProps) {
    const { t } = useTranslation();
    // Split the body at the bolded mod name so the name renders emphasized
    // without depending on a markdown renderer in the dialog. The warning
    // text wraps the mod name in **…** per §D; we render that as a bold span.
    const body = NATIVE_TRUST_WARNING_BODY(modName);
    const before = body.slice(0, body.indexOf('**'));
    const name = modName;
    const after = body.slice(body.lastIndexOf('**') + 2);

    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="native-trust-title"
            aria-describedby="native-trust-body"
        >
            {/* Backdrop — clicking it is the same as Cancel (safe action). */}
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
            <div className="relative bg-surface border border-danger/50 rounded-lg shadow-2xl max-w-lg w-full mx-4 p-5 space-y-4">
                <div className="flex items-center gap-2">
                    <AlertTriangle size={16} className="text-danger shrink-0" />
                    <h3
                        id="native-trust-title"
                        className="chrome-label text-danger text-sm font-bold uppercase tracking-wider"
                    >
                        {t('settings.extensions.nativeTrust.title')}
                    </h3>
                </div>
                <p id="native-trust-body" className="text-[11px] text-text-primary leading-relaxed">
                    {before}
                    <strong className="text-text-primary font-bold">{name}</strong>
                    {after}
                </p>
                <div className="flex justify-end gap-2 pt-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="text-[11px] uppercase tracking-widest bg-void border border-border text-text-primary px-4 py-2 rounded hover:bg-border/40"
                    >
                        {t('settings.extensions.nativeTrust.cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className="text-[11px] uppercase tracking-widest bg-danger/20 border border-danger text-danger px-4 py-2 rounded hover:bg-danger/30 font-bold"
                        autoFocus
                    >
                        {t('settings.extensions.nativeTrust.confirm')}
                    </button>
                </div>
            </div>
        </div>
    );
}