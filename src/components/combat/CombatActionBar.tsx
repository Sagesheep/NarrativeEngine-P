import { useEffect, useMemo } from 'react';
import { Swords, Shield, Loader2, SkipForward, FastForward, Sparkles, Footprints, LogOut } from 'lucide-react';
import { abilityCost, canAbandon, canAttackWith, checkAbility, checkFlee, currentActorId, currentTurn, usesMp } from '@narrative/engine';
import type { TranslationKey } from '../../i18n/locales/en';
import { useAppStore } from '../../store/useAppStore';
import { normalizeCombatConfig } from '../../types';
import { useTranslation } from '../../i18n/useTranslation';
import type { CombatAction, CombatSession, Combatant } from '../../types';
import { isEngineTurn, playerActorId } from '../../services/combat/combatController';
import { isTypingTarget } from './combatKeys';
import { attackableTargets, hpColor, playerCharacter } from './combatVisuals';

const REASON_KEYS: Readonly<Record<string, TranslationKey>> = {
    'not enough MP': 'combat.bar.noMp',
    'the action is already used': 'combat.board.actionUsed',
    'the bonus action is already used': 'combat.bar.bonusUsed',
    'no target': 'combat.bar.noTarget',
    'the ability is recharging': 'combat.bar.recharging',
};

const FLEE_REASON_KEYS: Readonly<Record<string, TranslationKey>> = {
    first_round: 'combat.bar.flee.firstRound',
    not_on_edge: 'combat.bar.flee.notOnEdge',
    started_off_edge: 'combat.bar.flee.startedOffEdge',
    action_used: 'combat.board.actionUsed',
};

const EDGE_REASONS: ReadonlySet<string> = new Set(['not_on_edge', 'started_off_edge']);

function Vitals({ c, moveLeft, label }: { c: Combatant; moveLeft: number | null; label: string }) {
    const { t } = useTranslation();
    const pct = Math.max(0, Math.min(100, Math.round((c.hp / Math.max(1, c.maxHp)) * 100)));
    return (
        <div data-testid="combat-vitals" className="flex items-center gap-3 min-w-0 text-[11px] font-mono">
            <span className="font-bold text-text-primary truncate max-w-[10rem]">{c.name}</span>
            <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-20 rounded-sm overflow-hidden" style={{ background: 'var(--combat-hp-track)' }}>
                    <span className="block h-full" style={{ width: `${c.status === 'up' ? pct : 0}%`, background: hpColor(c) }} />
                </span>
                <span className="text-text-primary whitespace-nowrap">{t('combat.panel.hp', { hp: c.hp, max: c.maxHp })}</span>
            </span>
            {typeof c.maxMp === 'number' && <span data-testid="combat-mp" className="text-text-primary whitespace-nowrap">{t('combat.bar.mp', { label, current: c.mp ?? 0, max: c.maxMp })}</span>}
            {(c.tempHp ?? 0) > 0 && <span data-testid="combat-temp" className="text-text-dim whitespace-nowrap">{t('combat.board.tempHp', { temp: c.tempHp as number })}</span>}
            <span className="text-text-dim whitespace-nowrap">{t('combat.inspect.ac', { ac: c.ac })}</span>
            {moveLeft !== null && <span data-testid="combat-move-left" className="text-text-dim whitespace-nowrap">{t('combat.panel.moveLeft', { squares: moveLeft })}</span>}
        </div>
    );
}

const buttonClass = 'flex items-center gap-1 border text-[10px] uppercase tracking-wider px-3 py-1.5 rounded-sm disabled:opacity-40 disabled:cursor-not-allowed';

export function CombatActionBar({
    session,
    busy,
    targetId,
    onAction,
    onPick,
    onSkip,
    aimingId = null,
    onAim,
    onShowEdges,
}: {
    session: CombatSession;
    busy: boolean;
    targetId: string | null;
    onAction: (action: CombatAction) => void;
    onPick: () => void;
    onSkip: () => void;
    aimingId?: string | null;
    onAim?: (abilityId: string | null) => void;
    onShowEdges?: () => void;
}) {
    const { t } = useTranslation();
    const state = session.state;
    const playerId = playerActorId(state);
    const player = playerId ? state.combatants[playerId] : undefined;
    const shown = player ?? playerCharacter(state);
    const turn = player ? currentTurn(state) : null;
    const actionLeft = !!turn && canAttackWith(turn);
    const flee = player && turn ? checkFlee(state, player.id, turn) : null;
    const label = useAppStore(s => normalizeCombatConfig(s.context?.combatConfig).resourceLabel);
    const engineTurn = state.outcome === null && isEngineTurn(state);
    const actingId = currentActorId(state);
    const acting = actingId ? state.combatants[actingId] : undefined;
    const mode: 'player' | 'engine' | 'resolving' = state.outcome !== null
        ? 'resolving'
        : engineTurn ? 'engine' : busy || !player ? 'resolving' : 'player';
    const attackable = useMemo(() => attackableTargets(state, player, actionLeft), [state, player, actionLeft]);
    const canAct = mode === 'player';
    const kit = useMemo(() => (player?.kit ?? []).slice(0, 9).map((ability, index) => {
        const check = checkAbility(state, player!.id, ability.id);
        const reason = check.ok ? null : t(REASON_KEYS[check.reason ?? ''] ?? 'combat.bar.unavailable', { label });
        const recharge = player && !usesMp(player) ? Math.max(0, (player.cooldowns?.[ability.id] ?? 0) - state.round) : null;
        return { ability, index, cost: abilityCost(ability), reason, recharge };
    }), [state, player, t, label]);
    const fleeReason = flee && !flee.ok ? t(FLEE_REASON_KEYS[flee.reason ?? ''] ?? 'combat.bar.unavailable') : null;
    const abandonable = !!player && canAbandon(state, player.id);
    const chooseAbility = (index: number) => {
        const entry = kit[index];
        if (!canAct || !entry || !onAim) return;
        if (aimingId === entry.ability.id) {
            onAim(null);
            return;
        }
        if (aimingId) onAim(null);
        if (!entry.reason) onAim(entry.ability.id);
    };

    const attack = () => {
        if (aimingId) onAim?.(null);
        if (!canAct || !player || !actionLeft) return;
        if (targetId && attackable.some(c => c.id === targetId)) {
            onAction({ type: 'attack', actorId: player.id, targetId });
            return;
        }
        if (attackable.length > 0) onPick();
    };
    const defend = () => {
        if (!canAct || !player || !actionLeft) return;
        onAction({ type: 'defend', actorId: player.id });
    };
    const doFlee = () => {
        if (!canAct || !player || !flee) return;
        if (flee.ok) {
            onAction({ type: 'flee', actorId: player.id });
            return;
        }
        if (EDGE_REASONS.has(flee.reason ?? '')) onShowEdges?.();
    };
    const abandon = () => {
        if (!canAct || !player || !abandonable) return;
        if (window.confirm(t('combat.bar.abandonConfirm'))) onAction({ type: 'abandon', actorId: player.id });
    };
    const endTurn = () => {
        if (!canAct || !player) return;
        onAction({ type: 'end_turn', actorId: player.id });
    };

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
            const k = e.key.toLowerCase();
            if (k === 'a') { attack(); e.preventDefault(); }
            else if (k === 'd') { defend(); e.preventDefault(); }
            else if (/^[1-9]$/.test(e.key) && kit[Number(e.key) - 1]) { chooseAbility(Number(e.key) - 1); e.preventDefault(); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const attackTitle = !actionLeft ? t('combat.board.actionUsed') : attackable.length === 0 ? t('combat.panel.outOfReach') : t('combat.bar.attackHelp');

    return (
        <div data-testid="combat-action-bar" data-mode={mode} className="flex items-center gap-x-4 gap-y-2 flex-wrap px-3 py-2 border-t border-border bg-void">
            {shown && <Vitals c={shown} label={label} moveLeft={mode === 'player' && turn ? turn.moveLeft : null} />}
            {mode === 'player' && (
                <div data-testid="combat-actions" className="flex items-center gap-1.5 flex-wrap">
                    <button
                        type="button"
                        onClick={attack}
                        disabled={!actionLeft || attackable.length === 0}
                        title={attackTitle}
                        aria-keyshortcuts="A"
                        className={buttonClass}
                        style={{ borderColor: 'var(--combat-enemy)', color: 'var(--combat-enemy)' }}
                    >
                        <Swords size={12} /> {t('combat.panel.attack')}
                    </button>
                    <button
                        type="button"
                        onClick={defend}
                        disabled={!actionLeft}
                        aria-keyshortcuts="D"
                        className={`${buttonClass} border-ice/40 text-ice hover:bg-ice/10`}
                    >
                        <Shield size={12} /> {t('combat.panel.defend')}
                    </button>
                    <button
                        type="button"
                        data-testid="combat-flee"
                        onClick={doFlee}
                        aria-disabled={!flee?.ok}
                        title={fleeReason ?? t(flee?.contested ? 'combat.bar.fleeContested' : 'combat.bar.fleeHelp')}
                        className={`${buttonClass} border-border text-text-primary hover:bg-void-lighter ${flee?.ok ? '' : 'opacity-40'}`}
                    >
                        <Footprints size={12} /> {t('combat.bar.flee')}
                        <span className="sr-only">{fleeReason ?? ''}</span>
                    </button>
                    {abandonable && (
                        <button
                            type="button"
                            data-testid="combat-abandon"
                            onClick={abandon}
                            title={t('combat.bar.abandonHelp')}
                            className={`${buttonClass} border-border text-text-primary hover:bg-void-lighter`}
                        >
                            <LogOut size={12} /> {t('combat.bar.abandon')}
                        </button>
                    )}
                    {kit.map(({ ability, index, cost, reason, recharge }) => (
                        <button
                            key={ability.id}
                            type="button"
                            data-testid={`combat-ability-${ability.id}`}
                            onClick={() => chooseAbility(index)}
                            disabled={!!reason}
                            aria-pressed={aimingId === ability.id}
                            aria-keyshortcuts={String(index + 1)}
                            title={reason ?? (recharge === null ? t('combat.bar.abilityHelp', { name: ability.name, cost, label, key: index + 1 }) : t('combat.bar.abilityHelpCooldown', { name: ability.name, key: index + 1 }))}
                            className={`${buttonClass} border-terminal/50 text-terminal hover:bg-terminal/10 ${aimingId === ability.id ? 'bg-terminal/20' : ''}`}
                        >
                            <Sparkles size={12} /> <span className="max-w-[8rem] truncate normal-case">{ability.name}</span>
                            <span className="text-text-dim">{recharge === null ? cost : recharge > 0 ? t('combat.bar.cooldownShort', { rounds: recharge }) : ''}</span>
                            <span className="sr-only">{reason ?? ''}</span>
                        </button>
                    ))}
                </div>
            )}
            {mode === 'engine' && (
                <div data-testid="combat-engine-acting" className="flex items-center gap-2 text-[11px] font-mono text-text-dim">
                    <Loader2 size={12} className="animate-spin" />
                    <span>{t('combat.bar.acting', { name: acting?.name ?? '' })}</span>
                    <button type="button" onClick={onSkip} className="flex items-center gap-1 border border-border px-2 py-0.5 rounded-sm hover:text-text-primary">
                        <FastForward size={11} /> {t('combat.panel.skip')}
                    </button>
                </div>
            )}
            {mode === 'resolving' && (
                <div data-testid="combat-resolving" className="flex items-center gap-2 text-[11px] font-mono text-text-dim">
                    <Loader2 size={12} className="animate-spin" /> {t('combat.panel.waiting')}
                </div>
            )}
            {mode === 'player' && (
                <button
                    type="button"
                    onClick={endTurn}
                    className={`${buttonClass} ml-auto border-border text-text-primary hover:bg-void-lighter`}
                >
                    <SkipForward size={12} /> {t('combat.panel.endTurn')}
                </button>
            )}
        </div>
    );
}
