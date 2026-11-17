import type { CombatCondition, CombatEvent, Combatant, Pos } from '../types';

function isPos(raw: unknown): raw is Pos {
    return !!raw && typeof raw === 'object' && typeof (raw as Pos).x === 'number' && typeof (raw as Pos).y === 'number';
}

function conditionsOf(raw: unknown): CombatCondition[] | null {
    return Array.isArray(raw) ? raw.filter(c => c && typeof c === 'object' && typeof (c as CombatCondition).id === 'string').map(c => ({ ...(c as CombatCondition) })) : null;
}

function setTemp(c: Combatant, raw: unknown): void {
    if (typeof raw === 'number' && raw > 0) c.tempHp = raw;
    else delete c.tempHp;
}

export function undoGlyphEvent(combatants: Record<string, Combatant>, event: CombatEvent): boolean {
    const target = event.targetId ? combatants[event.targetId] : undefined;
    switch (event.type) {
        case 'gravity':
            return true;
        case 'condition_added': {
            if (event.data.glyph !== true) return false;
            if (target && typeof event.data.condition === 'string') {
                const id = event.data.condition;
                const before = event.data.before as CombatCondition | null | undefined;
                const kept = target.conditions.filter(c => c.id !== id);
                target.conditions = before && before.id === id ? [...kept, { ...before }] : kept;
            }
            return true;
        }
        case 'dispelled': {
            const before = conditionsOf(event.data.before);
            if (target && before) {
                target.conditions = before;
                setTemp(target, event.data.tempBefore);
            }
            return true;
        }
        case 'decayed': {
            if (target) {
                if (typeof event.data.maxBefore === 'number') target.maxHp = event.data.maxBefore;
                if (typeof event.data.hpBefore === 'number') target.hp = event.data.hpBefore;
                setTemp(target, event.data.tempBefore);
                const decayed = typeof event.data.decayedBefore === 'number' ? event.data.decayedBefore : 0;
                if (decayed > 0) target.decayed = decayed;
                else delete target.decayed;
            }
            return true;
        }
        case 'rewound': {
            const before = event.data.before as { pos?: unknown; hp?: unknown; tempHp?: unknown; conditions?: unknown } | undefined;
            if (target && before) {
                if (isPos(before.pos)) target.position = { x: before.pos.x, y: before.pos.y };
                if (typeof before.hp === 'number') target.hp = before.hp;
                setTemp(target, before.tempHp);
                const conditions = conditionsOf(before.conditions);
                if (conditions) target.conditions = conditions;
            }
            return true;
        }
        default:
            return false;
    }
}
