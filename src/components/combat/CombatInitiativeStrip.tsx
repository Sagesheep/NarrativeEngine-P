import { useEffect, useRef } from 'react';
import { Flag, Swords } from 'lucide-react';
import { currentActorId } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import type { CombatSession } from '../../types';
import { hpBandLabel } from '../../services/combat/combatEvents';
import { BAND_KEY, isParty, sideColor, turnOrderForStrip } from './combatVisuals';

export function CombatInitiativeStrip({
    session,
    busy,
    selectedId,
    onSelect,
    onEnd,
}: {
    session: CombatSession;
    busy: boolean;
    selectedId: string | null;
    onSelect: (id: string) => void;
    onEnd: () => void;
}) {
    const { t } = useTranslation();
    const state = session.state;
    const actingId = currentActorId(state);
    const listRef = useRef<HTMLOListElement | null>(null);

    useEffect(() => {
        const list = listRef.current;
        if (!list || !actingId) return;
        const chip = Array.from(list.querySelectorAll<HTMLElement>('[data-combatant]')).find(el => el.dataset.combatant === actingId);
        if (!chip) return;
        const left = chip.offsetLeft;
        const right = left + chip.offsetWidth;
        if (left < list.scrollLeft || right > list.scrollLeft + list.clientWidth) {
            list.scrollLeft = Math.max(0, left - (list.clientWidth - chip.offsetWidth) / 2);
        }
    }, [actingId, state.turnCount]);

    return (
        <div data-testid="combat-initiative" className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-void min-w-0">
            <span className="flex items-center gap-1.5 shrink-0 text-[11px] font-mono uppercase tracking-wider" style={{ color: 'var(--combat-enemy)' }}>
                <Swords size={13} />{t('combat.panel.title', { round: state.round })}
            </span>
            <ol ref={listRef} aria-label={t('combat.strip.order')} className="flex-1 min-w-0 flex items-center gap-1.5 overflow-x-auto no-scrollbar">
                {turnOrderForStrip(state).map(c => {
                    const acting = actingId === c.id;
                    const selected = selectedId === c.id;
                    const hp = isParty(c) ? t('combat.panel.hp', { hp: c.hp, max: c.maxHp }) : t(BAND_KEY[hpBandLabel(c)]);
                    return (
                        <li key={c.id} data-combatant={c.id} className="shrink-0">
                            <button
                                type="button"
                                data-testid={`combatant-${c.id}`}
                                data-acting={acting ? 'true' : undefined}
                                aria-current={acting ? 'true' : undefined}
                                aria-pressed={selected}
                                onClick={() => onSelect(c.id)}
                                title={acting ? t('combat.panel.acting') : undefined}
                                className={`flex items-center gap-1.5 border rounded-sm px-2 py-0.5 text-[11px] font-mono whitespace-nowrap ${acting ? 'border-text-primary bg-void-lighter text-text-primary' : 'border-border text-text-primary hover:bg-void-lighter'} ${c.status !== 'up' ? 'opacity-45' : ''}`}
                                style={selected ? { boxShadow: '0 0 0 1px var(--combat-cursor)' } : undefined}
                            >
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: sideColor(c.side) }} />
                                <span className="max-w-[9rem] truncate">{c.name}</span>
                                <span className="text-text-dim">{hp}</span>
                            </button>
                        </li>
                    );
                })}
            </ol>
            <button
                type="button"
                onClick={() => { if (window.confirm(t('combat.panel.endConfirm'))) onEnd(); }}
                disabled={busy}
                className="shrink-0 flex items-center gap-1 border border-border text-text-dim hover:text-text-primary text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-sm disabled:opacity-40"
            >
                <Flag size={12} /> {t('combat.panel.end')}
            </button>
        </div>
    );
}
