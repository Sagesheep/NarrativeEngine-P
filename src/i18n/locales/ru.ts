import type { LocalePack } from '../types';

/**
 * Russian.
 *
 * Status: AWAITING TRANSLATION. The handful of entries below are seeds so the
 * wiring is visibly working end-to-end — a translator should verify them along
 * with everything else. Every key not listed here falls back to English
 * automatically; that is expected and the app stays fully usable.
 *
 * To contribute: see docs/TRANSLATING.md.
 */
export const ru: LocalePack = {
    code: 'ru',
    label: 'Русский',

    /**
     * Cyrillic does have letter case, so the ALL-CAPS chrome is left as
     * authored. The real Russian problem is LENGTH (~30% longer than English),
     * which overflows fixed-width controls — wide letter-spacing makes that
     * worse, so tracking is tightened.
     *
     * Revisit once the translation is real: if labels still overflow, the fix
     * belongs in the LANGUAGE OVERRIDES block of src/index.css, keyed on
     * [data-lang="ru"] — never in a component.
     */
    styleProfile: {
        tracking: 'tight',
    },

    strings: {
        'hub.delete.cancel': 'Отмена',
        'hub.delete.confirmAction': 'Удалить',
        'header.settings.label': 'Настройки',
    },
};
