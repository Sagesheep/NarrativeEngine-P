import { useEffect, useMemo } from 'react';
import { Swords, Shield, Loader2, SkipForward, FastForward } from 'lucide-react';
import { currentActorId, currentTurn } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import type { CombatAction, CombatSession, Combatant } from '../../types';
import { isEngineTurn, playerActorId } from '../../services/combat/combatController';
import { isTypingTarget } from './combatKeys';
import { attackableTargets, hpColor, playerCharacter } from './combatVisuals';

function Vitals({ c, moveLeft }: { c: Combatant; moveLeft: number | null }) {
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
}: {
    session: CombatSession;
    busy: boolean;
    targetId: string | null;
    onAction: (action: CombatAction) => void;
    onPick: () => void;
    onSkip: () => void;
}) {
    const { t } = useTranslation();
    const state = session.state;
    const playerId = playerActorId(state);
    const player = playerId ? state.combatants[playerId] : undefined;
    const shown = player ?? playerCharacter(state);
    const turn = player ? currentTurn(state) : null;
    const actionLeft = !!turn && !turn.actionUsed;
    const engineTurn = state.outcome === null && isEngineTurn(state);
    const actingId = currentActorId(state);
    const acting = actingId ? state.combatants[actingId] : undefined;
    const mode: 'player' | 'engine' | 'resolving' = state.outcome !== null
        ? 'resolving'
        : engineTurn ? 'engine' : busy || !player ? 'resolving' : 'player';
    const attackable = useMemo(() => attackableTargets(state, player, actionLeft), [state, player, actionLeft]);
    const canAct = mode === 'player';

    const attack = () => {
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
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const attackTitle = !actionLeft ? t('combat.board.actionUsed') : attackable.length === 0 ? t('combat.panel.outOfReach') : t('combat.bar.attackHelp');

    return (
        <div data-testid="combat-action-bar" data-mode={mode} className="flex items-center gap-x-4 gap-y-2 flex-wrap px-3 py-2 border-t border-border bg-void">
            {shown && <Vitals c={shown} moveLeft={mode === 'player' && turn ? turn.moveLeft : null} />}
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
