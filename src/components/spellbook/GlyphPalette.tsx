import { useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { allGlyphs, describeGlyph, glyphCost } from '@narrative/engine';
import type { CasterStats, GlyphKind, GlyphRef, PlacementReason } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import { glyphLabelKey } from '../character/tabs/glyphLabels';
import { GLYPH_MIME, SOCKET_MIME, carries, encodeGlyph, readTransfer } from './dnd';
import { GlyphShape } from './GlyphShape';
import { useReasonText } from './useReasonText';

const GROUPS: ReadonlyArray<{ kind: GlyphKind; heading: 'spellbook.palette.forms' | 'spellbook.palette.effects' | 'spellbook.palette.augments' }> = [
    { kind: 'form', heading: 'spellbook.palette.forms' },
    { kind: 'effect', heading: 'spellbook.palette.effects' },
    { kind: 'augment', heading: 'spellbook.palette.augments' },
];

const tileId = (g: GlyphRef) => `${g.kind}-${g.id}`;

export function GlyphPalette({ stats, label, reasonFor, onPlace, onRemoveSocket }: {
    stats: CasterStats;
    label: string;
    reasonFor: (glyph: GlyphRef) => PlacementReason | null;
    onPlace: (glyph: GlyphRef) => void;
    onRemoveSocket: (key: string) => void;
}) {
    const { t } = useTranslation();
    const reasonText = useReasonText();
    const refs = useRef(new Map<string, HTMLButtonElement>());
    const flat = GROUPS.flatMap(g => allGlyphs(g.kind));
    const [activeId, setActiveId] = useState(tileId(flat[0]));
    const [shown, setShown] = useState<GlyphRef | null>(null);

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

    const onDrop = (e: DragEvent) => {
        if (!carries(e.dataTransfer, SOCKET_MIME)) return;
        e.preventDefault();
        const key = readTransfer(e.dataTransfer, SOCKET_MIME);
        if (key) onRemoveSocket(key);
    };

    const shownReason = shown ? reasonFor(shown) : null;

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
                            return (
                                <button
                                    key={tileId(glyph)}
                                    ref={(el) => { if (el) refs.current.set(tileId(glyph), el); else refs.current.delete(tileId(glyph)); }}
                                    type="button"
                                    data-testid={`palette-${tileId(glyph)}`}
                                    data-dim={reason ? 'true' : 'false'}
                                    aria-disabled={reason ? true : undefined}
                                    aria-label={reason ? `${name}, ${cost}. ${reasonText(reason)}` : `${name}, ${cost}`}
                                    tabIndex={tileId(glyph) === activeId ? 0 : -1}
                                    draggable
                                    onDragStart={(e) => { e.dataTransfer.setData(GLYPH_MIME, encodeGlyph(glyph)); e.dataTransfer.effectAllowed = 'copy'; }}
                                    onClick={() => { setActiveId(tileId(glyph)); onPlace(glyph); }}
                                    onKeyDown={(e) => onKey(e, index)}
                                    onFocus={() => { setActiveId(tileId(glyph)); setShown(glyph); }}
                                    onMouseEnter={() => setShown(glyph)}
                                    onMouseLeave={() => setShown(null)}
                                    className="flex flex-col items-center gap-1 rounded-lg p-2 outline-none hover:bg-void-lighter focus-visible:ring-2 focus-visible:ring-terminal"
                                >
                                    <GlyphShape kind={glyph.kind} id={glyph.id} size={glyph.kind === 'augment' ? 'sm' : 'md'} dim={!!reason} />
                                    <span className={`text-xs text-center leading-tight ${reason ? 'text-text-dim' : 'text-text-primary'}`}>{name}</span>
                                    <span className="text-xs font-mono text-text-dim">{cost}</span>
                                </button>
                            );
                        })}
                    </div>
                </section>
            ))}
            <section aria-label={t('spellbook.palette.details')} data-testid="glyph-detail" className="rounded-lg border border-border bg-void p-3 flex flex-col gap-1.5 min-h-[7rem]">
                {shown ? (
                    <>
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm font-bold text-text-primary">{t(glyphLabelKey(shown))}</span>
                            <span className="text-xs font-mono text-text-dim">{t(`spellbook.kind.${shown.kind}`)}</span>
                        </div>
                        {describeGlyph(shown, stats).map((line, i) => <p key={`${i}-${line}`} className="text-xs text-text-dim leading-relaxed">{line}</p>)}
                        {shownReason && <p className="text-xs text-danger leading-relaxed">{reasonText(shownReason)}</p>}
                    </>
                ) : (
                    <p className="text-xs text-text-dim leading-relaxed">{t('spellbook.palette.hint')}</p>
                )}
            </section>
        </div>
    );
}
