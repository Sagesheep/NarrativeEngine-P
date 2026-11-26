import { useAppStore } from '../../store/useAppStore';
import { LOCALES, LOCALE_ORDER, DEFAULT_LOCALE, countUntranslated, isLocaleCode, type LocaleCode } from '../../i18n';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Interface-language picker.
 *
 * Deliberately its own component rather than inline in GlobalSettingsTab: that
 * file is 562 lines of un-extracted English and belongs to Phase 2. Keeping the
 * language UI separate means every Phase 1 file is 100% extracted, so Phase 2
 * has clean examples to copy instead of a half-converted file.
 *
 * This selects the UI language ONLY. Narration language (what the story AI
 * writes in) is a separate, per-campaign setting — Phase 3.
 */
export function LanguageSection() {
    const settings = useAppStore((s) => s.settings);
    const updateSettings = useAppStore((s) => s.updateSettings);
    const { t } = useTranslation();

    const active: LocaleCode = isLocaleCode(settings?.locale) ? settings.locale : DEFAULT_LOCALE;
    const untranslated = countUntranslated(active);

    return (
        <div className="bg-void p-3 border border-border rounded space-y-2">
            <div>
                <label
                    htmlFor="ui-language"
                    className="chrome-label block text-[11px] text-text-primary uppercase tracking-wider font-bold mb-1"
                >
                    {t('settings.language.label')}
                </label>
                <p className="text-[9px] text-text-dim leading-tight">
                    {t('settings.language.help')}
                </p>
            </div>

            <select
                id="ui-language"
                value={active}
                onChange={(e) => updateSettings({ locale: e.target.value as LocaleCode })}
                className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary font-mono focus:border-terminal focus:outline-none"
            >
                {LOCALE_ORDER.map((code) => (
                    <option key={code} value={code}>
                        {LOCALES[code].label}
                    </option>
                ))}
            </select>

            {active === 'pseudo' && (
                <p className="text-[9px] text-danger leading-tight">
                    {t('settings.language.pseudoWarning')}
                </p>
            )}

            {active !== 'en' && active !== 'pseudo' && (
                <p className="text-[9px] text-text-dim leading-tight font-mono">
                    {untranslated === 0
                        ? t('settings.language.complete')
                        : t('settings.language.untranslated', { count: untranslated })}
                </p>
            )}

            <p className="text-[9px] text-text-dim leading-tight">
                {t('settings.language.contribute')}
            </p>
        </div>
    );
}
