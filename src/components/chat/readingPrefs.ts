import type { CSSProperties } from 'react';
import type { AppSettings, ReadingAlign, ReadingFont, ReadingLeading, ReadingWidth } from '../../types';

/**
 * Story typography — the reading area's own settings, separate from UI Scale.
 *
 * UI Scale zooms the whole interface; these set only the story column, as CSS
 * variables on `.story-journal` (consumed in index.css). Both multiply: UI
 * Scale 90% with a 17px reading size renders at 15.3px, which is what a user
 * who shrank everything expects.
 *
 * The column is measured in multiples of the reading size rather than in fixed
 * px, so the line length stays inside the readable band when the size changes.
 * 2.0.1 set it in px (1280px) and shipped ~150 characters per line; 60–80 is
 * the range long-form type is set to. Rough characters per line at each width, by face:
 * Palatino ≈ 2.2/em, EB Garamond ≈ 2.4/em, Segoe UI ≈ 2.0/em.
 */

export const READING_FONTS: { value: ReadingFont; label: string }[] = [
    { value: 'serif', label: 'Serif' },
    { value: 'sans', label: 'Sans' },
];

export const READING_LEADINGS: { value: ReadingLeading; label: string; lineHeight: number }[] = [
    { value: 'tight', label: 'Tight', lineHeight: 1.4 },
    { value: 'normal', label: 'Normal', lineHeight: 1.55 },
    { value: 'relaxed', label: 'Relaxed', lineHeight: 1.75 },
];

/** `em` is the text-column width in multiples of the reading size; null = fill. */
export const READING_WIDTHS: { value: ReadingWidth; label: string; em: number | null }[] = [
    { value: 'narrow', label: 'Narrow', em: 28 },
    { value: 'standard', label: 'Standard', em: 34 },
    { value: 'wide', label: 'Wide', em: 44 },
    { value: 'full', label: 'Full', em: null },
];

/** Where the column sits when it is narrower than the story area. Text inside stays left-aligned. */
export const READING_ALIGNS: { value: ReadingAlign; label: string }[] = [
    { value: 'left', label: 'Left' },
    { value: 'center', label: 'Center' },
    { value: 'right', label: 'Right' },
];

/** The hover rail (copy / edit / regenerate) sits in a gutter beside each message. */
const MESSAGE_RAIL_GUTTER_PX = 44;

export const READING_SIZE_MIN = 13;
export const READING_SIZE_MAX = 24;

export const READING_DEFAULTS = {
    readingFont: 'serif' as ReadingFont,
    readingSize: 17,
    readingLeading: 'normal' as ReadingLeading,
    readingWidth: 'standard' as ReadingWidth,
    readingAlign: 'center' as ReadingAlign,
};

export function clampReadingSize(size: unknown): number {
    const n = typeof size === 'number' && Number.isFinite(size) ? Math.round(size) : READING_DEFAULTS.readingSize;
    return Math.min(READING_SIZE_MAX, Math.max(READING_SIZE_MIN, n));
}

export function normalizeReadingFont(v: unknown): ReadingFont {
    return READING_FONTS.some(o => o.value === v) ? (v as ReadingFont) : READING_DEFAULTS.readingFont;
}

export function normalizeReadingLeading(v: unknown): ReadingLeading {
    return READING_LEADINGS.some(o => o.value === v) ? (v as ReadingLeading) : READING_DEFAULTS.readingLeading;
}

export function normalizeReadingWidth(v: unknown): ReadingWidth {
    return READING_WIDTHS.some(o => o.value === v) ? (v as ReadingWidth) : READING_DEFAULTS.readingWidth;
}

export function normalizeReadingAlign(v: unknown): ReadingAlign {
    return READING_ALIGNS.some(o => o.value === v) ? (v as ReadingAlign) : READING_DEFAULTS.readingAlign;
}

type ReadingSettings = Pick<AppSettings, 'readingFont' | 'readingSize' | 'readingLeading' | 'readingWidth'>;

/** The CSS variables the story column reads. Unknown values fall back to defaults. */
export function readingStyleVars(settings: ReadingSettings | null | undefined): CSSProperties {
    const leading = READING_LEADINGS.find(o => o.value === normalizeReadingLeading(settings?.readingLeading))!;
    const width = READING_WIDTHS.find(o => o.value === normalizeReadingWidth(settings?.readingWidth))!;
    const size = clampReadingSize(settings?.readingSize);
    // Resolved to px here rather than written as `em` in CSS: an `em` max-width
    // resolves against the column's own font-size, which is the UI's, not the
    // story's.
    const measure = width.em === null ? 'none' : `${Math.round(size * width.em) + MESSAGE_RAIL_GUTTER_PX}px`;
    return {
        '--reading-size': `${size}px`,
        '--reading-leading': String(leading.lineHeight),
        '--reading-measure': measure,
    } as CSSProperties;
}
