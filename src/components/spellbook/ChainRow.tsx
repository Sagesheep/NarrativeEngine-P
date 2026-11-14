import { useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { ChevronRight, Plus, X } from 'lucide-react';
import { chainColumns, glyphCost, sameSocket, socketKey } from '@narrative/engine';
import type { ChainColumn, ChainDraft, GlyphRef, Socket } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import { glyphLabelKey } from '../character/tabs/glyphLabels';
import { GLYPH_MIME, SOCKET_MIME, carries, parseGlyph, readTransfer } from './dnd';
import { GlyphShape } from './GlyphShape';

export function ChainRow({ chain, selected, label, onSelect, onRemove, onDropGlyph }: {
    chain: ChainDraft;
    selected: Socket | null;
    label: string;
    onSelect: (socket: Socket) => void;
    onRemove: (socket: Socket) => void;
    onDropGlyph: (socket: Socket, glyph: GlyphRef) => void;
}) {
    const { t } = useTranslation();
    const columns = chainColumns(chain);
    const refs = useRef(new Map<string, HTMLButtonElement>());
    const [focusKey, setFocusKey] = useState('form');
    const allKeys = columns.flatMap(c => [socketKey(c.owner), ...c.augments.map(a => socketKey(a.socket))]);
    const activeKey = allKeys.includes(focusKey) ? focusKey : 'form';

    const move = (key: string | undefined) => {
        if (!key) return;
        setFocusKey(key);
        refs.current.get(key)?.focus();
    };

    const socketName = (socket: Socket, glyph: GlyphRef | null, columnIndex: number): string => {
        const place = socket.kind === 'form'
            ? t('spellbook.socket.form')
            : socket.kind === 'effect'
                ? t('spellbook.socket.effect', { n: socket.index + 1 })
                : t('spellbook.socket.augment', {
                    owner: socket.owner === 'form' ? t('spellbook.socket.form') : t('spellbook.socket.effect', { n: columnIndex }),
                    n: socket.index + 1,
                });
        if (!glyph) return `${place}: ${t('spellbook.socket.empty')}`;
        return `${place}: ${t(glyphLabelKey(glyph))}, ${t('combat.spellbook.cost', { cost: glyphCost(glyph), label })}`;
    };

    const onKey = (e: KeyboardEvent, column: ChainColumn, columnIndex: number, augmentIndex: number, socket: Socket, glyph: GlyphRef | null) => {
        const ownerKeyAt = (i: number) => columns[i] ? socketKey(columns[i].owner) : undefined;
        const augKey = (i: number) => column.augments[i] ? socketKey(column.augments[i].socket) : undefined;
        const onOwner = augmentIndex < 0;
        switch (e.key) {
            case 'ArrowRight':
                move(onOwner ? ownerKeyAt(columnIndex + 1) : augKey(augmentIndex + 1));
                break;
            case 'ArrowLeft':
                move(onOwner ? ownerKeyAt(columnIndex - 1) : augKey(augmentIndex - 1));
                break;
            case 'ArrowDown':
                if (onOwner) move(augKey(0));
                break;
            case 'ArrowUp':
                if (!onOwner) move(ownerKeyAt(columnIndex));
                break;
            case 'Home':
                move(ownerKeyAt(0));
                break;
            case 'End':
                move(ownerKeyAt(columns.length - 1));
                break;
            case 'Delete':
            case 'Backspace':
                if (!glyph) return;
                onRemove(socket);
                queueMicrotask(() => move(onOwner && socket.kind === 'effect' ? 'form' : ownerKeyAt(columnIndex)));
                break;
            default:
                return;
        }
        e.preventDefault();
    };

    const dropOn = (e: DragEvent, socket: Socket) => {
        if (!carries(e.dataTransfer, GLYPH_MIME)) return;
        e.preventDefault();
        const glyph = parseGlyph(readTransfer(e.dataTransfer, GLYPH_MIME));
        if (glyph) onDropGlyph(socket, glyph);
    };

    const cell = (socket: Socket, glyph: GlyphRef | null, column: ChainColumn, columnIndex: number, augmentIndex: number) => {
        const key = socketKey(socket);
        const isAugment = socket.kind === 'augment';
        const kind = socket.kind;
        const name = socketName(socket, glyph, columnIndex);
        const isSelected = sameSocket(selected, socket);
        return (
            <div key={key} className={`relative flex flex-col items-center ${isAugment ? 'w-[4.5rem]' : 'w-24'}`}>
                <button
                    ref={(el) => { if (el) refs.current.set(key, el); else refs.current.delete(key); }}
                    type="button"
                    data-testid={`socket-${key}`}
                    data-filled={glyph ? 'true' : 'false'}
                    aria-label={name}
                    aria-pressed={isSelected}
                    tabIndex={key === activeKey ? 0 : -1}
                    draggable={!!glyph}
                    onFocus={() => setFocusKey(key)}
                    onClick={() => { setFocusKey(key); onSelect(socket); }}
                    onKeyDown={(e) => onKey(e, column, columnIndex, augmentIndex, socket, glyph)}
                    onDragStart={glyph ? (e) => { e.dataTransfer.setData(SOCKET_MIME, key); e.dataTransfer.effectAllowed = 'move'; } : undefined}
                    onDragOver={(e) => { if (carries(e.dataTransfer, GLYPH_MIME)) e.preventDefault(); }}
                    onDrop={(e) => dropOn(e, socket)}
                    className="flex flex-col items-center gap-1 rounded-lg p-1 w-full outline-none focus-visible:ring-2 focus-visible:ring-terminal"
                >
                    <GlyphShape kind={kind} id={glyph?.id ?? null} size={isAugment ? 'sm' : 'lg'} selected={isSelected} />
                    <span className={`text-xs text-center leading-tight ${glyph ? 'text-text-primary' : 'text-text-dim'}`}>
                        {glyph ? t(glyphLabelKey(glyph)) : t(`spellbook.kind.${kind}`)}
                    </span>
                    {glyph
                        ? <span className="text-xs font-mono text-text-dim">{t('combat.spellbook.cost', { cost: glyphCost(glyph), label })}</span>
                        : <Plus size={12} aria-hidden="true" className="text-text-dim" />}
                </button>
                {glyph && (
                    <button
                        type="button"
                        tabIndex={-1}
                        aria-label={t('spellbook.socket.remove', { name: t(glyphLabelKey(glyph)) })}
                        onClick={() => onRemove(socket)}
                        className="absolute top-0 right-0 p-0.5 rounded-full bg-surface border border-border text-text-dim hover:text-danger"
                    >
                        <X size={12} aria-hidden="true" />
                    </button>
                )}
            </div>
        );
    };

    return (
        <div data-testid="chain-row" role="group" aria-label={t('spellbook.chain')} className="flex items-start gap-1 overflow-x-auto pb-2">
            {columns.map((column, columnIndex) => (
                <div key={column.key} className="flex items-start gap-1">
                    {columnIndex > 0 && <ChevronRight size={16} aria-hidden="true" className="text-text-dim mt-8 shrink-0" />}
                    <div className="flex flex-col items-center gap-2">
                        {cell(column.owner, column.glyph, column, columnIndex, -1)}
                        {column.augments.length > 0 && (
                            <div className="flex items-start justify-center border-t border-border/60 pt-2">
                                {column.augments.map((a, augmentIndex) => cell(a.socket, a.glyph, column, columnIndex, augmentIndex))}
                            </div>
                        )}
                    </div>
                </div>
            ))}
        </div>
    );
}
