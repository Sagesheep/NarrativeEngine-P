import { applyDamage, canTarget, currentActorId, emit, markDown, setCondition } from '../core';
import type { Draft } from '../core';
import { distance } from '../grid';
import type { CombatCondition, Combatant, ElementId, Pos } from '../types';
import { BURNING, CONDITION_RIDERS, ELEMENT_NUMBERS } from '../elements/tables';
import type { ConditionRiderId } from '../elements/tables';
import { elementMultiplier } from '../elements/rules';
import { blockerLabel, previewPush } from './push';
import type { PushBlocker } from './push';

export type RiderUnit = {
    draft: Draft;
    user: Combatant;
    abilityName: string;
    element: ElementId;
    origin?: Pos;
};

function ownTurn(draft: Draft, target: Combatant): boolean {
    const s = draft.state;
    return currentActorId(s) === target.id && s.turn?.actorId === target.id;
}

export function addConditionRider(r: RiderUnit, target: Combatant, id: ConditionRiderId): void {
    const spec = CONDITION_RIDERS[id];
    const s = r.draft.state;
    const found = target.conditions.find(c => c.id === spec.condition);
    const before: CombatCondition | null = found ? { ...found } : null;
    setCondition(target, {
        id: spec.condition,
        turns: spec.turns,
        sourceId: r.user.id,
        ...(ownTurn(r.draft, target) ? { appliedTurn: s.turnCount ?? 0 } : {}),
        ...(spec.tag ? { element: spec.tag } : {}),
    });
    emit(r.draft, {
        type: 'element_rider',
        actorId: r.user.id,
        targetId: target.id,
        data: { element: r.element, rider: id, condition: spec.condition, turns: spec.turns, ability: r.abilityName, before },
        text: `${target.name} is ${spec.word}.`,
    });
}

export function consumeCondition(draft: Draft, c: Combatant, id: string, why: string): CombatCondition | null {
    const found = c.conditions.find(x => x.id === id);
    if (!found) return null;
    const before = { ...found };
    c.conditions = c.conditions.filter(x => x.id !== id);
    emit(draft, {
        type: 'condition_ended',
        targetId: c.id,
        data: { condition: id, consumed: true, why, before },
        text: `${c.name} is no longer ${id}.`,
    });
    return before;
}

export function pushRider(r: RiderUnit, target: Combatant, squares: number): { moved: number; blocked: boolean; stoppedBy?: PushBlocker } {
    const s = r.draft.state;
    const plan = previewPush(s, r.user.id, target.id, 'push', squares, r.origin ? { origin: r.origin } : {});
    if (!plan) return { moved: 0, blocked: false };
    const blocked = plan.squares < squares || plan.slid;
    if (plan.squares === 0) return { moved: 0, blocked, ...(plan.stoppedBy ? { stoppedBy: plan.stoppedBy } : {}) };
    target.position = { ...plan.landing };
    const unit = plan.squares === 1 ? 'square' : 'squares';
    const stopped = plan.stoppedBy;
    const why = stopped ? `, stopped by ${blockerLabel(stopped, id => s.combatants[id]?.name ?? 'another creature')}` : '';
    emit(r.draft, {
        type: 'pushed',
        actorId: r.user.id,
        targetId: target.id,
        data: {
            kind: 'push', squares: plan.squares, ability: r.abilityName, element: r.element, rider: true,
            moves: [{ id: target.id, from: { ...plan.from }, to: { ...plan.landing } }],
            ...(stopped ? { stopped } : {}), ...(plan.slid ? { slid: true } : {}),
        },
        text: `${target.name} is driven back ${plan.squares} ${unit}${why}.`,
    });
    return { moved: plan.squares, blocked, ...(stopped ? { stoppedBy: stopped } : {}) };
}

export function elementStrike(
    draft: Draft, source: Combatant, target: Combatant, element: ElementId, base: number, ability: string, kind: 'arc' | 'impact',
    extra: Record<string, unknown> = {},
): number {
    if (target.status !== 'up' || base <= 0) return 0;
    const mult = elementMultiplier(target, element);
    const amount = Math.floor(base * mult.factor);
    if (amount <= 0) {
        if (mult.immune) {
            emit(draft, {
                type: 'ability_damage',
                actorId: source.id,
                targetId: target.id,
                data: {
                    ability, kind, damage: 0, damageType: element, element, saved: false, crit: false, weakness: false, resisted: false, immune: true,
                    absorbed: 0, hpBefore: target.hp, tempBefore: target.tempHp ?? 0, hpAfter: target.hp, ...extra,
                },
                text: `${target.name} is immune to ${element}.`,
            });
        }
        return 0;
    }
    const result = applyDamage(target, amount);
    emit(draft, {
        type: 'ability_damage',
        actorId: source.id,
        targetId: target.id,
        data: {
            ability, kind, damage: amount, damageType: element, element, saved: false, crit: false, weakness: mult.factor > 1, resisted: mult.factor < 1,
            absorbed: result.absorbed, hpBefore: result.hpBefore, tempBefore: result.tempBefore, hpAfter: target.hp, ...extra,
        },
        text: kind === 'arc'
            ? `Lightning arcs to ${target.name} for ${amount} damage.`
            : `${target.name} slams into the obstacle for ${amount} ${element} damage.`,
    });
    if (target.hp <= 0) markDown(draft, target, { actorId: source.id });
    return amount;
}

export function arcRider(r: RiderUnit, primary: Combatant, base: number, exclude: ReadonlySet<string> = new Set(), conduct?: () => void): void {
    const at = primary.position;
    if (!at || base <= 0) return;
    const pool = Object.values(r.draft.state.combatants)
        .filter(c => c.status === 'up' && c.id !== r.user.id && c.id !== primary.id && !exclude.has(c.id) && !!c.position && distance(c.position, at) <= 1 && canTarget(r.user, c))
        .sort((a, b) => (a.hp - b.hp) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (conduct && pool.length > 0) conduct();
    for (const next of conduct ? pool : pool.slice(0, 1)) {
        elementStrike(r.draft, r.user, next, r.element, Math.floor(base * ELEMENT_NUMBERS.arcShare), r.abilityName, 'arc', { arc: true, fromId: primary.id });
    }
}

export function impactRider(r: RiderUnit, target: Combatant): void {
    const roll = r.draft.rng.roll(ELEMENT_NUMBERS.impactDie);
    elementStrike(r.draft, r.user, target, r.element, roll, r.abilityName, 'impact', { impact: true });
}

export function burnTick(draft: Draft, c: Combatant): void {
    if (c.status !== 'up') return;
    const cond = c.conditions.find(x => x.id === BURNING);
    if (!cond) return;
    const mult = elementMultiplier(c, 'fire');
    const amount = Math.floor(ELEMENT_NUMBERS.burnDamage * mult.factor);
    if (amount <= 0) return;
    const result = applyDamage(c, amount);
    emit(draft, {
        type: 'burn',
        targetId: c.id,
        data: {
            element: 'fire', ...(cond.sourceId ? { sourceId: cond.sourceId } : {}), damage: amount, damageType: 'fire', weakness: mult.factor > 1, resisted: mult.factor < 1,
            absorbed: result.absorbed, hpBefore: result.hpBefore, tempBefore: result.tempBefore, hpAfter: c.hp,
        },
        text: `${c.name} takes ${amount} fire damage from burning.`,
    });
    if (c.hp <= 0) markDown(draft, c, {});
}
