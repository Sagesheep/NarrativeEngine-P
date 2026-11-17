import type { CombatCondition, CombatEvent, Combatant } from '../types';

function restoreCondition(c: Combatant, id: string, before: unknown): void {
    const kept = c.conditions.filter(x => x.id !== id);
    const old = before && typeof before === 'object' && (before as CombatCondition).id === id ? { ...(before as CombatCondition) } : null;
    c.conditions = old ? [...kept, old] : kept;
}

export function undoElementEvent(combatants: Record<string, Combatant>, event: CombatEvent): boolean {
    if (event.type === 'confused') return true;
    const target = event.targetId ? combatants[event.targetId] : undefined;
    if (event.type === 'reaction') {
        if (target && typeof event.data.condition === 'string') restoreCondition(target, event.data.condition, event.data.before);
        return true;
    }
    if (event.type === 'element_rider') {
        if (target && typeof event.data.condition === 'string') restoreCondition(target, event.data.condition, event.data.before);
        return true;
    }
    if (event.type === 'condition_ended' && event.data.consumed === true) {
        if (target && typeof event.data.condition === 'string') restoreCondition(target, event.data.condition, event.data.before);
        return true;
    }
    return false;
}
