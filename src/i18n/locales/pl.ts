import type { LocalePack } from '../types';

/**
 * Polish.
 *
 * Status: AWAITING TRANSLATION. The handful of entries below are seeds so the
 * wiring is visibly working end-to-end — a translator should verify them along
 * with everything else. Every key not listed here falls back to English
 * automatically; that is expected and the app stays fully usable.
 *
 * Plurals: Polish uses one/few/many, like Russian — `Intl.PluralRules` already
 * selects the right form, so a translator only has to supply the variants.
 * See the plural section of docs/TRANSLATING.md.
 *
 * To contribute: see docs/TRANSLATING.md.
 */
export const pl: LocalePack = {
    code: 'pl',
    label: 'Polski',

    /**
     * Latin script with diacritics, and Polish does have letter case, so the
     * ALL-CAPS chrome is left as authored. Polish words do run longer than
     * English ("Ustawienia" vs "Settings"), so the wide letter-spacing is
     * tightened to buy back width.
     *
     * Revisit once the translation is real: if labels still overflow, fix it in
     * the LANGUAGE OVERRIDES block of src/index.css keyed on [data-lang="pl"] —
     * never in a component, and never by shortening the translation.
     */
    styleProfile: {
        tracking: 'tight',
    },

    strings: {
    // ── Header ───────────────────────────────────────────────────────────
    'header.drawer.open': 'Otwórz panel kontekstowy',
    'header.drawer.close': 'Zamknij panel kontekstowy',
    'header.title': 'Narrative Engine',
    'header.version.tooltip': 'Wersja Narrative Engine {{version}}',
    'header.backup.tooltip': 'Utwórz kopię zapasową',
    'header.backup.aria': 'Utwórz kopię zapasową',
    'header.backup.label': 'Kopia zapasowa',
    'header.backup.toast.noChanges': 'Brak zmian od ostatniej kopii zapasowej',
    'header.backup.toast.created': 'Utworzono kopię zapasową',
    'header.backup.toast.failed': 'Nie udało się utworzyć kopii zapasowej',
    'header.backups.tooltip': 'Menedżer kopii zapasowych',
    'header.backups.aria': 'Otwórz menedżera kopii zapasowych',
    'header.backups.label': 'Kopie zapasowe',
    'header.character.tooltip': 'Postać',
    'header.character.aria': 'Otwórz panel postaci',
    'header.character.label': 'Postać',
    'header.npcLedger.tooltip': 'Rejestr NPC',
    'header.npcLedger.aria': 'Otwórz rejestr NPC',
    'header.npcLedger.label': 'Rejestr NPC',
    'header.places.tooltip': 'Rejestr lokalizacji',
    'header.places.aria': 'Otwórz Rejestr lokalizacji',
    'header.places.label': 'Miejsca',
    'header.aiTier.tooltip': 'AI Tier: {{tier}} (kliknij, aby przełączać się między Lite → Pro → Max)',
    'header.aiTier.aria': 'AI Tier: {{tier}},  kliknij, aby przełączać',
    'header.pinned.tooltip': 'Przypięte wspomnienia',
    'header.pinned.aria': 'Otwórz przypięte wspomnienia',
    'header.pinned.label': 'Przypięte',
    'header.settings.tooltip': 'Ustawienia',
    'header.settings.aria': 'Otwórz ustawienia',
    'header.settings.label': 'Ustawienia',
    'header.exit.tooltip': 'Wyjście z kampanii',
    'header.exit.aria': 'Wyjście z kampanii',
    'header.exit.label': 'Wyjście',

    // ── Settings modal (shell) ───────────────────────────────────────────
    'settings.dialog.aria': 'Ustawienia',
    'settings.title': '⚙ USTAWIENIA',
    'settings.version.tooltip': 'Zainstalowana wersja Narrative Engine',
    'settings.close.aria': 'Zamknij ustawienia',
    'settings.tab.providers': 'Dostawcy LLM',
    'settings.tab.presets': 'Presety',
    'settings.tab.global': 'Globalne',
    'settings.tab.advanced': 'Zaawansowane',
    'settings.tab.debug': 'Debug',

    // ── Settings → Language ──────────────────────────────────────────────
    'settings.language.label': 'Język interfejsu',
    'settings.language.help': 'Zmiany dotyczą wyłącznie menu i przycisków. Wszystko, co nie zostało jeszcze przetłumaczone, pozostaje w języku angielskim.',
    'settings.language.contribute': 'Nie ma Twojego języka? Zobacz docs/TRANSLATING.md — jeden plik, nie są potrzebne żadne narzędzia.',
    'settings.language.pseudoWarning': 'Tylko test układu — nie jest to prawdziwy język. Użyj go, aby wykryć tekst, który wykracza poza granice przycisku.',
    'settings.language.complete': 'W całości przetłumaczony.',
    // Plural reference example. English needs one/other; Russian additionally
    // needs few/many. Only `.other` is mandatory — a locale that defines just
    // `.other` still renders correctly. Call as: t('...untranslated', { count }).
    'settings.language.untranslated.one': '{{count}} pozycja nadal wyświetla się w języku angielskim.',
    'settings.language.untranslated.other': '{{count}} pozycje nadal wyświetlają się w języku angielskim.',

    // ── Campaign hub ─────────────────────────────────────────────────────
    'hub.import.tooltip': 'Importuj kampanię',
    'hub.settings.tooltip': 'Ustawienia',
    'hub.worldLore.tooltip': 'Stwórz fabułę świata',
    'hub.tagline': 'AI Game Master System',
    'hub.brand.lead': 'Narrative',
    'hub.brand.accent': 'Nexus',
    'hub.subtitle': 'Wybierz swój świat. Ukształtuj jego losy.',
    'hub.delete.confirm': 'Czy chcesz usunąć tę kampanię? Wszystkie dane — historia czatu, fabuła, zapisy — zostaną utracone na zawsze.',
    'hub.delete.cancel': 'Anuluj',
    'hub.delete.confirmAction': 'Usuń',
    'hub.export.failed': 'Eksport nie powiódł się',
    'hub.import.success': '"{{name}}" zaimportowany — odbudowa indeksu wyszukiwania w tle',
    'hub.import.failed': 'Import nie powiódł się — nieprawidłowy plik kampanii',
    },
};
