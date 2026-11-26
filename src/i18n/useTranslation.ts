import { useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import {
    DEFAULT_LOCALE,
    getStyleProfile,
    isLocaleCode,
    translateIn,
    chromeTextStyle,
    type LocaleCode,
    type StyleProfile,
    type TranslateKey,
    type TranslateVars,
} from './index';

/**
 * React binding for i18n.
 *
 * Subscribes to `settings.locale`, so every component using `t` re-renders when
 * the language changes — no page reload, no context provider.
 *
 * ```tsx
 * const { t } = useTranslation();
 * <button title={t('header.settings.tooltip')}>{t('header.settings.label')}</button>
 * ```
 */
export function useTranslation(): {
    t: (key: TranslateKey, vars?: TranslateVars) => string;
    locale: LocaleCode;
    styleProfile: StyleProfile;
    /** Chrome text style corrected for this locale — for INLINE-styled elements only. */
    chromeText: typeof chromeTextStyle;
} {
    const raw = useAppStore((s) => s.settings?.locale);
    const locale = isLocaleCode(raw) ? raw : DEFAULT_LOCALE;

    const t = useCallback(
        (key: TranslateKey, vars?: TranslateVars) => translateIn(locale, key, vars),
        [locale],
    );

    const chromeText = useCallback(
        (base?: { textTransform?: 'uppercase' | 'none'; letterSpacing?: string }) =>
            chromeTextStyle(base, locale),
        [locale],
    );

    return { t, locale, styleProfile: getStyleProfile(locale), chromeText };
}
