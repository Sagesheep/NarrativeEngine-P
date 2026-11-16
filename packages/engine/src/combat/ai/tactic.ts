import { rangeOf } from '../grid';
import type { Combatant, Tactic } from '../types';
import { DEFAULT_TACTIC, TACTIC_DERIVATION, TACTICS } from './tables';
import type { TacticRule } from './tables';

const TACTIC_SET: ReadonlySet<string> = new Set(TACTICS);

export function normalizeTactic(raw: unknown): Tactic | undefined {
    if (typeof raw !== 'string') return undefined;
    const key = raw.trim().toLowerCase();
    return TACTIC_SET.has(key) ? key as Tactic : undefined;
}

function heals(c: Pick<Combatant, 'kit'>): boolean {
    return (c.kit ?? []).some(a => a.effects.some(e => e.id === 'heal' || e.id === 'shield'));
}

function matches(rule: TacticRule, c: Pick<Combatant, 'kit' | 'range' | 'archetype'>): boolean {
    if ('archetype' in rule) return c.archetype === rule.archetype;
    if (rule.when === 'heals') return heals(c);
    return rangeOf(c) === 'ranged' || c.archetype === 'caster';
}

export function deriveTactic(c: Pick<Combatant, 'kit' | 'range' | 'archetype'>): Tactic {
    return TACTIC_DERIVATION.find(rule => matches(rule, c))?.tactic ?? DEFAULT_TACTIC;
}

export function tacticOf(c: Pick<Combatant, 'kit' | 'range' | 'archetype' | 'tactic'>): Tactic {
    return normalizeTactic(c.tactic) ?? deriveTactic(c);
}
