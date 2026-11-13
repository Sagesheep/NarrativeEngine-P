import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Map as MapIcon, BookOpen } from 'lucide-react';
import { canAttackWith, currentTurn, findKitAbility } from '@narrative/engine';
import { useAppStore } from '../../store/useAppStore';
import { useTranslation } from '../../i18n/useTranslation';
import type { ChatMessage, CombatAction, CombatSession } from '../../types';
import { playerActorId } from '../../services/combat/combatController';
import { CombatBoard } from './CombatBoard';
import { CombatInitiativeStrip } from './CombatInitiativeStrip';
import { CombatActionBar } from './CombatActionBar';
import { attackableTargets } from './combatVisuals';
import { useContainerWidth } from './useContainerWidth';
import { needsAim, useAbilityAim } from './useAbilityAim';

export const NARROW_COMBAT_WIDTH = 900;
const BOTTOM_SLACK = 48;

type View = 'map' | 'story';

function countBeats(messages: readonly ChatMessage[], sessionId: string): number {
    let n = 0;
    for (const m of messages) if (m.combatBeat?.sessionId === sessionId) n++;
    return n;
}

export function CombatScreen({
    session,
    busy,
    onAction,
    onEnd,
    onSkip,
    feed,
    feedScrollRef,
}: {
    session: CombatSession;
    busy: boolean;
    onAction: (action: CombatAction) => void;
    onEnd: () => void;
    onSkip: () => void;
    feed: ReactNode;
    feedScrollRef: RefObject<HTMLDivElement | null>;
}) {
    const { t } = useTranslation();
    const rootRef = useRef<HTMLDivElement | null>(null);
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    const width = useContainerWidth(rootRef);
    const narrow = width !== null && width < NARROW_COMBAT_WIDTH;
    const [view, setView] = useState<View>('map');
    const [targetId, setTargetId] = useState<string | null>(null);
    const [picking, setPicking] = useState(false);
    const [aimingId, setAimingId] = useState<string | null>(null);
    const messages = useAppStore(s => s.messages);
    const beats = useMemo(() => countBeats(messages, session.state.id), [messages, session.state.id]);
    const [seenBeats, setSeenBeats] = useState(beats);
    const unread = narrow && view === 'map' && beats > seenBeats;
    const atBottom = useRef(true);

    const show = (next: View) => {
        setView(next);
        setSeenBeats(beats);
    };

    useEffect(() => {
        const el = feedScrollRef.current;
        if (!el) return;
        const onScroll = () => { atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK; };
        el.addEventListener('scroll', onScroll);
        return () => el.removeEventListener('scroll', onScroll);
    }, [feedScrollRef]);

    useLayoutEffect(() => {
        const el = feedScrollRef.current;
        if (el && atBottom.current) el.scrollTop = el.scrollHeight;
    }, [messages, view, narrow, feedScrollRef]);

    const act = (action: CombatAction) => {
        setPicking(false);
        setAimingId(null);
        onAction(action);
    };

    const actorId = playerActorId(session.state);
    const aim = useAbilityAim(session.state, actorId, aimingId, act, () => setAimingId(null));
    const liveAim = aim && !busy ? aim : null;

    const startAim = (abilityId: string | null) => {
        setPicking(false);
        if (!abilityId || !actorId) {
            setAimingId(null);
            return;
        }
        const ability = findKitAbility(session.state.combatants[actorId], abilityId);
        if (!ability) return;
        if (!needsAim(ability)) {
            act({ type: 'use_ability', actorId, abilityId, aim: null });
            return;
        }
        setAimingId(abilityId);
        if (narrow && view !== 'map') show('map');
        surfaceRef.current?.focus({ preventScroll: true });
    };

    const select = (id: string | null) => {
        setTargetId(id);
        if (id && narrow && view !== 'map') show('map');
    };

    const pick = () => {
        const state = session.state;
        const id = playerActorId(state);
        const player = id ? state.combatants[id] : undefined;
        const turn = player ? currentTurn(state) : null;
        const first = attackableTargets(state, player, !!turn && canAttackWith(turn))[0];
        setAimingId(null);
        if (!first) return;
        setTargetId(first.id);
        setPicking(true);
        if (narrow && view !== 'map') show('map');
        surfaceRef.current?.focus({ preventScroll: true });
    };

    const hasGrid = !!session.state.grid;
    const boardHidden = narrow && view !== 'map';
    const feedHidden = narrow && view !== 'story';

    return (
        <div
            ref={rootRef}
            data-testid="combat-screen"
            data-layout={narrow ? 'narrow' : 'wide'}
            className="flex-1 min-h-0 min-w-0 grid bg-void"
            style={{ gridTemplateRows: 'auto minmax(0, 1fr) auto' }}
        >
            <CombatInitiativeStrip session={session} busy={busy} selectedId={targetId} onSelect={select} onEnd={onEnd} />
            <div
                className="min-h-0 min-w-0 grid"
                style={narrow
                    ? { gridTemplateRows: 'auto minmax(0, 1fr)', gridTemplateColumns: 'minmax(0, 1fr)' }
                    : { gridTemplateColumns: 'minmax(0, 1.7fr) minmax(280px, 1fr)', gridTemplateRows: 'minmax(0, 1fr)' }}
            >
                {narrow && (
                    <div role="group" aria-label={t('combat.screen.view')} className="flex items-center gap-1 px-3 py-1 border-b border-border">
                        <button
                            type="button"
                            aria-pressed={view === 'map'}
                            onClick={() => show('map')}
                            className={`flex items-center gap-1 px-2.5 py-1 rounded-sm text-[11px] uppercase tracking-wider border ${view === 'map' ? 'border-text-primary text-text-primary' : 'border-border text-text-dim hover:text-text-primary'}`}
                        >
                            <MapIcon size={12} /> {t('combat.screen.map')}
                        </button>
                        <button
                            type="button"
                            aria-pressed={view === 'story'}
                            onClick={() => show('story')}
                            className={`relative flex items-center gap-1 px-2.5 py-1 rounded-sm text-[11px] uppercase tracking-wider border ${view === 'story' ? 'border-text-primary text-text-primary' : 'border-border text-text-dim hover:text-text-primary'}`}
                        >
                            <BookOpen size={12} /> {t('combat.screen.story')}
                            {unread && (
                                <span data-testid="combat-story-unread" className="absolute -top-1 -right-1 w-2 h-2 rounded-full" style={{ background: 'var(--combat-enemy)' }}>
                                    <span className="sr-only">{t('combat.screen.unread')}</span>
                                </span>
                            )}
                        </button>
                    </div>
                )}
                <div data-testid="combat-board-cell" hidden={boardHidden} className="min-h-0 min-w-0">
                    {hasGrid && (
                        <CombatBoard
                            session={session}
                            busy={busy}
                            targetId={targetId}
                            onTarget={select}
                            onAction={act}
                            picking={picking}
                            onPickEnd={() => setPicking(false)}
                            surfaceRef={surfaceRef}
                            aim={liveAim}
                        />
                    )}
                </div>
                <div data-testid="combat-feed" hidden={feedHidden} className={`combat-feed min-h-0 min-w-0 flex flex-col ${narrow ? '' : 'border-l border-border'}`}>
                    {feed}
                </div>
            </div>
            <CombatActionBar session={session} busy={busy} targetId={targetId} onAction={act} onPick={pick} onSkip={onSkip} aimingId={liveAim ? aimingId : null} onAim={startAim} />
        </div>
    );
}
