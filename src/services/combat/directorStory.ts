import { ORDER_EVENT_TYPE, normalizeOrderKind, normalizeTactic } from '@narrative/engine';
import type { OrderKind, Tactic } from '@narrative/engine';
import { t } from '../../i18n';
import type { CombatEvent, CombatSession, CombatState } from '../../types';
import { spokenLine } from './combatEvents';

function nameOf(state: CombatState, id: unknown): string {
    return (typeof id === 'string' && state.combatants[id]?.name) || '?';
}

function signatureNameOf(event: CombatEvent): string {
    return typeof event.data.signatureName === 'string' && event.data.signatureName.trim() ? event.data.signatureName.trim() : '';
}

export function tacticWord(tactic: Tactic | undefined): string {
    return tactic ? t(`combat.director.tactic.${tactic}`) : '';
}

export function orderWords(kind: OrderKind, state: CombatState, targetId?: string, tactic?: Tactic, signatureName?: string): string {
    switch (kind) {
        case 'focus':
            return t('combat.director.order.focus', { target: nameOf(state, targetId) });
        case 'protect':
            return t('combat.director.order.protect', { target: nameOf(state, targetId) });
        case 'signature':
            return signatureName ? t('combat.director.order.signatureNamed', { move: signatureName }) : t('combat.director.order.signature');
        case 'switch_tactic':
            return t('combat.director.order.switch_tactic', { tactic: tacticWord(tactic) });
        default:
            return t(`combat.director.order.${kind}`);
    }
}

export function orderLogText(event: CombatEvent, state: CombatState): string {
    const kind = normalizeOrderKind(event.data.kind);
    if (!kind) return event.text;
    const targetId = typeof event.data.targetId === 'string' ? event.data.targetId : event.targetId;
    const words = orderWords(kind, state, targetId, normalizeTactic(event.data.tactic), signatureNameOf(event));
    const base = t('combat.director.log', { name: nameOf(state, event.actorId), order: words });
    const line = spokenLine(event);
    return line ? t('combat.director.logSaid', { text: base, line }) : base;
}

export function translateOrderEvents(events: readonly CombatEvent[], state: CombatState): CombatEvent[] {
    return events.map(e => (e.type === ORDER_EVENT_TYPE ? { ...e, text: orderLogText(e, state) } : e));
}

const STORY_ORDER: Readonly<Record<OrderKind, (target: string, tactic: string, move: string) => string>> = {
    focus: target => `focus ${target}`,
    protect: target => `protect ${target}`,
    hold: () => 'hold',
    fall_back: () => 'fall back',
    press: () => 'press the attack',
    signature: (_target, _tactic, move) => (move ? `use ${move}` : 'use the signature move'),
    switch_tactic: (_target, tactic) => `switch to ${tactic || 'new'} tactics`,
};

export function directorOutcomeLines(session: CombatSession): string[] {
    const state = session.state;
    const byUnit = new Map<string, string[]>();
    const used = new Map<string, Set<string>>();
    for (const e of session.log) {
        if (!e.actorId) continue;
        if (e.type === ORDER_EVENT_TYPE) {
            const kind = normalizeOrderKind(e.data.kind);
            if (!kind) continue;
            const target = nameOf(state, typeof e.data.targetId === 'string' ? e.data.targetId : e.targetId);
            const tactic = typeof e.data.tactic === 'string' ? e.data.tactic : '';
            const text = STORY_ORDER[kind](target, tactic, signatureNameOf(e));
            const list = byUnit.get(e.actorId) ?? [];
            if (list[list.length - 1] !== text) list.push(text);
            byUnit.set(e.actorId, list);
        } else if (e.type === 'ability' && e.data.signature === true) {
            const name = typeof e.data.name === 'string' && e.data.name.trim() ? e.data.name.trim() : 'a signature move';
            const set = used.get(e.actorId) ?? new Set<string>();
            set.add(name);
            used.set(e.actorId, set);
        }
    }
    const ids = [...new Set([...byUnit.keys(), ...used.keys()])];
    if (ids.length === 0) return [];
    const parts = ids.map(id => {
        const orders = byUnit.get(id) ?? [];
        const moves = [...(used.get(id) ?? [])];
        const bits = [
            orders.length > 0 ? `orders ${orders.join(', then ')}` : '',
            moves.length > 0 ? `used ${moves.join(' and ')}` : '',
        ].filter(Boolean);
        return `${nameOf(state, id)} (${bits.join('; ')})`;
    });
    return [`Officers: ${parts.join('; ')}.`];
}
