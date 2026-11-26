import type { LocalePack } from '../types';
import { en, type TranslationKey } from './en';

/**
 * Pseudo-locale — a layout test, not a language.
 *
 * It answers the question "how badly does the UI break when it is not English?"
 * without waiting on a volunteer to finish real work. Every string is:
 *   • accented    — proves the string came from `t()` and is not a hardcoded leftover
 *   • padded ~40% — approximates Russian, which runs ~30% longer than English
 *   • Hangul-tailed — forces a CJK glyph through the font stack and line metrics
 *   • bracketed   — makes truncation obvious (a missing `»` means the text is clipped)
 *
 * Placeholders (`{{name}}`) are preserved exactly; interpolation must keep
 * working under test.
 *
 * MASTERPLAN: this is Phase 1's "visual assessment surface" — the thing that
 * lets the styling question be answered before Phase 2 commits to an approach.
 */

const ACCENTS: Record<string, string> = {
    a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý',
    A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', Y: 'Ý',
    c: 'ç', n: 'ñ', s: 'š', z: 'ž',
    C: 'Ç', N: 'Ñ', S: 'Š', Z: 'Ž',
};

/** Padding characters. Hangul so CJK line-height and font fallback get exercised. */
const PAD = '한글테스트';

function accent(text: string): string {
    return text.replace(/[a-zA-Z]/g, (ch) => ACCENTS[ch] ?? ch);
}

/**
 * Transform one English string. Splits on `{{placeholder}}` so the placeholder
 * itself is never accented — it has to survive for interpolation to work.
 */
export function pseudoize(value: string): string {
    const accented = value
        .split(/(\{\{[^}]+\}\})/g)
        .map((part) => (part.startsWith('{{') ? part : accent(part)))
        .join('');

    // Pad to ~140% of the original visible length, rounded up to whole chars.
    const padLength = Math.max(1, Math.ceil(value.length * 0.4));
    let pad = '';
    while (pad.length < padLength) pad += PAD;

    return `«${accented} ${pad.slice(0, padLength)}»`;
}

function buildPseudoStrings(): Partial<Record<TranslationKey, string>> {
    const out: Partial<Record<TranslationKey, string>> = {};
    for (const key of Object.keys(en) as TranslationKey[]) {
        out[key] = pseudoize(en[key]);
    }
    return out;
}

export const pseudo: LocalePack = {
    code: 'pseudo',
    label: '⚠ Pseudo (layout test)',
    // Deliberately no styleProfile: the point is to see the UNCORRECTED layout.
    strings: buildPseudoStrings(),
};
