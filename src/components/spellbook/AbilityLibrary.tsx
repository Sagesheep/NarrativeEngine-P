import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { STARTER_ABILITIES } from '@narrative/engine';
import type { CasterStats } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import { equipBlocker } from '../../services/combat/spellbook';
import type { CombatSettings, GlyphAbility, Spellbook } from '../../types';
import { AbilityCard } from './AbilityCard';
import { ABILITY_MIME } from './dnd';
import { Hotbar } from './Hotbar';

const smallButton = 'inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded border outline-none focus-visible:ring-2 focus-visible:ring-terminal disabled:opacity-40 disabled:cursor-not-allowed';

export function AbilityLibrary({
    book, config, stats, label, selectedId, onSelect, onNew, onAddPreset, onToggleEquip, onEquipAt, onReorder, onUnequip, onDelete,
}: {
    book: Spellbook;
    config: CombatSettings;
    stats: CasterStats;
    label: string;
    selectedId: string | null;
    onSelect: (id: string) => void;
    onNew: () => void;
    onAddPreset: (preset: GlyphAbility) => void;
    onToggleEquip: (id: string) => void;
    onEquipAt: (id: string, slot: number) => void;
    onReorder: (from: number, to: number) => void;
    onUnequip: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    const { t } = useTranslation();
    const [confirmId, setConfirmId] = useState<string | null>(null);
    const lookup = useMemo(() => new Map(book.abilities.map(a => [a.id, a])), [book.abilities]);
    return (
        <div className="flex flex-col gap-5 min-w-0">
            <section className="flex flex-col gap-2" aria-labelledby="spellbook-hotbar-heading">
                <div className="flex items-baseline justify-between gap-2">
                    <h3 id="spellbook-hotbar-heading" className="text-xs font-mono uppercase tracking-wider text-text-dim">{t('spellbook.hotbar')}</h3>
                    <span className="text-xs text-text-dim" data-testid="spellbook-equipped-count">{t('combat.spellbook.equippedCount', { count: book.equippedIds.length, max: config.maxEquippedAbilities })}</span>
                </div>
                <Hotbar ids={book.equippedIds} max={config.maxEquippedAbilities} abilities={lookup} selectedId={selectedId} onSelect={onSelect} onEquipAt={onEquipAt} onReorder={onReorder} onUnequip={onUnequip} />
                <p className="text-xs text-text-dim leading-relaxed">{t('spellbook.hotbar.help')}</p>
            </section>
            <section className="flex flex-col gap-2" aria-labelledby="spellbook-list-heading">
                <div className="flex items-center justify-between gap-2">
                    <h3 id="spellbook-list-heading" className="text-xs font-mono uppercase tracking-wider text-text-dim">{t('spellbook.abilities')}</h3>
                    <button type="button" onClick={onNew} className={`${smallButton} border-terminal/60 text-terminal hover:bg-terminal/10`}>
                        <Plus size={14} aria-hidden="true" />{t('combat.spellbook.new')}
                    </button>
                </div>
                {book.abilities.length === 0 && (
                    <div className="flex flex-col gap-2">
                        <p className="text-xs text-text-dim leading-relaxed">{t('combat.spellbook.empty')}</p>
                        <h4 className="text-xs font-mono uppercase tracking-wider text-text-dim mt-1">{t('combat.spellbook.presets')}</h4>
                        <ul className="flex flex-col gap-2">
                            {STARTER_ABILITIES.map(preset => (
                                <li key={preset.id}>
                                    <AbilityCard
                                        ability={preset}
                                        stats={stats}
                                        label={label}
                                        showRules
                                        testId={`preset-${preset.id}`}
                                        actions={(
                                            <button type="button" onClick={() => onAddPreset(preset)} className={`${smallButton} border-terminal/60 text-terminal hover:bg-terminal/10`}>
                                                <Plus size={14} aria-hidden="true" />{t('combat.spellbook.addPreset', { name: preset.name })}
                                            </button>
                                        )}
                                    />
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
                <ul className="flex flex-col gap-2">
                    {book.abilities.map(ability => {
                        const equipped = book.equippedIds.includes(ability.id);
                        const blocker = equipped ? null : equipBlocker(book, ability, config);
                        const notice = blocker === 'full'
                            ? t('combat.spellbook.equipFull', { max: config.maxEquippedAbilities })
                            : blocker ? t('combat.spellbook.cannotEquip', { reason: blocker }) : null;
                        return (
                            <li key={ability.id}>
                                <AbilityCard
                                    ability={ability}
                                    stats={stats}
                                    label={label}
                                    selected={ability.id === selectedId}
                                    equipped={equipped}
                                    notice={notice}
                                    testId={`ability-${ability.id}`}
                                    slotKey={equipped && book.equippedIds.indexOf(ability.id) < 9 ? book.equippedIds.indexOf(ability.id) + 1 : undefined}
                                    onSelect={() => onSelect(ability.id)}
                                    dragProps={blocker === null || equipped ? {
                                        draggable: true,
                                        onDragStart: (e) => { e.dataTransfer.setData(ABILITY_MIME, ability.id); e.dataTransfer.effectAllowed = 'move'; },
                                    } : undefined}
                                    actions={(
                                        <>
                                            <button
                                                type="button"
                                                disabled={!equipped && !!blocker}
                                                onClick={() => onToggleEquip(ability.id)}
                                                aria-label={`${t(equipped ? 'spellbook.unequip' : 'spellbook.equipAction')}: ${ability.name}`}
                                                className={`${smallButton} ${equipped ? 'border-border text-text-primary hover:bg-void-lighter' : 'border-terminal/60 text-terminal hover:bg-terminal/10'}`}
                                            >
                                                {t(equipped ? 'spellbook.unequip' : 'spellbook.equipAction')}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    if (confirmId === ability.id) {
                                                        setConfirmId(null);
                                                        onDelete(ability.id);
                                                    } else {
                                                        setConfirmId(ability.id);
                                                    }
                                                }}
                                                onBlur={() => setConfirmId(null)}
                                                aria-label={`${t(confirmId === ability.id ? 'spellbook.deleteConfirm' : 'combat.spellbook.delete')}: ${ability.name}`}
                                                className={`${smallButton} ml-auto border-border ${confirmId === ability.id ? 'text-danger border-danger/60' : 'text-text-dim hover:text-danger'}`}
                                            >
                                                <Trash2 size={14} aria-hidden="true" />
                                                {confirmId === ability.id ? t('spellbook.deleteConfirm') : t('combat.spellbook.delete')}
                                            </button>
                                        </>
                                    )}
                                />
                            </li>
                        );
                    })}
                </ul>
            </section>
        </div>
    );
}
