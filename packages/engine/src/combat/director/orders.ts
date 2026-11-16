import { normalizeTactic } from '../ai/tactic';
import { canTarget, closeDraft, emit, freshTurn, openDraft } from '../core';
import { sameTeam } from '../grid';
import type {
    CombatEvent, CombatOrder, CombatState, Combatant, DirectorOrder, OrderKind, OrderRejectReason, OrderRejection, Tactic,
} from '../types';
import { DIRECTED_TIERS, ORDER_EVENT_TYPE, ORDER_KINDS, ORDER_LIMITS } from './tables';

const KIND_SET: ReadonlySet<string> = new Set(ORDER_KINDS);

export function isDirected(c: Pick<Combatant, 'controller' | 'side' | 'tier' | 'directed' | 'summonerId'>): boolean {
    if (c.controller === 'player' || c.side === 'player' || c.side === 'neutral' || c.summonerId) return false;
    return c.directed ?? DIRECTED_TIERS.has(c.tier);
}

export function activeOrder(state: Pick<CombatState, 'round'>, c: Pick<Combatant, 'controller' | 'side' | 'tier' | 'directed' | 'summonerId' | 'order'>): CombatOrder | null {
    const order = c.order;
    if (!order || order.round !== state.round || !isDirected(c)) return null;
    return order;
}

export function normalizeOrderKind(raw: unknown): OrderKind | undefined {
    if (typeof raw !== 'string') return undefined;
    const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return KIND_SET.has(key) ? key as OrderKind : undefined;
}

export function cleanLine(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    return text.length > ORDER_LIMITS.lineMax ? text.slice(0, ORDER_LIMITS.lineMax).trimEnd() : text;
}

export function resolveUnit(state: CombatState, ref: unknown): Combatant | undefined {
    if (typeof ref !== 'string' || !ref.trim()) return undefined;
    const exact = state.combatants[ref];
    if (exact) return exact;
    const name = ref.trim().toLowerCase();
    const named = Object.values(state.combatants).filter(c => c.name.toLowerCase() === name);
    return named.length === 1 ? named[0] : undefined;
}

export function hasActedThisTurn(state: CombatState, unitId: string): boolean {
    const turn = state.turn;
    if (!turn || turn.actorId !== unitId) return false;
    const fresh = freshTurn(state, unitId);
    return turn.actionUsed || !!turn.bonusUsed || turn.moveLeft < fresh.moveLeft || (turn.extraActions ?? 0) < (fresh.extraActions ?? 0);
}

export function yetToAct(state: CombatState, unitId: string): boolean {
    const index = state.order.indexOf(unitId);
    if (index < 0) return false;
    if (index > state.turnIndex) return true;
    if (index < state.turnIndex) return false;
    return !hasActedThisTurn(state, unitId);
}

export const ORDER_VERBS: Readonly<Record<OrderKind, string>> = {
    focus: 'focus',
    protect: 'protect',
    hold: 'hold position',
    fall_back: 'fall back',
    press: 'press the attack',
    signature: 'use the signature move',
    switch_tactic: 'switch tactics',
};

export function orderText(kind: OrderKind, target?: Combatant, tactic?: Tactic, signatureName?: string): string {
    switch (kind) {
        case 'focus':
        case 'protect':
            return `${ORDER_VERBS[kind]} ${target?.name ?? 'the target'}`;
        case 'signature':
            return signatureName ? `use ${signatureName}` : ORDER_VERBS.signature;
        case 'switch_tactic':
            return `switch to ${tactic ?? 'new'} tactics`;
        default:
            return ORDER_VERBS[kind];
    }
}

export type ApplyOrdersOptions = { onlyUnacted?: boolean };

export type ApplyOrdersResult = { state: CombatState; events: CombatEvent[]; rejected: OrderRejection[] };

export function applyOrders(state: CombatState, orders: readonly DirectorOrder[], options: ApplyOrdersOptions = {}): ApplyOrdersResult {
    const rejected: OrderRejection[] = [];
    const list = Array.isArray(orders) ? orders : [];
    const refuse = (o: DirectorOrder | undefined, reason: OrderRejectReason, text: string) => {
        rejected.push({ unitId: typeof o?.unitId === 'string' ? o.unitId : '', kind: typeof o?.kind === 'string' ? o.kind : '', reason, text });
    };
    if (state.outcome) {
        for (const o of list) refuse(o, 'fight_over', 'The fight is over.');
        return { state, events: [], rejected };
    }
    const draft = openDraft(state);
    const given = new Set<string>();
    for (const o of list) {
        if (!o || typeof o !== 'object') {
            refuse(undefined, 'unknown_unit', 'The order is not an object.');
            continue;
        }
        const unit = resolveUnit(draft.state, o.unitId);
        if (!unit) {
            refuse(o, 'unknown_unit', `There is no unit "${String(o.unitId)}".`);
            continue;
        }
        if (unit.status !== 'up') {
            refuse(o, 'not_standing', `${unit.name} is not standing.`);
            continue;
        }
        if (!isDirected(unit)) {
            refuse(o, 'not_directed', `${unit.name} is not a directed unit.`);
            continue;
        }
        const kind = normalizeOrderKind(o.kind);
        if (!kind) {
            refuse(o, 'unknown_kind', `"${String(o.kind)}" is not an order.`);
            continue;
        }
        if (given.has(unit.id)) {
            refuse(o, 'duplicate', `${unit.name} already has an order this round.`);
            continue;
        }
        if (options.onlyUnacted && !yetToAct(draft.state, unit.id)) {
            refuse(o, 'already_acted', `${unit.name} has already acted this round.`);
            continue;
        }
        let target: Combatant | undefined;
        let tactic: Tactic | undefined;
        if (kind === 'focus' || kind === 'protect') {
            if (typeof o.targetId !== 'string' || !o.targetId.trim()) {
                refuse(o, 'missing_target', `${kind} needs a target.`);
                continue;
            }
            target = resolveUnit(draft.state, o.targetId);
            if (!target) {
                refuse(o, 'unknown_target', `There is no unit "${o.targetId}".`);
                continue;
            }
            if (target.status !== 'up') {
                refuse(o, 'target_not_standing', `${target.name} is not standing.`);
                continue;
            }
            if (kind === 'focus' && !canTarget(unit, target)) {
                refuse(o, 'target_not_opponent', `${target.name} is not an opponent ${unit.name} can attack.`);
                continue;
            }
            if (kind === 'protect') {
                if (target.id === unit.id) {
                    refuse(o, 'target_is_self', `${unit.name} cannot protect themselves.`);
                    continue;
                }
                if (target.side === 'neutral' || !sameTeam(unit.side, target.side)) {
                    refuse(o, 'target_not_ally', `${target.name} is not an ally of ${unit.name}.`);
                    continue;
                }
            }
        }
        if (kind === 'signature') {
            if (!unit.signature) {
                refuse(o, 'no_signature', `${unit.name} has no signature move.`);
                continue;
            }
            if (unit.signature.usesLeft <= 0) {
                refuse(o, 'no_uses_left', `${unit.name}'s signature move has no uses left.`);
                continue;
            }
        }
        if (kind === 'switch_tactic') {
            tactic = normalizeTactic(o.tactic);
            if (!tactic) {
                refuse(o, 'unknown_tactic', `"${String(o.tactic)}" is not a tactic.`);
                continue;
            }
        }
        const live = draft.state.combatants[unit.id];
        const previous = live.order ?? null;
        const tacticBefore = live.tactic ?? null;
        const order: CombatOrder = { kind, ...(target ? { targetId: target.id } : {}), ...(tactic ? { tactic } : {}), round: draft.state.round };
        live.order = order;
        if (tactic) live.tactic = tactic;
        given.add(unit.id);
        const line = cleanLine(o.line);
        const sigName = kind === 'signature' ? live.kit?.find(a => a.id === live.signature?.abilityId)?.name : undefined;
        emit(draft, {
            type: ORDER_EVENT_TYPE,
            actorId: live.id,
            ...(target ? { targetId: target.id } : {}),
            data: {
                kind,
                round: order.round,
                ...(target ? { targetId: target.id } : {}),
                ...(tactic ? { tactic, tacticBefore } : {}),
                ...(sigName ? { signatureName: sigName } : {}),
                ...(line ? { line } : {}),
                previous,
            },
            text: `${live.name} orders: ${orderText(kind, target, tactic, sigName)}.`,
        });
    }
    if (draft.events.length === 0) return { state, events: [], rejected };
    const closed = closeDraft(draft);
    return { state: closed.state, events: closed.events, rejected };
}

export function undoDirectorEvent(combatants: Record<string, Combatant>, event: CombatEvent): boolean {
    if (event.type === 'ability' && event.data.signature === true && typeof event.data.usesLeft === 'number') {
        const user = event.actorId ? combatants[event.actorId] : undefined;
        if (user?.signature) user.signature = { ...user.signature, usesLeft: event.data.usesLeft + 1 };
        return false;
    }
    if (event.type !== ORDER_EVENT_TYPE) return false;
    const unit = event.actorId ? combatants[event.actorId] : undefined;
    if (!unit) return true;
    const previous = event.data.previous as CombatOrder | null | undefined;
    if (previous) unit.order = { ...previous };
    else delete unit.order;
    if ('tacticBefore' in event.data) {
        const before = event.data.tacticBefore as Tactic | null;
        if (before) unit.tactic = before;
        else delete unit.tactic;
    }
    return true;
}
