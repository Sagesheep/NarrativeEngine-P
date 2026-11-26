import type { CSSProperties } from 'react';
import type { AppSettings, ReadingAlign, ReadingFont, ReadingLeading, ReadingWidth, StoryTextColors } from '../../types';

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

/**
 * Story text colours — one per kind of text. Each is optional: unset keeps the
 * active theme's colour (index.css / beta.css read the variable with the
 * theme colour as fallback), so a fresh install looks exactly as before.
 * Quoted and bracketed text is only marked up at all for the kinds that have
 * a colour set (MessageMarkdown → markedTextPlugin). `marks` is the format as
 * the GM writes it, shown beside the picker.
 */
export const STORY_TEXT_KINDS: { key: keyof StoryTextColors; label: string; marks: string; cssVar: string }[] = [
    { key: 'text', label: 'Narration', marks: 'plain', cssVar: '--story-text-color' },
    { key: 'dialogue', label: 'Dialogue', marks: '"…"', cssVar: '--story-dialogue-color' },
    { key: 'singleQuote', label: 'Single', marks: "'…'", cssVar: '--story-single-quote-color' },
    { key: 'bracket', label: 'Brackets', marks: '[…]', cssVar: '--story-bracket-color' },
    { key: 'bold', label: 'Bold', marks: '**…**', cssVar: '--story-bold-color' },
    { key: 'italic', label: 'Italic', marks: '*…*', cssVar: '--story-italic-color' },
    { key: 'name', label: 'Names', marks: '', cssVar: '--story-name-color' },
];

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function normalizeStoryTextColors(v: unknown): StoryTextColors | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const out: StoryTextColors = {};
    for (const { key } of STORY_TEXT_KINDS) {
        const c = (v as Record<string, unknown>)[key];
        if (typeof c === 'string' && HEX_COLOR.test(c)) out[key] = c.toLowerCase();
    }
    return Object.keys(out).length ? out : undefined;
}

/** Set (or with null, clear) one colour, returning the new settings value. */
export function withStoryTextColor(current: StoryTextColors | undefined, key: keyof StoryTextColors, color: string | null): StoryTextColors | undefined {
    const next: StoryTextColors = { ...current };
    if (color === null) delete next[key];
    else next[key] = color;
    return normalizeStoryTextColors(next);
}

/** The CSS variables for the colours the player set; unset ones are omitted. */
export function storyTextColorVars(colors: StoryTextColors | undefined): CSSProperties {
    const vars: Record<string, string> = {};
    const valid = normalizeStoryTextColors(colors);
    for (const { key, cssVar } of STORY_TEXT_KINDS) {
        if (valid?.[key]) vars[cssVar] = valid[key]!;
    }
    return vars as CSSProperties;
}

type ReadingSettings = Pick<AppSettings, 'readingFont' | 'readingSize' | 'readingLeading' | 'readingWidth' | 'storyTextColors'>;

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
        ...storyTextColorVars(settings?.storyTextColors),
    } as CSSProperties;
}
