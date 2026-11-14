import { useMemo } from 'react';
import { GLYPH_NUMBERS, chainCost, chainCount } from '@narrative/engine';
import type { AbilityLimits, CasterStats, GlyphRef, Socket } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import { FIELD_LIMITS } from '../../services/combat/spellbook';
import { ChainRow } from './ChainRow';
import { ChainSummary } from './ChainSummary';
import { TargetPreview } from './TargetPreview';
import { toAbility } from './draft';
import type { AbilityDraft } from './draft';

const inputClass = 'w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary outline-none focus:border-terminal';

export function ChainWorkbench({ draft, onChange, selected, onSelect, onRemove, onDropGlyph, status, stats, limits, maxMp, label }: {
    draft: AbilityDraft;
    onChange: (patch: Partial<AbilityDraft>) => void;
    selected: Socket | null;
    onSelect: (socket: Socket) => void;
    onRemove: (socket: Socket) => void;
    onDropGlyph: (socket: Socket, glyph: GlyphRef) => void;
    status: string;
    stats: CasterStats;
    limits: AbilityLimits;
    maxMp: number;
    label: string;
}) {
    const { t } = useTranslation();
    const ability = useMemo(() => toAbility(draft), [draft]);
    const hasForm = draft.chain.form.id !== null;
    const previewable = hasForm && draft.chain.effects.length > 0;
    return (
        <div className="flex flex-col gap-5 min-w-0">
            <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                    <span className="text-xs font-mono uppercase tracking-wider text-text-dim">{t('combat.builder.name')}</span>
                    <input value={draft.name} maxLength={GLYPH_NUMBERS.nameMax} onChange={(e) => onChange({ name: e.target.value })} className={inputClass} />
                </label>
                <label className="flex flex-col gap-1">
                    <span className="text-xs font-mono uppercase tracking-wider text-text-dim">{t('combat.builder.damageType')}</span>
                    <input value={draft.damageType} maxLength={FIELD_LIMITS.damageType} onChange={(e) => onChange({ damageType: e.target.value })} className={inputClass} />
                </label>
                <label className="flex flex-col gap-1 sm:col-span-2">
                    <span className="text-xs font-mono uppercase tracking-wider text-text-dim">{t('combat.builder.description')}</span>
                    <textarea rows={2} value={draft.description} maxLength={FIELD_LIMITS.description} onChange={(e) => onChange({ description: e.target.value })} className={`${inputClass} resize-y`} />
                </label>
            </div>
            <section className="flex flex-col gap-2" aria-labelledby="spellbook-chain-heading">
                <h3 id="spellbook-chain-heading" className="text-xs font-mono uppercase tracking-wider text-text-dim">{t('spellbook.chain')}</h3>
                <ChainRow chain={draft.chain} selected={selected} label={label} onSelect={onSelect} onRemove={onRemove} onDropGlyph={onDropGlyph} />
                <p data-testid="spellbook-status" role="status" aria-live="polite" className="text-xs text-text-dim leading-relaxed min-h-[1.25rem]">
                    {status || t('spellbook.chain.help')}
                </p>
            </section>
            <div className="flex flex-wrap gap-5">
                <div className="flex-1 min-w-[15rem]">
                    <ChainSummary ability={ability} hasForm={hasForm} cost={chainCost(draft.chain)} count={chainCount(draft.chain)} stats={stats} limits={limits} maxMp={maxMp} label={label} />
                </div>
                <section className="shrink-0 w-full sm:w-[15rem] flex flex-col gap-2" aria-labelledby="spellbook-preview-heading">
                    <h3 id="spellbook-preview-heading" className="text-xs font-mono uppercase tracking-wider text-text-dim">{t('spellbook.preview')}</h3>
                    <TargetPreview ability={previewable ? ability : null} />
                </section>
            </div>
        </div>
    );
}
