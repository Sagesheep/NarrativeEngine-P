import { LOSE_KINDS, REINFORCEMENT_LEVELS, SIDE_KINDS, WIN_KINDS } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import type { LoseKind, ProposedCombatant, ProposedObjective, ReinforcementLevel, SideKind, WinKind } from '../../types';
import { isPlainObjective, needsBystander, needsLeader, needsWard } from '../../services/combat/combatObjective';

const selectClass = 'bg-void border border-border px-1.5 py-0.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none';
const numberClass = 'w-14 bg-void border border-border px-1.5 py-0.5 text-[11px] font-mono text-text-primary focus:border-terminal outline-none';

const FORM_LOSE_KINDS: readonly LoseKind[] = LOSE_KINDS.filter(k => k !== 'ward_falls');
const PAIRED_KINDS: readonly WinKind[] = WIN_KINDS.filter(k => k !== 'protect');

const LOSE_LABEL = {
    pc_falls: 'combat.objective.form.losePc',
    round_limit: 'combat.objective.form.loseRound',
    leader_escapes: 'combat.objective.form.loseLeader',
} as const;

function intOf(raw: string): number | undefined {
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
}

export function CombatObjectiveForm({
    roster,
    objective,
    onChange,
}: {
    roster: readonly ProposedCombatant[];
    objective: ProposedObjective | undefined;
    onChange: (next: ProposedObjective | undefined) => void;
}) {
    const { t } = useTranslation();
    const current: ProposedObjective = objective ?? { win: 'rout' };
    const win = (WIN_KINDS as readonly string[]).includes(current.win) ? current.win as WinKind : 'rout';
    const enemies = roster.filter(c => c.side === 'enemy');
    const allies = roster.filter(c => c.side === 'ally');
    const neutrals = roster.filter(c => c.side === 'neutral');
    const lose = current.lose ?? [];

    const commit = (next: ProposedObjective) => {
        const kept = Object.entries(next).filter(([, value]) => value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0));
        const cleaned = Object.fromEntries(kept) as ProposedObjective;
        onChange(isPlainObjective(cleaned) ? undefined : cleaned);
    };
    const patch = (p: Partial<ProposedObjective>) => commit({ ...current, ...p });

    const setWin = (kind: WinKind) => {
        const next: ProposedObjective = { ...current, win: kind };
        if (kind !== 'protect') delete next.with;
        if (kind !== 'escape') delete next.everyone;
        if (kind !== 'survive' && kind !== 'protect') delete next.rounds;
        if (kind === 'rout') delete next.reinforcements;
        commit(next);
    };

    const toggleLose = (kind: LoseKind, on: boolean) => {
        const next = on ? [...lose.filter(k => k !== kind), kind] : lose.filter(k => k !== kind);
        patch({ lose: next, ...(kind === 'round_limit' && !on ? { roundLimit: undefined } : {}) });
    };

    const showRounds = win === 'survive' || (win === 'protect' && (!current.with || current.with === 'survive'));
    const showLimit = lose.includes('round_limit');
    const sideKind = (SIDE_KINDS as readonly string[]).includes(current.side ?? '') ? current.side as SideKind : '';
    const row = 'flex items-center gap-2 flex-wrap';
    const label = 'text-[10px] font-mono uppercase tracking-wider text-text-dim';

    return (
        <fieldset data-testid="combat-objective-form" className="space-y-1.5 border border-border rounded-sm px-2 py-1.5 min-w-0">
            <legend className={`${label} px-1`}>{t('combat.objective.form.title')}</legend>
            <div className={row}>
                <select aria-label={t('combat.objective.form.kind')} data-testid="combat-objective-kind" className={selectClass} value={win} onChange={e => setWin(e.target.value as WinKind)}>
                    {WIN_KINDS.map(k => <option key={k} value={k}>{t(`combat.objective.kind.${k}`)}</option>)}
                </select>
                {win === 'protect' && (
                    <select aria-label={t('combat.objective.form.with')} className={selectClass} value={current.with ?? ''} onChange={e => patch({ with: e.target.value || undefined })}>
                        <option value="">{t('combat.objective.form.withNone')}</option>
                        {PAIRED_KINDS.map(k => <option key={k} value={k}>{t(`combat.objective.kind.${k}`)}</option>)}
                    </select>
                )}
                {showRounds && (
                    <label className={`${label} flex items-center gap-1`}>
                        {t('combat.objective.form.rounds')}
                        <input type="number" min={2} max={8} className={numberClass} value={current.rounds ?? ''} onChange={e => patch({ rounds: intOf(e.target.value) })} />
                    </label>
                )}
                {win === 'escape' && (
                    <label className={`${label} flex items-center gap-1 normal-case`}>
                        <input type="checkbox" checked={current.everyone === true} onChange={e => patch({ everyone: e.target.checked || undefined })} />
                        {t('combat.objective.form.everyone')}
                    </label>
                )}
            </div>
            {needsLeader(current) && (
                <div className={row}>
                    <span className={label}>{t('combat.objective.form.leader')}</span>
                    <select aria-label={t('combat.objective.form.leader')} data-testid="combat-objective-leader" className={selectClass} value={current.leader ?? ''} onChange={e => patch({ leader: e.target.value || undefined })}>
                        <option value="">{t('combat.objective.form.leaderAuto')}</option>
                        {enemies.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                </div>
            )}
            {needsWard(current) && (
                <div className={row}>
                    <span className={label}>{t('combat.objective.form.ward')}</span>
                    <select aria-label={t('combat.objective.form.ward')} data-testid="combat-objective-ward" className={selectClass} value={current.ward ?? ''} onChange={e => patch({ ward: e.target.value || undefined })}>
                        <option value="">{t('combat.objective.form.wardNew')}</option>
                        {allies.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                </div>
            )}
            <div className={row}>
                <span className={label}>{t('combat.objective.form.lose')}</span>
                {FORM_LOSE_KINDS.map(kind => (
                    <label key={kind} className="flex items-center gap-1 text-[11px] font-mono text-text-primary">
                        <input type="checkbox" checked={lose.includes(kind)} onChange={e => toggleLose(kind, e.target.checked)} />
                        {t(LOSE_LABEL[kind as keyof typeof LOSE_LABEL])}
                    </label>
                ))}
                {showLimit && (
                    <label className={`${label} flex items-center gap-1`}>
                        {t('combat.objective.form.limit')}
                        <input type="number" min={3} max={15} className={numberClass} value={current.roundLimit ?? ''} onChange={e => patch({ roundLimit: intOf(e.target.value) })} />
                    </label>
                )}
            </div>
            <div className={row}>
                <span className={label}>{t('combat.objective.form.side')}</span>
                <select aria-label={t('combat.objective.form.side')} data-testid="combat-objective-side-kind" className={selectClass} value={sideKind} onChange={e => patch({ side: e.target.value || undefined })}>
                    <option value="">{t('combat.objective.form.sideNone')}</option>
                    {SIDE_KINDS.map(k => <option key={k} value={k}>{t(`combat.objective.sideKind.${k}`)}</option>)}
                </select>
                {sideKind === 'within_rounds' && (
                    <label className={`${label} flex items-center gap-1`}>
                        {t('combat.objective.form.sideRounds')}
                        <input type="number" min={2} max={12} className={numberClass} value={current.sideRounds ?? ''} onChange={e => patch({ sideRounds: intOf(e.target.value) })} />
                    </label>
                )}
                {needsBystander(current) && (
                    <select aria-label={t('combat.objective.form.bystander')} data-testid="combat-objective-bystander" className={selectClass} value={current.bystander ?? ''} onChange={e => patch({ bystander: e.target.value || undefined })}>
                        <option value="">{t('combat.objective.form.bystanderNew')}</option>
                        {neutrals.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                )}
            </div>
            <div className={row}>
                <span className={label}>{t('combat.objective.form.reinforcements')}</span>
                <select
                    aria-label={t('combat.objective.form.reinforcements')}
                    data-testid="combat-objective-reinforcements"
                    className={selectClass}
                    value={current.reinforcements ?? 'none'}
                    disabled={win === 'rout'}
                    onChange={e => patch({ reinforcements: e.target.value === 'none' ? undefined : e.target.value as ReinforcementLevel })}
                >
                    {REINFORCEMENT_LEVELS.map(level => <option key={level} value={level}>{t(`combat.objective.form.reinforcements.${level}`)}</option>)}
                </select>
                {win === 'rout' && <span className="text-[10px] text-text-dim">{t('combat.objective.form.routNoReinforcements')}</span>}
            </div>
        </fieldset>
    );
}
