import { useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { ELEMENTS, allGlyphs, describeGlyph, glyphCost, glyphTier } from '@narrative/engine';
import type { CasterStats, ElementId, ElementPlacementReason, GlyphKind, GlyphRef, PlacementReason } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import { glyphDescriptionKey, glyphLabelKey } from '../character/tabs/glyphLabels';
import { elementDescription, elementName } from '../combat/elementText';
import { GLYPH_MIME, SOCKET_MIME, carries, encodeGlyph, readTransfer } from './dnd';
import { ElementSwatch } from './ElementChip';
import { GlyphShape } from './GlyphShape';
import { useReasonText } from './useReasonText';

const GROUPS: ReadonlyArray<{ kind: GlyphKind; heading: 'spellbook.palette.forms' | 'spellbook.palette.effects' | 'spellbook.palette.augments' }> = [
    { kind: 'form', heading: 'spellbook.palette.forms' },
    { kind: 'effect', heading: 'spellbook.palette.effects' },
    { kind: 'augment', heading: 'spellbook.palette.augments' },
];

const tileId = (g: GlyphRef) => `${g.kind}-${g.id}`;

type Shown = { kind: 'glyph'; glyph: GlyphRef } | { kind: 'element'; element: ElementId };

export type PaletteElements = {
    list: readonly ElementId[];
    current: ElementId | null;
    reasonFor: (element: ElementId) => ElementPlacementReason | null;
    onToggle: (element: ElementId) => void;
};

export function GlyphPalette({ stats, label, reasonFor, onPlace, onRemoveSocket, elements }: {
    stats: CasterStats;
    label: string;
    reasonFor: (glyph: GlyphRef) => PlacementReason | null;
    onPlace: (glyph: GlyphRef) => void;
    onRemoveSocket: (key: string) => void;
    elements?: PaletteElements;
}) {
    const { t } = useTranslation();
    const reasonText = useReasonText();
    const refs = useRef(new Map<string, HTMLButtonElement>());
    const elementRefs = useRef(new Map<ElementId, HTMLButtonElement>());
    const flat = GROUPS.flatMap(g => allGlyphs(g.kind));
    const [activeId, setActiveId] = useState(tileId(flat[0]));
    const [activeElement, setActiveElement] = useState(0);
    const [shown, setShown] = useState<Shown | null>(null);

    const focusTile = (index: number) => {
        const target = flat[Math.max(0, Math.min(flat.length - 1, index))];
        setActiveId(tileId(target));
        refs.current.get(tileId(target))?.focus();
    };

    const columnsOf = (glyph: GlyphRef): number => {
        const peers = allGlyphs(glyph.kind).map(g => refs.current.get(tileId(g))).filter((el): el is HTMLButtonElement => !!el);
        if (peers.length === 0) return 1;
        return Math.max(1, peers.filter(el => el.offsetTop === peers[0].offsetTop).length);
    };

    const onKey = (e: KeyboardEvent, index: number) => {
        const glyph = flat[index];
        switch (e.key) {
            case 'ArrowRight': focusTile(index + 1); break;
            case 'ArrowLeft': focusTile(index - 1); break;
            case 'ArrowDown': focusTile(index + columnsOf(glyph)); break;
            case 'ArrowUp': focusTile(index - columnsOf(glyph)); break;
            case 'Home': focusTile(0); break;
            case 'End': focusTile(flat.length - 1); break;
            default: return;
        }
        e.preventDefault();
    };

    const focusElement = (index: number) => {
        const list = elements?.list ?? [];
        if (list.length === 0) return;
        const at = Math.max(0, Math.min(list.length - 1, index));
        setActiveElement(at);
        elementRefs.current.get(list[at])?.focus();
    };

    const onElementKey = (e: KeyboardEvent, index: number) => {
        switch (e.key) {
            case 'ArrowRight':
            case 'ArrowDown': focusElement(index + 1); break;
            case 'ArrowLeft':
            case 'ArrowUp': focusElement(index - 1); break;
            case 'Home': focusElement(0); break;
            case 'End': focusElement((elements?.list.length ?? 1) - 1); break;
            default: return;
        }
        e.preventDefault();
    };

    const onDrop = (e: DragEvent) => {
        if (!carries(e.dataTransfer, SOCKET_MIME)) return;
        e.preventDefault();
        const key = readTransfer(e.dataTransfer, SOCKET_MIME);
        if (key) onRemoveSocket(key);
    };

    const tierText = (tier: number) => t('spellbook.tier', { tier });

    const detail = () => {
        if (!shown) return <p className="text-xs text-text-dim leading-relaxed">{t('spellbook.palette.hint')}</p>;
        if (shown.kind === 'element') {
            const reason = elements?.reasonFor(shown.element) ?? null;
            const row = ELEMENTS[shown.element];
            return (
                <>
                    <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-bold text-text-primary">{elementName(shown.element, t)}</span>
                        <span className="text-xs font-mono text-text-dim">{t('spellbook.kind.element')} · {tierText(row.tier)}</span>
                    </div>
                    <p data-testid="glyph-detail-desc" className="text-xs text-text-primary leading-relaxed">{elementDescription(shown.element, t)}</p>
                    <p className="text-xs text-text-dim leading-relaxed">{t('combat.spellbook.cost', { cost: row.cost, label })}</p>
                    {reason && <p className="text-xs text-danger leading-relaxed">{reasonText.element(reason)}</p>}
                </>
            );
        }
        const glyph = shown.glyph;
        const reason = reasonFor(glyph);
        return (
            <>
                <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-bold text-text-primary">{t(glyphLabelKey(glyph))}</span>
                    <span className="text-xs font-mono text-text-dim">{t(`spellbook.kind.${glyph.kind}`)} · {tierText(glyphTier(glyph))}</span>
                </div>
                <p data-testid="glyph-detail-desc" className="text-xs text-text-primary leading-relaxed">{t(glyphDescriptionKey(glyph))}</p>
                {describeGlyph(glyph, stats).map((line, i) => <p key={`${i}-${line}`} className="text-xs text-text-dim leading-relaxed">{line}</p>)}
                {reason && <p className="text-xs text-danger leading-relaxed">{reasonText(reason)}</p>}
            </>
        );
    };

    return (
        <div
            data-testid="glyph-palette"
            onDragOver={(e) => { if (carries(e.dataTransfer, SOCKET_MIME)) e.preventDefault(); }}
            onDrop={onDrop}
            className="flex flex-col gap-5 min-w-0"
        >
            {GROUPS.map(group => (
                <section key={group.kind} aria-labelledby={`palette-${group.kind}`} className="flex flex-col gap-2">
                    <h3 id={`palette-${group.kind}`} className="text-xs font-mono uppercase tracking-wider text-text-dim">{t(group.heading)}</h3>
                    <div role="group" aria-labelledby={`palette-${group.kind}`} className="grid grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] gap-1">
                        {allGlyphs(group.kind).map(glyph => {
                            const index = flat.findIndex(g => tileId(g) === tileId(glyph));
                            const reason = reasonFor(glyph);
                            const name = t(glyphLabelKey(glyph));
                            const cost = t('combat.spellbook.cost', { cost: glyphCost(glyph), label });
                            const tier = tierText(glyphTier(glyph));
                            return (
                                <button
                                    key={tileId(glyph)}
                                    ref={(el) => { if (el) refs.current.set(tileId(glyph), el); else refs.current.delete(tileId(glyph)); }}
                                    type="button"
                                    data-testid={`palette-${tileId(glyph)}`}
                                    data-dim={reason ? 'true' : 'false'}
                                    data-tier={glyphTier(glyph)}
                                    aria-disabled={reason ? true : undefined}
                                    aria-label={reason ? `${name}, ${cost}, ${tier}. ${reasonText(reason)}` : `${name}, ${cost}, ${tier}`}
                                    tabIndex={tileId(glyph) === activeId ? 0 : -1}
                                    draggable
                                    onDragStart={(e) => { e.dataTransfer.setData(GLYPH_MIME, encodeGlyph(glyph)); e.dataTransfer.effectAllowed = 'copy'; }}
                                    onClick={() => { setActiveId(tileId(glyph)); onPlace(glyph); }}
                                    onKeyDown={(e) => onKey(e, index)}
                                    onFocus={() => { setActiveId(tileId(glyph)); setShown({ kind: 'glyph', glyph }); }}
                                    onMouseEnter={() => setShown({ kind: 'glyph', glyph })}
                                    onMouseLeave={() => setShown(null)}
                                    className="relative flex flex-col items-center gap-1 rounded-lg p-2 outline-none hover:bg-void-lighter focus-visible:ring-2 focus-visible:ring-terminal"
                                >
                                    <span aria-hidden="true" className="absolute top-0.5 right-1 text-[9px] font-mono text-text-dim">{t('spellbook.tierShort', { tier: glyphTier(glyph) })}</span>
                                    <GlyphShape kind={glyph.kind} id={glyph.id} size={glyph.kind === 'augment' ? 'sm' : 'md'} dim={!!reason} />
                                    <span className={`text-xs text-center leading-tight ${reason ? 'text-text-dim' : 'text-text-primary'}`}>{name}</span>
                                    <span className="text-xs font-mono text-text-dim">{cost}</span>
                                </button>
                            );
                        })}
                    </div>
                </section>
            ))}
            {elements && elements.list.length > 0 && (
                <section aria-labelledby="palette-element" data-testid="palette-elements" className="flex flex-col gap-2">
                    <h3 id="palette-element" className="text-xs font-mono uppercase tracking-wider text-text-dim">{t('spellbook.palette.elements')}</h3>
                    <div role="group" aria-labelledby="palette-element" className="grid grid-cols-[repeat(auto-fill,minmax(5rem,1fr))] gap-1">
                        {elements.list.map((element, index) => {
                            const reason = elements.reasonFor(element);
                            const name = elementName(element, t);
                            const row = ELEMENTS[element];
                            const cost = t('combat.spellbook.cost', { cost: row.cost, label });
                            const tier = tierText(row.tier);
                            const chosen = elements.current === element;
                            return (
                                <button
                                    key={element}
                                    ref={(el) => { if (el) elementRefs.current.set(element, el); else elementRefs.current.delete(element); }}
                                    type="button"
                                    data-testid={`palette-element-${element}`}
                                    data-dim={reason && !chosen ? 'true' : 'false'}
                                    data-tier={row.tier}
                                    aria-pressed={chosen}
                                    aria-disabled={reason && !chosen ? true : undefined}
                                    aria-label={reason && !chosen ? `${name}, ${cost}, ${tier}. ${reasonText.element(reason)}` : `${name}, ${cost}, ${tier}`}
                                    tabIndex={index === Math.min(activeElement, elements.list.length - 1) ? 0 : -1}
                                    onClick={() => { setActiveElement(index); elements.onToggle(element); }}
                                    onKeyDown={(e) => onElementKey(e, index)}
                                    onFocus={() => { setActiveElement(index); setShown({ kind: 'element', element }); }}
                                    onMouseEnter={() => setShown({ kind: 'element', element })}
                                    onMouseLeave={() => setShown(null)}
                                    className={`relative flex flex-col items-center gap-1 rounded-lg p-2 outline-none hover:bg-void-lighter focus-visible:ring-2 focus-visible:ring-terminal ${chosen ? 'bg-terminal/10' : ''}`}
                                >
                                    <span aria-hidden="true" className="absolute top-0.5 right-1 text-[9px] font-mono text-text-dim">{t('spellbook.tierShort', { tier: row.tier })}</span>
                                    <ElementSwatch element={element} dim={!!reason && !chosen} selected={chosen} />
                                    <span className={`text-xs text-center leading-tight ${reason && !chosen ? 'text-text-dim' : 'text-text-primary'}`}>{name}</span>
                                    <span className="text-xs font-mono text-text-dim">{cost}</span>
                                </button>
                            );
                        })}
                    </div>
                </section>
            )}
            <section aria-label={t('spellbook.palette.details')} data-testid="glyph-detail" className="rounded-lg border border-border bg-void p-3 flex flex-col gap-1.5 min-h-[7rem]">
                {detail()}
            </section>
        </div>
    );
}
