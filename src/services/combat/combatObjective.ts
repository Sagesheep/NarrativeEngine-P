import {
    REINFORCEMENT_LEVELS, buildMapFromSeed, normalizeObjectiveRequest, placeCombatants, planReinforcements, resolveMapSpec, validateObjective,
} from '@narrative/engine';
import type { CombatantSpec, ObjectiveRepair, ObjectiveRequest, ReinforcementLevel } from '@narrative/engine';
import { MAX_PROPOSED_COMBATANTS } from '../../types';
import type { CombatMapSpec, ProposedCombatant, ProposedObjective } from '../../types';

export const DEFAULT_WARD_NAME = 'Ward';
export const DEFAULT_BYSTANDER_NAME = 'Bystander';

const PREVIEW_SEED = 1;
const COORDINATE_FIELDS = ['exits', 'seize', 'reach', 'leaderExits'] as const;

function asRecord(raw: unknown): Record<string, unknown> | null {
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

function reinforcementLevel(raw: unknown): ReinforcementLevel | undefined {
    if (typeof raw !== 'string') return undefined;
    const key = raw.trim().toLowerCase();
    return (REINFORCEMENT_LEVELS as readonly string[]).includes(key) ? key as ReinforcementLevel : undefined;
}

export function parseProposedObjective(raw: unknown): ProposedObjective | null {
    const request = normalizeObjectiveRequest(raw);
    if (!request) return null;
    const rest: Partial<ObjectiveRequest> = { ...request };
    for (const field of COORDINATE_FIELDS) delete rest[field];
    const reinforcements = reinforcementLevel(asRecord(raw)?.reinforcements);
    return { ...(rest as ProposedObjective), ...(reinforcements ? { reinforcements } : {}) };
}

export function isPlainObjective(objective: ProposedObjective | undefined): boolean {
    if (!objective) return true;
    return objective.win === 'rout' && Object.keys(objective).every(k => k === 'win');
}

function baseName(name: string): string {
    return name.replace(/\s+\d+$/, '').trim().toLowerCase();
}

function matchIn(name: string, pool: readonly ProposedCombatant[]): string | undefined {
    const want = name.trim().toLowerCase();
    const exact = pool.find(c => c.name.trim().toLowerCase() === want);
    if (exact) return exact.name;
    const base = baseName(name);
    const kin = pool.filter(c => baseName(c.name) === base);
    if (kin.length > 0) return kin[0].name;
    const loose = pool.filter(c => {
        const n = c.name.trim().toLowerCase();
        return n.includes(want) || want.includes(n);
    });
    return loose.length === 1 ? loose[0].name : undefined;
}

export function matchUnitName(name: string | undefined, combatants: readonly ProposedCombatant[], side: ProposedCombatant['side']): string | undefined {
    if (!name || !name.trim()) return undefined;
    return matchIn(name, combatants.filter(c => c.side === side)) ?? matchIn(name, combatants);
}

export type ReconciledObjective = {
    combatants: ProposedCombatant[];
    objective?: ProposedObjective;
    added: Array<{ name: string; side: ProposedCombatant['side'] }>;
};

export function needsWard(objective: ProposedObjective): boolean {
    return objective.win === 'protect' || !!objective.lose?.includes('ward_falls');
}

export function needsLeader(objective: ProposedObjective): boolean {
    return objective.win === 'defeat_leader' || objective.with === 'defeat_leader' || !!objective.lose?.includes('leader_escapes');
}

export function needsBystander(objective: ProposedObjective): boolean {
    return objective.side === 'save_bystander';
}

function freshName(base: string, taken: readonly ProposedCombatant[]): string {
    const names = new Set(taken.map(c => c.name.trim().toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    for (let i = 2; i < 100; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
    return base;
}

export function reconcileObjective(
    combatants: readonly ProposedCombatant[],
    objective: ProposedObjective | undefined,
    limit: number = MAX_PROPOSED_COMBATANTS,
): ReconciledObjective {
    const list = combatants.map(c => ({ ...c }));
    const added: ReconciledObjective['added'] = [];
    if (!objective) return { combatants: list, added };
    const next: ProposedObjective = { ...objective };
    const leader = matchUnitName(next.leader, list, 'enemy');
    if (leader) next.leader = leader;

    const settle = (key: 'ward' | 'bystander', needed: boolean, side: 'ally' | 'neutral', fallback: string) => {
        if (!needed) {
            delete next[key];
            return;
        }
        const matched = matchUnitName(next[key], list, side);
        if (matched) {
            next[key] = matched;
            const index = list.findIndex(c => c.name === matched);
            if (index >= 0 && list[index].side === 'ally' && list[index].included !== true) list[index] = { ...list[index], included: true };
            return;
        }
        if (list.length >= limit) return;
        const wanted = next[key]?.trim();
        const name = wanted ? freshName(wanted, list) : freshName(fallback, list);
        list.push({ name, side, tier: 'grunt', ...(side === 'ally' ? { included: true } : {}) });
        added.push({ name, side });
        next[key] = name;
    };
    settle('ward', needsWard(next), 'ally', DEFAULT_WARD_NAME);
    settle('bystander', needsBystander(next), 'neutral', DEFAULT_BYSTANDER_NAME);
    return { combatants: list, objective: next, added };
}

export function objectiveSpecFields(objective: ProposedObjective | undefined): { objective?: ObjectiveRequest; reinforcements?: ReinforcementLevel } {
    if (!objective || isPlainObjective(objective)) return {};
    const { reinforcements, ...request } = objective;
    return { objective: request, ...(reinforcements ? { reinforcements } : {}) };
}

export function previewObjectiveRepairs(
    combatants: readonly ProposedCombatant[],
    objective: ProposedObjective | undefined,
    map?: CombatMapSpec,
): ObjectiveRepair[] {
    const fields = objectiveSpecFields(objective);
    if (!fields.objective) return [];
    const resolved = resolveMapSpec(map ?? {}, { combatants: combatants.length });
    const grid = buildMapFromSeed(resolved, PREVIEW_SEED);
    const entries = [{ id: 'pc', side: 'player' as const }, ...combatants.map((c, i) => ({ id: `c${i}`, side: c.side }))];
    const spawns = placeCombatants(grid, entries);
    const units = [
        { id: 'pc', name: 'You', side: 'player' as const, tier: 'grunt' as const, position: spawns.pc },
        ...combatants.map((c, i) => ({ id: `c${i}`, name: c.name, side: c.side, tier: c.tier, position: spawns[`c${i}`] })),
    ];
    const setup = { grid, combatants: units };
    const checked = validateObjective(fields.objective, setup);
    const specs: CombatantSpec[] = combatants.filter(c => c.side === 'enemy').map(c => ({ name: c.name, side: c.side, tier: c.tier }));
    const planned = planReinforcements(fields.reinforcements, checked.objective, specs, setup);
    return [...checked.repairs, ...planned.repairs];
}

const MAP_DEPENDENT: ReadonlySet<string> = new Set(['tile_moved', 'no_tile']);

export function objectiveToolNotes(
    combatants: readonly ProposedCombatant[],
    objective: ProposedObjective | undefined,
    map: CombatMapSpec | undefined,
    pre: readonly string[],
): string[] {
    const repairs = previewObjectiveRepairs(combatants, objective, map).filter(r => !MAP_DEPENDENT.has(r.code) && !(r.code === 'lose_added' && r.text.startsWith('Protect')));
    return [...pre, ...repairs.map(r => (r.code === 'unknown_kind' && r.field === 'win' ? `${r.text} The fight is a plain rout.` : r.text))];
}
