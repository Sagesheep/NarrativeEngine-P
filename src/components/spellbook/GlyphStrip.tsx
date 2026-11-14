import type { ReactNode } from 'react';
import { useTranslation } from '../../i18n/useTranslation';
import { glyphLabelKey } from '../character/tabs/glyphLabels';
import type { GlyphAbility } from '../../types';
import { GlyphShape } from './GlyphShape';
import type { GlyphKind } from './glyphIcons';

export function GlyphStrip({ ability, size = 'sm', className = '' }: { ability: GlyphAbility; size?: 'xs' | 'sm'; className?: string }) {
    const { t } = useTranslation();
    const items: ReactNode[] = [];
    const push = (kind: GlyphKind, id: string, key: string) => {
        const name = t(glyphLabelKey({ kind, id }));
        items.push(
            <span key={key} title={name} role="img" aria-label={name} className="inline-flex">
                <GlyphShape kind={kind} id={id} size={kind === 'augment' ? 'xs' : size} />
            </span>,
        );
    };
    push('form', ability.form.id, 'form');
    ability.form.augments.forEach((a, i) => push('augment', a, `form-aug-${i}`));
    ability.effects.forEach((e, i) => {
        push('effect', e.id, `effect-${i}`);
        e.augments.forEach((a, j) => push('augment', a, `effect-${i}-aug-${j}`));
    });
    return <span data-testid="glyph-strip" className={`inline-flex items-center flex-wrap gap-1 ${className}`}>{items}</span>;
}
