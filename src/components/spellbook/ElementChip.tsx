import type { ElementId } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import { elementOutsidePreset } from '../../services/combat/spellbook';
import { useElementPreset } from './useElementPreset';
import { ELEMENT_COLORS, elementDescription, elementName } from '../combat/elementText';

const BOX = { xs: 'w-5 h-5 text-[9px]', sm: 'w-7 h-7 text-[11px]', md: 'w-10 h-10 text-sm' } as const;

export function ElementSwatch({ element, size = 'md', dim = false, selected = false, flagged = false }: {
    element: ElementId;
    size?: keyof typeof BOX;
    dim?: boolean;
    selected?: boolean;
    flagged?: boolean;
}) {
    const { t } = useTranslation();
    const color = ELEMENT_COLORS[element];
    const name = elementName(element, t);
    return (
        <span
            data-element-swatch={element}
            data-flagged={flagged ? 'true' : undefined}
            className={`inline-flex items-center justify-center shrink-0 rounded-full font-bold ${BOX[size]} ${dim ? 'opacity-40' : ''} ${selected ? 'ring-2 ring-terminal ring-offset-2 ring-offset-surface' : ''}`}
            style={{
                color,
                border: `3px ${flagged ? 'dashed' : 'double'} ${color}`,
                background: `color-mix(in srgb, ${color} 18%, transparent)`,
            }}
        >
            <span aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
        </span>
    );
}

export function ElementChip({ element, size = 'sm' }: { element: ElementId; size?: 'xs' | 'sm' }) {
    const { t } = useTranslation();
    const preset = useElementPreset();
    const flagged = elementOutsidePreset({ element }, preset);
    const name = elementName(element, t);
    const label = flagged ? t('spellbook.element.outside', { name }) : t('spellbook.element.named', { name });
    return (
        <span
            data-testid="element-chip"
            data-element={element}
            data-outside={flagged ? 'true' : 'false'}
            role="img"
            aria-label={label}
            title={`${label}. ${elementDescription(element, t)}`}
            className="inline-flex items-center gap-1"
        >
            <ElementSwatch element={element} size={size} flagged={flagged} />
            {flagged && <span aria-hidden="true" className="text-[10px] font-bold" style={{ color: 'var(--combat-hp-warn)' }}>!</span>}
        </span>
    );
}
