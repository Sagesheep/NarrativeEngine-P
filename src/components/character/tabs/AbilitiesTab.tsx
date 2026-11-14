import { useEffect, useMemo } from 'react';
import { BookOpen } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import { useTranslation } from '../../../i18n/useTranslation';
import { commitCombatPatch, remirrorCombatSheet } from '../../../services/combat/combatSheet';
import { configOf, sheetCasterStats, sheetMaxMp, spellbookOf } from '../../../services/combat/spellbook';
import { AbilityCard } from '../../spellbook/AbilityCard';

export function AbilitiesTab() {
    const { t } = useTranslation();
    const context = useAppStore((s) => s.context);
    const setSpellbookOpen = useAppStore((s) => s.setSpellbookOpen);

    useEffect(() => {
        const store = useAppStore.getState();
        commitCombatPatch(store, remirrorCombatSheet(store.context));
    }, []);

    const book = useMemo(() => spellbookOf(context), [context]);
    const config = useMemo(() => configOf(context), [context]);
    const stats = useMemo(() => sheetCasterStats(context.combatSheet), [context.combatSheet]);
    const label = config.resourceLabel;
    const equipped = book.equippedIds
        .map(id => book.abilities.find(a => a.id === id))
        .filter((a): a is NonNullable<typeof a> => !!a);

    return (
        <div className="p-4 flex flex-col gap-4">
            <div className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-xs font-mono uppercase tracking-wider text-text-dim">{t('combat.spellbook.tab')}</h3>
                    <span className="text-xs font-mono text-terminal whitespace-nowrap" data-testid="spellbook-mp">
                        {t('combat.spellbook.mp', { label, max: sheetMaxMp(context.combatSheet) })}
                    </span>
                </div>
                <p className="text-xs text-text-dim leading-relaxed">{t('combat.spellbook.help')}</p>
            </div>
            <button
                type="button"
                onClick={() => setSpellbookOpen(true)}
                className="flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold rounded border border-terminal/60 text-terminal hover:bg-terminal/10 outline-none focus-visible:ring-2 focus-visible:ring-terminal"
            >
                <BookOpen size={14} aria-hidden="true" />
                {t('spellbook.open')}
            </button>
            <section className="flex flex-col gap-2" aria-labelledby="abilities-hotbar-heading">
                <div className="flex items-baseline justify-between gap-2">
                    <h3 id="abilities-hotbar-heading" className="text-xs font-mono uppercase tracking-wider text-text-dim">{t('spellbook.hotbar')}</h3>
                    <span className="text-xs text-text-dim">{t('combat.spellbook.equippedCount', { count: equipped.length, max: config.maxEquippedAbilities })}</span>
                </div>
                {equipped.length === 0 ? (
                    <p className="text-xs text-text-dim leading-relaxed">{book.abilities.length === 0 ? t('combat.spellbook.empty') : t('spellbook.summary.none')}</p>
                ) : (
                    <ul className="grid gap-2 sm:grid-cols-2">
                        {equipped.map((ability, index) => (
                            <li key={ability.id}>
                                <AbilityCard ability={ability} stats={stats} label={label} showRules equipped slotKey={index < 9 ? index + 1 : undefined} testId={`ability-${ability.id}`} />
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </div>
    );
}
