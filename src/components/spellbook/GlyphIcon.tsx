import { createElement, useContext } from 'react';
import type { LucideProps } from 'lucide-react';
import { GlyphArtContext, glyphArtUrl } from './glyphAvailability';
import { iconFor } from './glyphIcons';
import type { GlyphKind } from './glyphIcons';

export function GlyphIcon({ kind, id, size = 20, className }: { kind: GlyphKind; id: string; size?: number; className?: string }) {
    const art = useContext(GlyphArtContext);
    if (art.has(id)) {
        const url = `url("${glyphArtUrl(id)}")`;
        return (
            <span
                data-glyph-icon={id}
                data-glyph-art="true"
                aria-hidden="true"
                className={`inline-block shrink-0 ${className ?? ''}`}
                style={{
                    width: size,
                    height: size,
                    backgroundColor: 'currentColor',
                    WebkitMaskImage: url,
                    maskImage: url,
                    WebkitMaskSize: 'contain',
                    maskSize: 'contain',
                    WebkitMaskRepeat: 'no-repeat',
                    maskRepeat: 'no-repeat',
                    WebkitMaskPosition: 'center',
                    maskPosition: 'center',
                }}
            />
        );
    }
    return createElement(iconFor(kind, id), {
        'data-glyph-icon': id,
        'data-glyph-art': 'false',
        'aria-hidden': true,
        size,
        className: `shrink-0 ${className ?? ''}`,
    } as LucideProps);
}
