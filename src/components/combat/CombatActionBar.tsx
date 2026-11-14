import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Ellipsis, Loader2, SkipForward, FastForward, Footprints, LogOut, Sparkles } from 'lucide-react';
import {
    abilityCost, BUILTIN_ATTACK_ID, builtinAbilities, canAbandon, canAttackWith, casterStats, checkAbility, checkFlee, currentActorId, currentTurn,
    describeAbility, stuntAvailable, usesMp,
} from '@narrative/engine';
import type { TranslationKey } from '../../i18n/locales/en';
import { useAppStore } from '../../store/useAppStore';
import { COMBAT_FLOURISH_MAX, normalizeCombatConfig } from '../../types';
import { useTranslation } from '../../i18n/useTranslation';
import type { CombatAction, CombatSession, Combatant, GlyphAbility } from '../../types';
import { isEngineTurn, playerActorId } from '../../services/combat/combatController';
import { BASIC_HOTKEYS, basicNameKey, MORE_ACTION_IDS } from './basicActions';
import { isTypingTarget } from './combatKeys';
import { attackableTargets, hpColor, playerCharacter } from './combatVisuals';
import { GlyphShape } from '../spellbook/GlyphShape';
import { GlyphStrip } from '../spellbook/GlyphStrip';
import { CombatStuntPanel } from './CombatStuntPanel';

const REASON_KEYS: Readonly<Record<string, TranslationKey>> = {
    'not enough MP': 'combat.bar.noMp',
    'the action is already used': 'combat.board.actionUsed',
    'the bonus action is already used': 'combat.bar.bonusUsed',
    'no target': 'combat.bar.noTarget',
    'the ability is recharging': 'combat.bar.recharging',
    'not enough movement': 'combat.bar.noMovement',
    'no movement to add': 'combat.bar.noMovement',
};

const MORE_IDS: ReadonlySet<string> = new Set(MORE_ACTION_IDS);

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

function AbilityTile({ ability, name, keyLabel, caption, rules, reason, pressed, disabled, title, onClick }: {
    ability: GlyphAbility;
    name: string;
    keyLabel: string;
    caption?: ReactNode;
    rules: string;
    reason: string | null;
    pressed?: boolean;
    disabled?: boolean;
    title?: string;
    onClick: () => void;
}) {
    const off = !!reason || !!disabled;
    return (
        <div className="relative group">
            <button
                type="button"
                data-testid={`combat-ability-${ability.id}`}
                onClick={onClick}
                disabled={disabled}
                aria-disabled={!!reason}
                aria-pressed={pressed}
                aria-keyshortcuts={keyLabel}
                aria-describedby={`combat-ability-tip-${ability.id}`}
                title={title}
                className={`relative flex flex-col items-center justify-center gap-1 w-16 h-16 rounded-lg border-2 outline-none focus-visible:ring-2 focus-visible:ring-terminal ${off ? 'opacity-40 cursor-not-allowed border-border text-text-dim' : 'border-terminal/50 text-terminal hover:bg-terminal/10'} ${pressed ? 'bg-terminal/20' : ''}`}
            >
                <span className="absolute top-0.5 left-1.5 text-xs font-mono text-text-dim">{keyLabel}</span>
                <GlyphShape kind="effect" id={ability.effects[0]?.id ?? null} size="sm" />
                {caption ?? <span className="text-xs font-mono text-text-primary">{name}</span>}
                {caption && <span className="sr-only">{name}</span>}
                <span className="sr-only">{reason ?? ''}</span>
            </button>
            <div
                id={`combat-ability-tip-${ability.id}`}
                data-testid={`combat-ability-tip-${ability.id}`}
                role="tooltip"
                className="hidden group-hover:flex group-focus-within:flex flex-col gap-2 absolute bottom-full left-0 mb-2 z-20 w-64 rounded-lg border border-border bg-surface shadow-xl p-3 normal-case"
            >
                <span className="text-sm font-bold text-text-primary">{name}</span>
                <GlyphStrip ability={ability} />
                <span className="text-xs text-text-dim leading-relaxed">{rules}</span>
                {reason && <span className="text-xs text-danger leading-relaxed">{reason}</span>}
            </div>
        </div>
    );
}

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
    flourish,
    onFlourish,
    compact = false,
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
    flourish?: string;
    onFlourish?: (text: string) => void;
    compact?: boolean;
}) {
    const { t } = useTranslation();
    const [moreOpen, setMoreOpen] = useState(false);
    const [stuntOpen, setStuntOpen] = useState(false);
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
        return { ability, index, cost: abilityCost(ability), reason, recharge, rules: describeAbility(ability, casterStats(player!)) };
    }), [state, player, t, label]);
    const basics = useMemo(() => (player ? builtinAbilities(player).map(ability => {
        const check = MORE_IDS.has(ability.id) ? checkAbility(state, player.id, ability.id) : null;
        const reason = check && !check.ok ? t(REASON_KEYS[check.reason ?? ''] ?? 'combat.bar.unavailable', { label }) : null;
        return { ability, reason, rules: describeAbility(ability, casterStats(player), player) };
    }) : []), [state, player, t, label]);
    const fleeReason = flee && !flee.ok ? t(FLEE_REASON_KEYS[flee.reason ?? ''] ?? 'combat.bar.unavailable') : null;
    const stuntCheck = player ? stuntAvailable(state, player.id) : null;
    const stuntReason = stuntCheck && !stuntCheck.ok ? t(stuntCheck.reason === 'the action is already used' ? 'combat.board.actionUsed' : 'combat.bar.unavailable') : null;
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

    const chooseBasic = (id: string) => {
        const entry = basics.find(b => b.ability.id === id);
        if (!canAct || !entry || !onAim) return;
        setMoreOpen(false);
        if (aimingId === id) {
            onAim(null);
            return;
        }
        if (aimingId) onAim(null);
        if (!entry.reason) onAim(id);
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
            else {
                const id = MORE_ACTION_IDS.find(m => BASIC_HOTKEYS[m].toLowerCase() === k);
                if (id) { chooseBasic(id); e.preventDefault(); }
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const attackTitle = !actionLeft ? t('combat.board.actionUsed') : attackable.length === 0 ? t('combat.panel.outOfReach') : t('combat.bar.attackHelp');

    const renderBasic = ({ ability, rules, reason }: { ability: GlyphAbility; rules: string; reason: string | null }) => {
        const isAttack = ability.id === BUILTIN_ATTACK_ID;
        const fixed = !MORE_IDS.has(ability.id);
        return (
            <AbilityTile
                key={ability.id}
                ability={ability}
                name={t(basicNameKey(ability.id))}
                keyLabel={BASIC_HOTKEYS[ability.id]}
                rules={rules}
                reason={reason}
                pressed={fixed ? undefined : aimingId === ability.id}
                disabled={fixed ? (isAttack ? !actionLeft || attackable.length === 0 : !actionLeft) : undefined}
                title={isAttack ? attackTitle : undefined}
                onClick={fixed ? (isAttack ? attack : defend) : () => chooseBasic(ability.id)}
            />
        );
    };

    return (
        <div data-testid="combat-action-bar" data-mode={mode} className="flex items-center gap-x-4 gap-y-2 flex-wrap px-3 py-2 border-t border-border bg-void">
            {shown && <Vitals c={shown} label={label} moveLeft={mode === 'player' && turn ? turn.moveLeft : null} />}
            {mode === 'player' && (
                <div data-testid="combat-actions" className="flex items-center gap-1.5 flex-wrap">
                    <div data-testid="combat-basic-actions" className="flex items-center gap-1.5">
                        {basics.filter(b => !MORE_IDS.has(b.ability.id)).map(renderBasic)}
                        <button
                            type="button"
                            data-testid="combat-stunt"
                            onClick={() => { if (!stuntReason) setStuntOpen(v => !v); }}
                            aria-disabled={!!stuntReason}
                            aria-pressed={stuntOpen}
                            title={stuntReason ?? t('combat.stunt.help')}
                            className={`${buttonClass} h-16 border-border text-text-primary hover:bg-void-lighter ${stuntReason ? 'opacity-40' : ''} ${stuntOpen ? 'bg-terminal/20' : ''}`}
                        >
                            <Sparkles size={12} /> {t('combat.stunt.button')}
                            <span className="sr-only">{stuntReason ?? ''}</span>
                        </button>
                        {!compact && basics.filter(b => MORE_IDS.has(b.ability.id)).map(renderBasic)}
                        {compact && (
                            <div className="relative">
                                <button
                                    type="button"
                                    data-testid="combat-more-actions"
                                    aria-expanded={moreOpen}
                                    aria-haspopup="true"
                                    onClick={() => setMoreOpen(v => !v)}
                                    onKeyDown={(e) => { if (e.key === 'Escape') setMoreOpen(false); }}
                                    className={`${buttonClass} h-16 border-border text-text-primary hover:bg-void-lighter ${moreOpen ? 'bg-terminal/20' : ''}`}
                                >
                                    <Ellipsis size={12} /> {t('combat.bar.moreActions')}
                                </button>
                                {moreOpen && (
                                    <div
                                        data-testid="combat-more-popover"
                                        role="group"
                                        aria-label={t('combat.bar.moreActions')}
                                        onKeyDown={(e) => { if (e.key === 'Escape') setMoreOpen(false); }}
                                        className="absolute bottom-full left-0 mb-2 z-30 flex items-center gap-1.5 flex-wrap max-w-[85vw] rounded-lg border border-border bg-surface p-2 shadow-xl"
                                    >
                                        {basics.filter(b => MORE_IDS.has(b.ability.id)).map(renderBasic)}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
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
                    {kit.map(({ ability, index, cost, reason, recharge, rules }) => (
                        <AbilityTile
                            key={ability.id}
                            ability={ability}
                            name={ability.name}
                            keyLabel={String(index + 1)}
                            caption={<span className="text-xs font-mono text-text-primary">{recharge === null ? t('combat.spellbook.cost', { cost, label }) : recharge > 0 ? t('combat.bar.cooldownShort', { rounds: recharge }) : t('combat.bar.ready')}</span>}
                            rules={rules}
                            reason={reason}
                            pressed={aimingId === ability.id}
                            onClick={() => chooseAbility(index)}
                        />
                    ))}
                </div>
            )}
            {mode === 'player' && onFlourish && (
                <input
                    type="text"
                    data-testid="combat-flourish"
                    value={flourish ?? ''}
                    maxLength={COMBAT_FLOURISH_MAX}
                    onChange={(e) => onFlourish(e.target.value.replace(/[\r\n]+/g, ' '))}
                    onKeyDown={(e) => { if (e.key === 'Escape') e.currentTarget.blur(); }}
                    placeholder={t('combat.bar.flourishPlaceholder')}
                    aria-label={t('combat.bar.flourishLabel')}
                    title={t('combat.bar.flourishHelp')}
                    className="flex-1 min-w-[12rem] bg-surface border border-border px-2 py-1 text-[12px] text-text-primary rounded-sm focus:border-terminal outline-none"
                />
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
            {mode === 'resolving' && !session.stunt && (
                <div data-testid="combat-resolving" className="flex items-center gap-2 text-[11px] font-mono text-text-dim">
                    <Loader2 size={12} className="animate-spin" /> {t('combat.panel.waiting')}
                </div>
            )}
            {(session.stunt || (mode === 'player' && stuntOpen)) && (
                <CombatStuntPanel session={session} busy={busy} open={stuntOpen} onClose={() => setStuntOpen(false)} />
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
