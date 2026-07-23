import { describe, it, expect, beforeEach } from 'vitest';
import {
    LOCALES,
    LOCALE_ORDER,
    applyLocale,
    chromeTextStyle,
    countUntranslated,
    detectLocale,
    en,
    getLocale,
    getStyleProfile,
    isLocaleCode,
    t,
    translateIn,
    type TranslationKey,
} from '../index';
import { pseudoize } from '../locales/pseudo';

beforeEach(() => {
    applyLocale('en');
});

describe('fallback (MASTERPLAN acceptance gate 5)', () => {
    it('falls back to English for a key the locale has not translated', () => {
        // id deliberately ships almost empty — this is the normal state of a
        // translation in progress, and it must render the English string.
        expect(LOCALES.id.strings['header.exit.label']).toBeUndefined();
        expect(translateIn('id', 'header.exit.label')).toBe(en['header.exit.label']);
    });

    it('renders a fully working English app for a locale with zero keys', () => {
        const empty = { code: 'ko' as const, label: 'x', strings: {} };
        const original = LOCALES.ko;
        try {
            LOCALES.ko = empty;
            for (const key of Object.keys(en) as TranslationKey[]) {
                expect(translateIn('ko', key)).toBe(en[key]);
            }
        } finally {
            LOCALES.ko = original;
        }
    });

    it('uses the translation when one exists', () => {
        expect(translateIn('ko', 'hub.delete.cancel')).toBe('취소');
        expect(translateIn('ru', 'hub.delete.cancel')).toBe('Отмена');
    });

    it('treats an empty-string translation as missing rather than blanking the control', () => {
        const original = LOCALES.ru;
        try {
            LOCALES.ru = { ...original, strings: { 'header.exit.label': '' } };
            expect(translateIn('ru', 'header.exit.label')).toBe(en['header.exit.label']);
        } finally {
            LOCALES.ru = original;
        }
    });

    it('returns the key itself for an unknown key so the miss is visible, not blank', () => {
        expect(translateIn('en', 'nope.not.a.key' as TranslationKey)).toBe('nope.not.a.key');
    });
});

describe('typed keys (MASTERPLAN acceptance gate 6)', () => {
    it('rejects a key that does not exist in en', () => {
        // @ts-expect-error — an invented key must not type-check. If this line
        // ever stops erroring, the typed-key guarantee has been lost and
        // translators can drift onto keys that render nothing.
        translateIn('en', 'settings.language.nonexistent');
    });

    it('rejects a locale string keyed on something absent from en', () => {
        // @ts-expect-error — same guarantee, from the locale-file side.
        const bad: (typeof LOCALES)['ko'] = { code: 'ko', label: 'x', strings: { 'not.a.real.key': 'x' } };
        void bad;
    });
});

describe('interpolation (Locked Decision 6)', () => {
    it('substitutes named placeholders', () => {
        expect(translateIn('en', 'header.version.tooltip', { version: '1.0.2' }))
            .toBe('Narrative Engine version 1.0.2');
    });

    it('substitutes into a quoted placeholder', () => {
        expect(translateIn('en', 'hub.import.success', { name: 'Dune' }))
            .toBe('"Dune" imported — search index rebuilding in background');
    });

    it('leaves an unfilled placeholder intact rather than printing undefined', () => {
        expect(translateIn('en', 'header.version.tooltip')).toBe('Narrative Engine version {{version}}');
    });
});

describe('plurals (Locked Decision 7)', () => {
    it('picks one vs other in English', () => {
        expect(translateIn('en', 'settings.language.untranslated', { count: 1 }))
            .toBe('1 item still shows in English.');
        expect(translateIn('en', 'settings.language.untranslated', { count: 5 }))
            .toBe('5 items still show in English.');
    });

    it('selects the Russian form matching the count, not the English one', () => {
        const original = LOCALES.ru;
        try {
            LOCALES.ru = {
                ...original,
                strings: {
                    'settings.language.untranslated.one': '{{count}} строка',
                    'settings.language.untranslated.few': '{{count}} строки',
                    'settings.language.untranslated.many': '{{count}} строк',
                },
            };
            // Russian: 1 → one, 2-4 → few, 5+ → many. Naive interpolation would
            // produce visibly broken Russian for two of these three.
            expect(translateIn('ru', 'settings.language.untranslated', { count: 1 })).toBe('1 строка');
            expect(translateIn('ru', 'settings.language.untranslated', { count: 3 })).toBe('3 строки');
            expect(translateIn('ru', 'settings.language.untranslated', { count: 7 })).toBe('7 строк');
        } finally {
            LOCALES.ru = original;
        }
    });

    it('selects the Polish form matching the count', () => {
        const original = LOCALES.pl;
        try {
            LOCALES.pl = {
                ...original,
                strings: {
                    'settings.language.untranslated.one': '{{count}} pozycja',
                    'settings.language.untranslated.few': '{{count}} pozycje',
                    'settings.language.untranslated.many': '{{count}} pozycji',
                },
            };
            // Polish: 1 → one, 2-4 → few, 5+ → many.
            expect(translateIn('pl', 'settings.language.untranslated', { count: 1 })).toBe('1 pozycja');
            expect(translateIn('pl', 'settings.language.untranslated', { count: 3 })).toBe('3 pozycje');
            expect(translateIn('pl', 'settings.language.untranslated', { count: 9 })).toBe('9 pozycji');
        } finally {
            LOCALES.pl = original;
        }
    });

    it('uses the single Indonesian form for every count', () => {
        const original = LOCALES.id;
        try {
            LOCALES.id = {
                ...original,
                strings: { 'settings.language.untranslated.other': '{{count}} item' },
            };
            // Indonesian has no plural agreement — `.other` must serve every count
            // rather than falling through to the English one/other split.
            for (const count of [1, 2, 5, 21]) {
                expect(translateIn('id', 'settings.language.untranslated', { count })).toBe(`${count} item`);
            }
        } finally {
            LOCALES.id = original;
        }
    });

    it('falls back to .other when the locale has not supplied that plural form', () => {
        const original = LOCALES.ru;
        try {
            LOCALES.ru = {
                ...original,
                strings: { 'settings.language.untranslated.other': '{{count}} штук' },
            };
            // count 1 selects 'one', which this locale lacks — must degrade to
            // '.other' rather than leaking the English string.
            expect(translateIn('ru', 'settings.language.untranslated', { count: 1 })).toBe('1 штук');
        } finally {
            LOCALES.ru = original;
        }
    });
});

describe('applyLocale + style profile (Locked Decision 4)', () => {
    it('stamps the document root so CSS can key off it', () => {
        applyLocale('ko');
        const html = document.documentElement;
        expect(html.getAttribute('data-lang')).toBe('ko');
        expect(html.getAttribute('data-lang-caps')).toBe('flat');
        expect(html.getAttribute('data-lang-tracking')).toBe('tight');
        expect(html.getAttribute('lang')).toBe('ko');
    });

    it('resets the profile attributes when moving to a locale without overrides', () => {
        applyLocale('ko');
        applyLocale('en');
        const html = document.documentElement;
        expect(html.getAttribute('data-lang-caps')).toBe('as-authored');
        expect(html.getAttribute('data-lang-tracking')).toBe('as-authored');
    });

    it('never advertises pseudo as a real language to the platform', () => {
        applyLocale('pseudo');
        expect(document.documentElement.getAttribute('data-lang')).toBe('pseudo');
        expect(document.documentElement.getAttribute('lang')).toBe('en');
    });

    it('ignores an unknown locale instead of leaving the app in a broken state', () => {
        applyLocale('klingon' as never);
        expect(getLocale()).toBe('en');
    });

    it('cancels inline caps/tracking for Korean but leaves them for English', () => {
        const authored = { textTransform: 'uppercase' as const, letterSpacing: '0.4em' };
        expect(chromeTextStyle(authored, 'en')).toEqual(authored);
        expect(chromeTextStyle(authored, 'ko')).toEqual({ textTransform: 'none', letterSpacing: 'normal' });
        // Cyrillic keeps its capitals; only the spacing is tightened.
        expect(chromeTextStyle(authored, 'ru')).toEqual({ textTransform: 'uppercase', letterSpacing: 'normal' });
    });

    it('exposes no style overrides for the pseudo locale — the point is to see the damage', () => {
        expect(getStyleProfile('pseudo')).toEqual({});
    });
});

describe('module-level t() for non-React callers', () => {
    it('follows the applied locale', () => {
        applyLocale('ru');
        expect(t('hub.delete.cancel')).toBe('Отмена');
        applyLocale('en');
        expect(t('hub.delete.cancel')).toBe('Cancel');
    });
});

describe('registry', () => {
    it('lists every registered locale in the dropdown order, pseudo last', () => {
        expect(LOCALE_ORDER).toEqual(Object.keys(LOCALES));
        expect(LOCALE_ORDER[LOCALE_ORDER.length - 1]).toBe('pseudo');
    });

    it('gives every locale a label written in its own language', () => {
        expect(LOCALES.ko.label).toBe('한국어');
        expect(LOCALES.ru.label).toBe('Русский');
        expect(LOCALES.pl.label).toBe('Polski');
        expect(LOCALES.id.label).toBe('Bahasa Indonesia');
    });

    it('registers each locale under the code it declares', () => {
        // A copy-pasted locale file that forgets to change `code` would silently
        // mis-stamp data-lang and pick the wrong plural rules.
        for (const [key, pack] of Object.entries(LOCALES)) {
            expect(pack.code).toBe(key);
        }
    });

    it('validates locale codes', () => {
        expect(isLocaleCode('ko')).toBe(true);
        expect(isLocaleCode('pl')).toBe(true);
        expect(isLocaleCode('id')).toBe(true);
        expect(isLocaleCode('de')).toBe(false);
        expect(isLocaleCode(undefined)).toBe(false);
    });

    it('never auto-detects pseudo', () => {
        expect(detectLocale()).not.toBe('pseudo');
    });
});

describe('coverage counter', () => {
    it('reports English as fully covered', () => {
        expect(countUntranslated('en')).toBe(0);
    });

    it('counts the keys a partial locale still needs', () => {
        const total = Object.keys(en).length;
        const done = Object.keys(LOCALES.ko.strings).length;
        expect(countUntranslated('ko')).toBe(total - done);
    });
});

describe('pseudo locale', () => {
    it('covers every key, so no English can hide behind a missing translation', () => {
        expect(countUntranslated('pseudo')).toBe(0);
    });

    it('preserves placeholders so interpolation still works under test', () => {
        expect(pseudoize('version {{version}} here')).toContain('{{version}}');
        expect(translateIn('pseudo', 'header.version.tooltip', { version: '9.9.9' })).toContain('9.9.9');
    });

    it('pads the string so overflow shows up before a real translation exists', () => {
        expect(pseudoize('Settings').length).toBeGreaterThan('Settings'.length * 1.3);
    });

    it('brackets the string so clipping is visible', () => {
        const out = pseudoize('Exit');
        expect(out.startsWith('«')).toBe(true);
        expect(out.endsWith('»')).toBe(true);
    });
});

describe('English parity (MASTERPLAN acceptance gate 4)', () => {
    it('renders every key unchanged in English', () => {
        for (const key of Object.keys(en) as TranslationKey[]) {
            expect(translateIn('en', key)).toBe(en[key]);
        }
    });
});
