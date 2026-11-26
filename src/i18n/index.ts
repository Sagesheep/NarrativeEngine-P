/**
 * i18n core — deliberately dependency-free.
 *
 * This module must NOT import the Zustand store: `settingsHelpers.ts` calls
 * `applyLocale()` and the store imports `settingsHelpers`, so a store import
 * here would close a cycle. The React binding lives in `./useTranslation.ts`,
 * which may import the store freely.
 *
 * MASTERPLAN Locked Decisions 1 (no i18n dependency), 2 (typed keys),
 * 3 (English fallback), 6 (interpolation), 7 (plurals).
 */
import { en, type TranslationKey } from './locales/en';
import { ko } from './locales/ko';
import { ru } from './locales/ru';
import { pl } from './locales/pl';
import { id } from './locales/id';
import { pseudo } from './locales/pseudo';
import type { LocaleCode, LocalePack, StyleProfile } from './types';

export type { LocaleCode, LocalePack, StyleProfile, TranslationKey };
export { en };

// ── Registry ─────────────────────────────────────────────────────────────

/**
 * Adding a language is a data-only change: write the file, add it here. No
 * component, hook, or CSS change is required for the strings to take effect.
 */
export const LOCALES: Record<LocaleCode, LocalePack> = {
    en: { code: 'en', label: 'English', strings: en },
    ko,
    ru,
    pl,
    id,
    pseudo,
};

/** Order shown in the language dropdown. `pseudo` is last — it is a test tool. */
export const LOCALE_ORDER: LocaleCode[] = ['en', 'ko', 'ru', 'pl', 'id', 'pseudo'];

export const DEFAULT_LOCALE: LocaleCode = 'en';

const modTranslations = new Map<string, Record<string, Record<string, string>>>();

export function registerModTranslations(
    mods: readonly { readonly id: string; readonly i18nStrings?: Record<string, Record<string, string>> }[],
): void {
    modTranslations.clear();
    for (const mod of mods) modTranslations.set(mod.id, mod.i18nStrings ?? {});
}

export function isLocaleCode(value: unknown): value is LocaleCode {
    return typeof value === 'string' && value in LOCALES;
}

// ── Plural keys ──────────────────────────────────────────────────────────

/**
 * A plural base key is any key that has a `.other` variant in `en`. Writing
 * `'items.count.one'` and `'items.count.other'` in en.ts makes
 * `t('items.count', { count })` type-check automatically.
 */
type StripOther<K extends string> = K extends `${infer Base}.other` ? Base : never;
export type PluralKey = StripOther<TranslationKey>;

export type TranslateKey = TranslationKey | PluralKey;

export type TranslateVars = Record<string, string | number> & { count?: number };

// ── Current locale (module state, for non-React callers) ─────────────────

let currentLocale: LocaleCode = DEFAULT_LOCALE;

export function getLocale(): LocaleCode {
    return currentLocale;
}

// ── Lookup ───────────────────────────────────────────────────────────────

function interpolate(template: string, vars?: TranslateVars): string {
    if (!vars) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
        const value = vars[name];
        return value === undefined ? match : String(value);
    });
}

/**
 * Resolve a raw string for `key` in `locale`, falling back to English and then
 * to the key itself. The key-as-last-resort is intentional: a missing key
 * renders something visible and greppable rather than an empty control.
 */
function lookup(locale: LocaleCode, key: string): string {
    const modMatch = /^mod\.([a-zA-Z0-9_-]+)\.(.+)$/.exec(key);
    if (modMatch) {
        const [, modId, modKey] = modMatch;
        const maps = modTranslations.get(modId);
        const translated = maps?.[locale]?.[modKey] ?? maps?.en?.[modKey];
        if (typeof translated === 'string' && translated.length > 0) return translated;
        return key;
    }
    const pack = LOCALES[locale];
    const translated = pack?.strings[key as TranslationKey];
    if (typeof translated === 'string' && translated.length > 0) return translated;

    const fallback = en[key as TranslationKey];
    if (typeof fallback === 'string') return fallback;

    return key;
}

/**
 * Pick the CLDR plural form for `count` in `locale` and resolve the matching
 * key variant. English needs one/other; Russian needs one/few/many/other.
 * `Intl.PluralRules` is built into the platform — no plural tables to maintain.
 */
function lookupPlural(locale: LocaleCode, key: string, count: number): string {
    // `pseudo` is not a real BCP-47 tag; plural-select against English for it.
    const tag = locale === 'pseudo' ? 'en' : locale;

    let category = 'other';
    try {
        category = new Intl.PluralRules(tag).select(count);
    } catch {
        // Unknown tag — 'other' is always defined, so this stays correct.
    }

    const exact = `${key}.${category}`;
    const other = `${key}.other`;
    const pack = LOCALES[locale];

    const has = (strings: Partial<Record<TranslationKey, string>>, k: string) => {
        const v = strings[k as TranslationKey];
        return typeof v === 'string' && v.length > 0;
    };

    // Precedence matters: exhaust the LOCALE's own forms before falling back to
    // English. A translator who filled only `.other` (the common first pass)
    // must get their own text for every count — not English for the counts they
    // have not reached yet. Getting this backwards silently leaks English into
    // an otherwise-translated sentence.
    if (pack && has(pack.strings, exact)) return lookup(locale, exact);
    if (pack && has(pack.strings, other)) return lookup(locale, other);

    if (has(en, exact)) return lookup('en', exact);
    if (has(en, other)) return lookup('en', other);

    return lookup(locale, key);
}

/** Translate `key` in an explicit locale. Used by the React hook. */
export function translateIn(locale: LocaleCode, key: TranslateKey, vars?: TranslateVars): string {
    const raw = vars?.count !== undefined
        ? lookupPlural(locale, key, vars.count)
        : lookup(locale, key);
    return interpolate(raw, vars);
}

/**
 * Translate using the currently-applied locale.
 *
 * For non-React callers (services, toasts, store code). React components should
 * use `useTranslation()` so they re-render when the language changes.
 */
(globalThis as { __narrativeTranslate?: typeof translateIn }).__narrativeTranslate = translateIn;

export function t(key: TranslateKey, vars?: TranslateVars): string {
    return translateIn(currentLocale, key, vars);
}

// ── Applying a locale to the document ────────────────────────────────────

/**
 * Style corrections for the active locale.
 *
 * Components that set `textTransform` / `letterSpacing` as INLINE styles cannot
 * be corrected by CSS at any specificity, so they read the profile from here
 * instead. Components using CSS classes need nothing — `src/index.css` reacts
 * to the data-attributes stamped by `applyLocale`.
 */
export function getStyleProfile(locale: LocaleCode = currentLocale): StyleProfile {
    return LOCALES[locale]?.styleProfile ?? {};
}

/**
 * Chrome text style for INLINE-styled elements, corrected for the active locale.
 * Pass the English-authored values; get back what this language should use.
 */
export function chromeTextStyle(
    base: { textTransform?: 'uppercase' | 'none'; letterSpacing?: string } = {},
    locale: LocaleCode = currentLocale,
): { textTransform?: 'uppercase' | 'none'; letterSpacing?: string } {
    const profile = getStyleProfile(locale);
    return {
        textTransform: profile.caps === 'flat' ? 'none' : base.textTransform,
        letterSpacing: profile.tracking === 'tight' ? 'normal' : base.letterSpacing,
    };
}

/**
 * Set the active locale and project it onto the document root, mirroring
 * `applyTheme` / `applyUIScale` in settingsHelpers.ts.
 *
 * `data-lang` and the profile attributes are what `src/index.css` keys off, so
 * every per-language visual fix lands in one CSS block instead of in components.
 */
export function applyLocale(locale: LocaleCode): void {
    currentLocale = isLocaleCode(locale) ? locale : DEFAULT_LOCALE;
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('narrative:locale-changed'));

    if (typeof document === 'undefined') return;
    const html = document.documentElement;
    const profile = getStyleProfile(currentLocale);

    html.setAttribute('data-lang', currentLocale);
    html.setAttribute('data-lang-caps', profile.caps ?? 'as-authored');
    html.setAttribute('data-lang-tracking', profile.tracking ?? 'as-authored');

    // `lang` is not decoration: it drives font fallback, hyphenation, and how
    // screen readers pronounce the page.
    html.setAttribute('lang', currentLocale === 'pseudo' ? 'en' : currentLocale);

    if (profile.fontStack) {
        html.style.setProperty('--lang-font-stack', profile.fontStack);
    } else {
        html.style.removeProperty('--lang-font-stack');
    }
}

/**
 * How many keys a locale has not translated yet.
 *
 * Surfaced in the language picker so a translator can see progress without
 * tooling, and so it is obvious at a glance that a partial translation is
 * expected rather than broken.
 */
export function countUntranslated(locale: LocaleCode): number {
    const pack = LOCALES[locale];
    if (!pack || locale === 'en') return 0;

    let missing = 0;
    for (const key of Object.keys(en) as TranslationKey[]) {
        const value = pack.strings[key];
        if (typeof value !== 'string' || value.length === 0) missing++;
    }
    return missing;
}

/**
 * Best-effort locale from the browser, used ONLY to pick a default on first
 * run. An explicit choice is never overridden — see `migrateSettings`.
 */
export function detectLocale(): LocaleCode {
    if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
    for (const tag of navigator.languages ?? [navigator.language]) {
        const base = String(tag).toLowerCase().split('-')[0];
        // `pseudo` is a test tool and must never be auto-selected.
        if (base !== 'pseudo' && isLocaleCode(base)) return base;
    }
    return DEFAULT_LOCALE;
}
