import { GlyphIcon } from './GlyphIcon';
import { KIND_COLOR_VARS } from './glyphIcons';
import type { GlyphKind } from './glyphIcons';

export type GlyphSize = 'xs' | 'sm' | 'md' | 'lg';

const BOX: Readonly<Record<GlyphSize, string>> = { xs: 'w-5 h-5', sm: 'w-7 h-7', md: 'w-10 h-10', lg: 'w-14 h-14' };

const ICON: Readonly<Record<GlyphSize, number>> = { xs: 12, sm: 14, md: 20, lg: 28 };

const SHAPE: Readonly<Record<GlyphKind, string>> = {
    form: 'rounded-lg',
    effect: 'rounded-full',
    augment: 'rounded-sm rotate-45',
};

export function GlyphShape({ kind, id, size = 'md', selected = false, dim = false, className = '' }: {
    kind: GlyphKind;
    id: string | null;
    size?: GlyphSize;
    selected?: boolean;
    dim?: boolean;
    className?: string;
}) {
    const color = KIND_COLOR_VARS[kind];
    const margin = kind === 'augment' ? (size === 'xs' ? 'm-1' : 'm-1.5') : '';
    const border = id === null ? 'border-dashed' : '';
    const fade = dim ? 'opacity-40' : '';
    const ring = selected ? 'ring-2 ring-terminal ring-offset-2 ring-offset-surface' : '';
    return (
        <span
            data-glyph-shape={kind}
            className={`inline-flex items-center justify-center shrink-0 border-2 transition-colors ${BOX[size]} ${SHAPE[kind]} ${margin} ${border} ${fade} ${ring} ${className}`}
            style={{
                color,
                borderColor: color,
                background: id === null ? 'transparent' : `color-mix(in srgb, ${color} 16%, transparent)`,
            }}
        >
            <span className={kind === 'augment' ? '-rotate-45 inline-flex' : 'inline-flex'}>
                {id === null ? null : <GlyphIcon kind={kind} id={id} size={ICON[size]} />}
            </span>
        </span>
    );
}
