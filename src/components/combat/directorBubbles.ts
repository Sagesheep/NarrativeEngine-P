import { ORDER_EVENT_TYPE } from '@narrative/engine';
import { spokenLine } from '../../services/combat/combatEvents';
import type { CombatPos, CombatSession } from '../../types';

export const BUBBLE_CHARS = 30;
export const BUBBLE_LINES = 3;

export type OrderBubble = { id: string; name: string; pos: CombatPos; line: string; seq: number };

export function orderBubbles(session: CombatSession): OrderBubble[] {
    const state = session.state;
    if (state.outcome) return [];
    const latest = new Map<string, OrderBubble>();
    for (const e of session.log) {
        if (e.type !== ORDER_EVENT_TYPE || !e.actorId || e.data.round !== state.round) continue;
        const line = spokenLine(e);
        const c = state.combatants[e.actorId];
        if (!line || !c || c.status !== 'up' || !c.position) continue;
        const index = state.order.indexOf(c.id);
        if (index < 0 || index < state.turnIndex) continue;
        latest.set(c.id, { id: c.id, name: c.name, pos: c.position, line, seq: e.seq });
    }
    return [...latest.values()];
}

export function wrapLine(text: string, width: number = BUBBLE_CHARS, maxLines: number = BUBBLE_LINES): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let current = '';
    for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        if (next.length <= width || !current) {
            current = next.length > width ? next.slice(0, width) : next;
            continue;
        }
        lines.push(current);
        current = word.slice(0, width);
    }
    if (current) lines.push(current);
    if (lines.length <= maxLines) return lines;
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1];
    kept[maxLines - 1] = `${last.slice(0, Math.max(0, width - 1)).replace(/[\s,;:.]+$/, '')}…`;
    return kept;
}
