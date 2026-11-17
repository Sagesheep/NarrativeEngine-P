import { elementsFor, isMindless } from '@narrative/engine';
import type { ElementId, ElementPresetId } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import type { ProposedCombatant } from '../../types';
import { ELEMENT_RELATIONS, elementName, relationOf, setRelation } from './elementText';
import type { ElementRelation } from './elementText';

const selectClass = 'bg-void border border-border px-1 py-0.5 text-[10px] font-mono text-text-primary focus:border-terminal outline-none';

export function CombatElementFields({ combatant, index, preset, onChange }: {
    combatant: ProposedCombatant;
    index: number;
    preset: ElementPresetId;
    onChange: (patch: Partial<ProposedCombatant>) => void;
}) {
    const { t } = useTranslation();
    const list = elementsFor(preset);
    const parts = (['weak', 'resist', 'immune'] as const)
        .map(field => {
            const values = combatant[field] ?? [];
            return values.length > 0 ? t(`combat.elements.part.${field}`, { list: values.map(e => elementName(e, t)).join(', ') }) : '';
        })
        .filter(Boolean);
    const summary = parts.length > 0 ? parts.join('; ') : t('combat.elements.none');
    const mindless = isMindless({ mindless: combatant.mindless, species: combatant.species });
    return (
        <details data-testid={`combat-elements-${index}`} className="text-[10px] text-text-dim">
            <summary className="cursor-pointer select-none">
                {t('combat.elements.title')}: <span data-testid={`combat-elements-summary-${index}`}>{summary}</span>
            </summary>
            <div className="mt-1 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-1">
                {list.map(element => (
                    <label key={element} className="flex items-center justify-between gap-1">
                        <span className="truncate">{elementName(element, t)}</span>
                        <select
                            aria-label={t('combat.elements.relationFor', { element: elementName(element, t), name: combatant.name })}
                            data-testid={`combat-element-${index}-${element}`}
                            className={selectClass}
                            value={relationOf(combatant, element)}
                            onChange={(e) => onChange(setRelation(combatant, element, e.target.value as ElementRelation))}
                        >
                            {ELEMENT_RELATIONS.map(r => <option key={r} value={r}>{t(`combat.elements.relation.${r}`)}</option>)}
                        </select>
                    </label>
                ))}
            </div>
            <div className="mt-1 flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-1" title={t('combat.elements.mindlessHelp')}>
                    <input
                        type="checkbox"
                        data-testid={`combat-mindless-${index}`}
                        aria-label={t('combat.elements.mindlessFor', { name: combatant.name })}
                        checked={mindless}
                        onChange={(e) => onChange({ mindless: e.target.checked })}
                    />
                    {t('combat.elements.mindless')}
                </label>
                <label className="flex items-center gap-1">
                    {t('combat.elements.casterElement')}
                    <select
                        aria-label={t('combat.elements.casterElementFor', { name: combatant.name })}
                        data-testid={`combat-caster-element-${index}`}
                        className={selectClass}
                        value={combatant.element && list.includes(combatant.element) ? combatant.element : ''}
                        onChange={(e) => onChange({ element: (e.target.value || undefined) as ElementId | undefined })}
                    >
                        <option value="">{t('combat.elements.noElement')}</option>
                        {list.map(element => <option key={element} value={element}>{elementName(element, t)}</option>)}
                    </select>
                </label>
            </div>
        </details>
    );
}
