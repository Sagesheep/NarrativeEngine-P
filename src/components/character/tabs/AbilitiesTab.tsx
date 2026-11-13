import { useEffect, useMemo, useState } from 'react';
import { STARTER_ABILITIES, describeAbility, validateAbility, abilitySlot } from '@narrative/engine';
import { useAppStore } from '../../../store/useAppStore';
import { useTranslation } from '../../../i18n/useTranslation';
import { commitCombatPatch, remirrorCombatSheet } from '../../../services/combat/combatSheet';
import {
    addAsNew, configOf, costOf, equipBlocker, limitsOf, removeAbility, sheetCasterStats, sheetMaxMp, spellbookOf, toggleEquipped,
    upsertAbility,
} from '../../../services/combat/spellbook';
import type { GlyphAbility, Spellbook } from '../../../types';
import { AbilityBuilder } from './AbilityBuilder';

type Editing = { mode: 'new' } | { mode: 'edit'; ability: GlyphAbility } | null;

export function AbilitiesTab() {
    const { t } = useTranslation();
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const editDraft = useAppStore((s) => s.abilityEditDraft);
    const setEditDraft = useAppStore((s) => s.setAbilityEditDraft);
    const [editing, setEditing] = useState<Editing>(null);

    useEffect(() => {
        const store = useAppStore.getState();
        commitCombatPatch(store, remirrorCombatSheet(store.context));
    }, []);

    const book = useMemo(() => spellbookOf(context), [context]);
    const config = useMemo(() => configOf(context), [context]);
    const limits = useMemo(() => limitsOf(config), [config]);
    const stats = useMemo(() => sheetCasterStats(context.combatSheet), [context.combatSheet]);
    const label = config.resourceLabel;

    const save = (next: Spellbook) => updateContext({ spellbook: next });

    const builderInitial = editDraft ?? (editing?.mode === 'edit' ? editing.ability : null);
    const builderOpen = !!editDraft || editing !== null;

    const onBuilderSave = (ability: GlyphAbility) => {
        if (editDraft) {
            save(addAsNew(book, ability, 'ai'));
            setEditDraft(null);
        } else if (editing?.mode === 'edit') {
            save(upsertAbility(book, { ...ability, id: editing.ability.id }));
        } else {
            save(addAsNew(book, ability, 'player'));
        }
        setEditing(null);
    };

    const onBuilderCancel = () => {
        if (editDraft) setEditDraft(null);
        setEditing(null);
    };

    return (
        <div className="p-3 space-y-3 text-[11px]">
            <div className="flex items-center justify-between gap-2">
                <div className="text-text-dim">{t('combat.spellbook.help')}</div>
                <div className="text-terminal whitespace-nowrap" data-testid="spellbook-mp">
                    {t('combat.spellbook.mp', { label, max: sheetMaxMp(context.combatSheet) })}
                </div>
            </div>
            <div className="text-text-dim">{t('combat.spellbook.equippedCount', { count: book.equippedIds.length, max: config.maxEquippedAbilities })}</div>

            {builderOpen ? (
                <AbilityBuilder
                    key={builderInitial?.id ?? 'new'}
                    initial={builderInitial}
                    limits={limits}
                    stats={stats}
                    resourceLabel={label}
                    onSave={onBuilderSave}
                    onCancel={onBuilderCancel}
                />
            ) : (
                <button type="button" className="px-2 py-1 border border-terminal/60 text-terminal rounded" onClick={() => setEditing({ mode: 'new' })}>
                    {t('combat.spellbook.new')}
                </button>
            )}

            {book.abilities.length === 0 && !builderOpen && (
                <div className="space-y-1">
                    <div>{t('combat.spellbook.empty')}</div>
                    <div className="text-text-dim uppercase tracking-wider text-[9px]">{t('combat.spellbook.presets')}</div>
                    <div className="flex flex-wrap gap-1">
                        {STARTER_ABILITIES.map(preset => (
                            <button
                                key={preset.id}
                                type="button"
                                className="px-2 py-0.5 border border-border/40 rounded hover:border-terminal"
                                onClick={() => save(addAsNew(spellbookOf(useAppStore.getState().context), preset, 'preset'))}
                            >
                                {t('combat.spellbook.addPreset', { name: preset.name })}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <ul className="space-y-1.5">
                {book.abilities.map(ability => {
                    const equipped = book.equippedIds.includes(ability.id);
                    const blocker = equipped ? null : equipBlocker(book, ability, config);
                    const invalid = validateAbility(ability, limits);
                    const title = blocker === 'full'
                        ? t('combat.spellbook.equipFull', { max: config.maxEquippedAbilities })
                        : blocker ? t('combat.spellbook.cannotEquip', { reason: blocker }) : undefined;
                    return (
                        <li key={ability.id} className="border border-border/30 rounded px-2 py-1.5 space-y-1" data-testid={`ability-${ability.id}`}>
                            <div className="flex items-center gap-2">
                                <label className="flex items-center gap-1" title={title}>
                                    <input
                                        type="checkbox"
                                        checked={equipped}
                                        disabled={!equipped && !!blocker}
                                        onChange={() => save(toggleEquipped(book, ability.id, config))}
                                        aria-label={`${t('combat.spellbook.equip')}: ${ability.name}`}
                                    />
                                </label>
                                <span className="font-medium flex-1 truncate">{ability.name}</span>
                                <span className="text-terminal whitespace-nowrap">{t('combat.spellbook.cost', { cost: costOf(ability), label })}</span>
                                {abilitySlot(ability) === 'bonus' && <span className="text-text-dim">{t('combat.spellbook.bonus')}</span>}
                                <button type="button" className="text-text-dim hover:text-text-primary" onClick={() => setEditing({ mode: 'edit', ability })}>
                                    {t('combat.spellbook.edit')}
                                </button>
                                <button type="button" className="text-text-dim hover:text-danger" onClick={() => save(removeAbility(book, ability.id))}>
                                    {t('combat.spellbook.delete')}
                                </button>
                            </div>
                            <div className="text-text-dim">{describeAbility(ability, stats)}</div>
                            {ability.description && <div className="italic text-text-dim">{ability.description}</div>}
                            {invalid.length > 0 && <div className="text-danger">{t('combat.spellbook.cannotEquip', { reason: invalid.join('; ') })}</div>}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}
