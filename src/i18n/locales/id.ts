import type { LocalePack } from '../types';

/**
 * Indonesian.
 *
 * Status: AWAITING TRANSLATION. The handful of entries below are seeds so the
 * wiring is visibly working end-to-end — verify them along with everything else.
 * Every key not listed here falls back to English automatically; that is
 * expected and the app stays fully usable.
 *
 * Plurals: Indonesian has no plural agreement — a single `.other` variant
 * covers every count. Ignore the `.one` / `.few` / `.many` keys entirely.
 *
 * To contribute: see docs/TRANSLATING.md.
 */
export const id: LocalePack = {
    code: 'id',
    label: 'Bahasa Indonesia',

    /**
     * Latin script with letter case, so the ALL-CAPS chrome is left as authored.
     * Indonesian runs noticeably longer than English ("Pengaturan" vs
     * "Settings", "Cadangkan" vs "Backup"), so the wide letter-spacing is
     * tightened to buy back width in fixed-size controls.
     */
    styleProfile: {
        tracking: 'tight',
    },

    strings: {
        'hub.delete.cancel': 'Batal',
        'hub.delete.confirmAction': 'Hapus',
        'header.settings.label': 'Pengaturan',
    },
};
