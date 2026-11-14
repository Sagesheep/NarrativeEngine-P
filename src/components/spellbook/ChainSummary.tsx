import { describeAbility, validateAbility } from '@narrative/engine';
import type { AbilityLimits, CasterStats } from '@narrative/engine';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import type { GlyphAbility } from '../../types';

export function ChainSummary({ ability, hasForm, cost, count, stats, limits, maxMp, label }: {
    ability: GlyphAbility;
    hasForm: boolean;
    cost: number;
    count: number;
    stats: CasterStats;
    limits: AbilityLimits;
    maxMp: number;
    label: string;
}) {
    const { t } = useTranslation();
    const reasons = validateAbility(ability, limits);
    const over = maxMp > 0 && cost > maxMp;
    const pct = maxMp > 0 ? Math.min(100, Math.round((cost / maxMp) * 100)) : 0;
    return (
        <div data-testid="chain-summary" className="flex flex-col gap-3 min-w-0">
            <div className="flex flex-col gap-1">
                <h3 className="text-xs font-mono uppercase tracking-wider text-text-dim">{t('spellbook.rules')}</h3>
                <p data-testid="builder-rules" className="text-sm text-text-primary leading-relaxed">
                    {hasForm ? describeAbility(ability, stats) : t('spellbook.rules.empty')}
                </p>
            </div>
            <div className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span data-testid="builder-cost" className={`font-mono ${over ? 'text-danger' : 'text-terminal'}`}>
                        {t('spellbook.meter', { cost, max: maxMp, label })}
                    </span>
                    <span data-testid="builder-count" className="font-mono text-text-dim">{t('spellbook.glyphCount', { count, limit: limits.maxChainLength })}</span>
                </div>
                <div
                    role="meter"
                    aria-label={t('spellbook.meter.label', { label })}
                    aria-valuemin={0}
                    aria-valuemax={maxMp}
                    aria-valuenow={Math.min(cost, maxMp)}
                    className="h-2 rounded-full overflow-hidden bg-void-lighter"
                >
                    <div className="h-full rounded-full transition-[width]" style={{ width: `${pct}%`, background: over ? 'var(--combat-hp-bad)' : 'var(--color-terminal)' }} />
                </div>
                {over && <p className="text-xs text-danger leading-relaxed">{t('spellbook.meter.over', { max: maxMp, label })}</p>}
            </div>
            {reasons.length > 0 && (
                <div data-testid="builder-reasons" role="alert" className="rounded-lg border border-danger/40 bg-danger/5 p-3 flex flex-col gap-1.5">
                    <p className="flex items-center gap-1.5 text-xs font-bold text-danger"><AlertTriangle size={14} aria-hidden="true" />{t('combat.builder.invalid')}</p>
                    <ul className="list-disc pl-5 text-xs text-text-primary leading-relaxed">
                        {reasons.map(r => <li key={r}>{r}</li>)}
                    </ul>
                </div>
            )}
        </div>
    );
}
