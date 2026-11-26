import type { TranslationKey } from './locales/en';

export type LocaleCode = 'en' | 'ko' | 'ru' | 'pl' | 'id' | 'pseudo';

/**
 * Per-language visual corrections.
 *
 * The app's chrome is styled for English: ALL-CAPS with wide letter-spacing
 * (`uppercase tracking-[0.2em]`). That does not survive translation —
 * `uppercase` is a no-op on Hangul, wide tracking makes Hangul read as
 * mangled, and Cyrillic runs ~30% longer than English and overflows
 * fixed-width controls.
 *
 * A locale declares its corrections HERE, in its own file, and never by
 * editing components. `applyLocale()` projects this onto the document root as
 * data-attributes; `src/index.css` reacts to them (see the LANGUAGE OVERRIDES
 * block at the bottom of that file).
 *
 * MASTERPLAN Locked Decision 4.
 */
export type StyleProfile = {
    /** 'flat' cancels `text-transform: uppercase` on chrome labels. Default 'as-authored'. */
    caps?: 'as-authored' | 'flat';
    /** 'tight' cancels wide letter-spacing on chrome labels. Default 'as-authored'. */
    tracking?: 'as-authored' | 'tight';
    /**
     * Font stack for this language, applied to the whole document.
     * Only set it when the default stack genuinely fails to render the script.
     */
    fontStack?: string;
};

export type LocalePack = {
    /** BCP-47-ish code. Must match the key in the registry. */
    code: LocaleCode;
    /** Name shown in the language dropdown, written in the language itself. */
    label: string;
    /**
     * Translated strings. Partial by design — anything missing falls back to
     * English, so a half-finished translation is a shipping state, not a bug.
     * TypeScript rejects keys that do not exist in `en`.
     */
    strings: Partial<Record<TranslationKey, string>>;
    /** Optional visual corrections for this language. */
    styleProfile?: StyleProfile;
};
