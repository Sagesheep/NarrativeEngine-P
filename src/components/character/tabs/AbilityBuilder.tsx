import { useMemo, useState } from 'react';
import { AUGMENT_IDS, EFFECTS, FORM_IDS, FORMS, abilityCost, describeAbility, validateAbility } from '@narrative/engine';
import type { AbilityLimits, CasterStats } from '@narrative/engine';
import { useTranslation } from '../../../i18n/useTranslation';
import type { AugmentId, EffectId, FormId, GlyphAbility } from '../../../types';
import { AUGMENT_LABEL_KEYS, EFFECT_LABEL_KEYS, FORM_LABEL_KEYS } from './glyphLabels';

export type AbilityBuilderProps = {
    initial: GlyphAbility | null;
    limits: AbilityLimits;
    stats: CasterStats;
    resourceLabel: string;
    onSave: (ability: GlyphAbility) => void;
    onCancel: () => void;
};

function blankAbility(): GlyphAbility {
    return { id: '', name: '', form: { id: 'projectile', augments: [] }, effects: [{ id: 'damage', augments: [] }], source: 'player' };
}

function AugmentChips({ augments, allowed, onChange, label }: {
    augments: AugmentId[];
    allowed: readonly AugmentId[];
    onChange: (next: AugmentId[]) => void;
    label: string;
}) {
    const { t } = useTranslation();
    const options = AUGMENT_IDS.filter(a => allowed.includes(a));
    if (options.length === 0) return null;
    return (
        <div className="flex flex-wrap items-center gap-1">
            {augments.map((a, i) => (
                <button
                    key={`${a}-${i}`}
                    type="button"
                    className="px-1.5 py-0.5 rounded border border-terminal/40 text-terminal text-[10px] hover:border-danger hover:text-danger"
                    onClick={() => onChange(augments.filter((_, j) => j !== i))}
                    aria-label={t('combat.builder.removeAugment', { name: t(AUGMENT_LABEL_KEYS[a]) })}
                >
                    {t(AUGMENT_LABEL_KEYS[a])} ×
                </button>
            ))}
            <select
                className="bg-void border border-border/40 rounded text-[10px] px-1 py-0.5"
                value=""
                aria-label={`${label}: ${t('combat.builder.addAugment')}`}
                onChange={(e) => {
                    const v = e.target.value as AugmentId;
                    if (v) onChange([...augments, v]);
                }}
            >
                <option value="">{t('combat.builder.addAugment')}</option>
                {options.map(a => <option key={a} value={a}>{t(AUGMENT_LABEL_KEYS[a])}</option>)}
            </select>
        </div>
    );
}

export function AbilityBuilder({ initial, limits, stats, resourceLabel, onSave, onCancel }: AbilityBuilderProps) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState<GlyphAbility>(() => initial ? { ...initial, form: { ...initial.form, augments: [...initial.form.augments] }, effects: initial.effects.map(e => ({ ...e, augments: [...e.augments] })) } : blankAbility());
    const reasons = useMemo(() => validateAbility(draft, limits), [draft, limits]);
    const cost = abilityCost(draft);
    const rules = describeAbility(draft, stats);
    const form = FORMS[draft.form.id];
    const addable = form.effects.filter(e => !draft.effects.some(x => x.id === e));

    const setForm = (id: FormId) => setDraft(d => ({
        ...d,
        form: { id, augments: d.form.augments.filter(a => FORMS[id].augments.includes(a)) },
    }));
    const setEffect = (index: number, patch: Partial<GlyphAbility['effects'][number]>) => setDraft(d => ({
        ...d,
        effects: d.effects.map((e, i) => i === index ? { ...e, ...patch } : e),
    }));

    return (
        <div className="border border-terminal/30 rounded p-2 space-y-2 text-[11px]" aria-label={t('combat.builder.title')}>
            <div className="text-[10px] uppercase tracking-wider text-terminal">{t('combat.builder.title')}</div>
            <label className="block">
                <span className="text-text-dim">{t('combat.builder.name')}</span>
                <input
                    className="w-full bg-void border border-border/40 rounded px-1.5 py-1"
                    value={draft.name}
                    maxLength={40}
                    onChange={(e) => setDraft(d => ({ ...d, name: e.target.value }))}
                />
            </label>
            <label className="block">
                <span className="text-text-dim">{t('combat.builder.form')}</span>
                <select
                    className="w-full bg-void border border-border/40 rounded px-1 py-1"
                    value={draft.form.id}
                    onChange={(e) => setForm(e.target.value as FormId)}
                >
                    {FORM_IDS.map(f => <option key={f} value={f}>{t(FORM_LABEL_KEYS[f])}</option>)}
                </select>
            </label>
            <AugmentChips
                augments={draft.form.augments}
                allowed={form.augments}
                label={t(FORM_LABEL_KEYS[draft.form.id])}
                onChange={(augments) => setDraft(d => ({ ...d, form: { ...d.form, augments } }))}
            />
            <div className="space-y-1">
                <span className="text-text-dim">{t('combat.builder.effects')}</span>
                {draft.effects.map((effect, index) => (
                    <div key={`${effect.id}-${index}`} className="border border-border/30 rounded p-1.5 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                            <span>{t(EFFECT_LABEL_KEYS[effect.id])}</span>
                            <button
                                type="button"
                                className="text-text-dim hover:text-danger"
                                onClick={() => setDraft(d => ({ ...d, effects: d.effects.filter((_, i) => i !== index) }))}
                                aria-label={t('combat.builder.removeEffect', { name: t(EFFECT_LABEL_KEYS[effect.id]) })}
                            >
                                ×
                            </button>
                        </div>
                        <AugmentChips
                            augments={effect.augments}
                            allowed={EFFECTS[effect.id].augments}
                            label={t(EFFECT_LABEL_KEYS[effect.id])}
                            onChange={(augments) => setEffect(index, { augments })}
                        />
                    </div>
                ))}
                {addable.length > 0 && (
                    <select
                        className="bg-void border border-border/40 rounded px-1 py-1"
                        value=""
                        aria-label={t('combat.builder.addEffect')}
                        onChange={(e) => {
                            const v = e.target.value as EffectId;
                            if (v) setDraft(d => ({ ...d, effects: [...d.effects, { id: v, augments: [] }] }));
                        }}
                    >
                        <option value="">{t('combat.builder.addEffect')}</option>
                        {addable.map(e => <option key={e} value={e}>{t(EFFECT_LABEL_KEYS[e])}</option>)}
                    </select>
                )}
            </div>
            <label className="block">
                <span className="text-text-dim">{t('combat.builder.damageType')}</span>
                <input
                    className="w-full bg-void border border-border/40 rounded px-1.5 py-1"
                    value={draft.damageType ?? ''}
                    maxLength={24}
                    onChange={(e) => setDraft(d => ({ ...d, damageType: e.target.value }))}
                />
            </label>
            <label className="block">
                <span className="text-text-dim">{t('combat.builder.description')}</span>
                <textarea
                    className="w-full bg-void border border-border/40 rounded px-1.5 py-1"
                    rows={2}
                    maxLength={400}
                    value={draft.description ?? ''}
                    onChange={(e) => setDraft(d => ({ ...d, description: e.target.value }))}
                />
            </label>
            <div className="text-terminal" data-testid="builder-cost">{t('combat.builder.cost', { cost, label: resourceLabel })}</div>
            <div>
                <span className="text-text-dim">{t('combat.builder.rules')}: </span>
                <span data-testid="builder-rules">{rules}</span>
            </div>
            {reasons.length > 0 && (
                <div className="text-danger" role="alert">
                    <div>{t('combat.builder.invalid')}</div>
                    <ul className="list-disc pl-4">
                        {reasons.map(r => <li key={r}>{r}</li>)}
                    </ul>
                </div>
            )}
            <div className="flex gap-2 justify-end">
                <button type="button" className="px-2 py-1 border border-border/40 rounded" onClick={onCancel}>{t('combat.builder.cancel')}</button>
                <button
                    type="button"
                    className="px-2 py-1 border border-terminal/60 text-terminal rounded disabled:opacity-40"
                    disabled={reasons.length > 0}
                    onClick={() => onSave(draft)}
                >
                    {t('combat.builder.save')}
                </button>
            </div>
        </div>
    );
}
