import { useMemo } from 'react';
import { Target } from 'lucide-react';
import { useTranslation } from '../../i18n/useTranslation';
import type { CombatState } from '../../types';
import { objectiveView } from './objectiveText';

const RESULT_COLOR = {
    won: 'var(--combat-hp-good)',
    lost: 'var(--combat-hp-bad)',
    ended: 'var(--combat-hp-warn)',
} as const;

export function CombatObjectiveBanner({ state }: { state: CombatState }) {
    const { t } = useTranslation();
    const view = useMemo(() => objectiveView(state, t), [state, t]);
    if (!view) return null;
    return (
        <section
            data-testid="combat-objective"
            aria-label={t('combat.objective.title')}
            className="flex items-center gap-x-4 gap-y-0.5 flex-wrap px-3 py-1 border-b border-border bg-void text-[11px] font-mono min-w-0"
        >
            <span className="flex items-center gap-1.5 min-w-0">
                <Target size={12} className="shrink-0" style={{ color: 'var(--combat-hp-warn)' }} aria-hidden="true" />
                <span className="uppercase tracking-wider text-text-dim">{t('combat.objective.title')}</span>
                <span data-testid="combat-objective-win" className="text-text-primary font-bold">{view.win}</span>
            </span>
            {view.lose.length > 0 && (
                <span data-testid="combat-objective-lose" className="text-text-dim">{t('combat.objective.lose', { list: view.lose.join(', ') })}</span>
            )}
            {view.side && (
                <span data-testid="combat-objective-side" className="text-text-dim">
                    {t('combat.objective.side', { text: view.side })}
                    {view.sideResult && <span className="ml-1 text-text-primary">({t(`combat.objective.side.${view.sideResult}`)})</span>}
                </span>
            )}
            {view.clock && (
                <span data-testid="combat-objective-clock" role="status" className="font-bold" style={{ color: view.clock.last ? 'var(--combat-hp-bad)' : 'var(--combat-hp-warn)' }}>
                    {view.clock.text}
                </span>
            )}
            {view.holding && <span data-testid="combat-objective-holding" className="text-text-dim">{view.holding}</span>}
            {view.out.length > 0 && <span data-testid="combat-objective-out" className="text-text-dim">{t('combat.objective.out', { names: view.out.join(', ') })}</span>}
            {view.incoming.map((text, i) => (
                <span key={i} data-testid="combat-objective-incoming" className="font-bold" style={{ color: 'var(--combat-enemy)' }}>{text}</span>
            ))}
            {view.result && (
                <span data-testid="combat-objective-result" data-status={view.result.status} role="status" className="font-bold" style={{ color: RESULT_COLOR[view.result.status] }}>
                    {view.result.text}
                </span>
            )}
        </section>
    );
}
