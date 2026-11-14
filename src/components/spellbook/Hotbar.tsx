import type { DragEvent } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import type { GlyphAbility } from '../../types';
import { ABILITY_MIME, SLOT_MIME, carries, readTransfer } from './dnd';
import { GlyphShape } from './GlyphShape';

const MAX_KEYED_SLOTS = 9;

export function Hotbar({ ids, max, abilities, selectedId, onSelect, onEquipAt, onReorder, onUnequip }: {
    ids: readonly string[];
    max: number;
    abilities: ReadonlyMap<string, GlyphAbility>;
    selectedId: string | null;
    onSelect: (id: string) => void;
    onEquipAt: (id: string, slot: number) => void;
    onReorder: (from: number, to: number) => void;
    onUnequip: (id: string) => void;
}) {
    const { t } = useTranslation();
    const accepts = (e: DragEvent) => carries(e.dataTransfer, ABILITY_MIME) || carries(e.dataTransfer, SLOT_MIME);
    const drop = (e: DragEvent, slot: number) => {
        if (!accepts(e)) return;
        e.preventDefault();
        const fromSlot = readTransfer(e.dataTransfer, SLOT_MIME);
        if (fromSlot !== null) {
            onReorder(Number(fromSlot), slot);
            return;
        }
        const id = readTransfer(e.dataTransfer, ABILITY_MIME);
        if (id) onEquipAt(id, slot);
    };
    return (
        <ol data-testid="hotbar" aria-label={t('spellbook.hotbar')} className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
            {Array.from({ length: max }, (_, slot) => {
                const id = ids[slot];
                const ability = id ? abilities.get(id) : undefined;
                const key = slot < MAX_KEYED_SLOTS ? String(slot + 1) : '';
                return (
                    <li
                        key={slot}
                        data-testid={`hotbar-slot-${slot}`}
                        draggable={!!ability}
                        onDragStart={ability ? (e) => { e.dataTransfer.setData(SLOT_MIME, String(slot)); e.dataTransfer.effectAllowed = 'move'; } : undefined}
                        onDragOver={(e) => { if (accepts(e)) e.preventDefault(); }}
                        onDrop={(e) => drop(e, slot)}
                        className={`relative flex flex-col items-center gap-1 rounded-lg border px-2 pt-5 pb-2 min-h-[5.5rem] ${ability ? (id === selectedId ? 'border-terminal bg-terminal/10' : 'border-border bg-void') : 'border-dashed border-border'}`}
                    >
                        <span className="absolute top-1 left-2 text-xs font-mono text-text-dim">{key}</span>
                        {ability ? (
                            <>
                                <button
                                    type="button"
                                    onClick={() => onSelect(ability.id)}
                                    aria-label={t('spellbook.hotbar.slot', { n: slot + 1, name: ability.name })}
                                    className="flex flex-col items-center gap-1 min-w-0 w-full rounded outline-none focus-visible:ring-2 focus-visible:ring-terminal"
                                >
                                    <GlyphShape kind="effect" id={ability.effects[0]?.id ?? null} size="md" />
                                    <span className="text-xs text-text-primary text-center leading-tight break-words w-full line-clamp-2">{ability.name}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onUnequip(ability.id)}
                                    aria-label={t('spellbook.hotbar.clear', { name: ability.name })}
                                    className="absolute top-1 right-1 p-0.5 rounded text-text-dim hover:text-danger focus-visible:ring-2 focus-visible:ring-terminal outline-none"
                                >
                                    <X size={14} aria-hidden="true" />
                                </button>
                            </>
                        ) : (
                            <span className="text-xs text-text-dim mt-2">{t('spellbook.hotbar.empty')}</span>
                        )}
                    </li>
                );
            })}
        </ol>
    );
}
