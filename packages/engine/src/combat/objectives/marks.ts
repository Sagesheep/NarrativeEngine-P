import type { CombatObjective, CombatState, Combatant, PairedWin, Pos, Side } from '../types';

export type ObjectiveMarks = {
    exits: Pos[];
    leaderExits: Pos[];
    seize?: Pos;
    reach?: Pos;
    leaderId?: string;
    wardId?: string;
    bystanderId?: string;
    incoming: Array<{ waveId: string; round: number; tiles: Pos[]; count: number }>;
};

export type ObjectiveClock = { kind: 'survive' | 'protect' | 'round_limit'; round: number; left: number };

export function isPartySide(side: Side): boolean {
    return side === 'player' || side === 'ally';
}

export function onTiles(tiles: readonly Pos[] | undefined, p: Pos | undefined): boolean {
    return !!p && !!tiles && tiles.some(t => t.x === p.x && t.y === p.y);
}

export function mainWin(o: CombatObjective): PairedWin | null {
    if (o.win.kind === 'protect') return o.win.with ?? null;
    return o.win;
}

export function wardIdOf(o: CombatObjective): string | undefined {
    if (o.win.kind === 'protect') return o.win.wardId;
    const lose = o.lose?.find(l => l.kind === 'ward_falls');
    return lose && lose.kind === 'ward_falls' ? lose.wardId : undefined;
}

export function leaderIdOf(o: CombatObjective): string | undefined {
    const win = mainWin(o);
    if (win?.kind === 'defeat_leader') return win.leaderId;
    const lose = o.lose?.find(l => l.kind === 'leader_escapes');
    return lose && lose.kind === 'leader_escapes' ? lose.leaderId : undefined;
}

export function exitsOf(o: CombatObjective): Pos[] {
    const win = mainWin(o);
    return win?.kind === 'escape' ? win.exits : [];
}

export function leaderExitsOf(o: CombatObjective): Pos[] {
    const lose = o.lose?.find(l => l.kind === 'leader_escapes');
    return lose && lose.kind === 'leader_escapes' ? lose.exits : [];
}

export function seizeTileOf(o: CombatObjective): Pos | undefined {
    const win = mainWin(o);
    return win?.kind === 'seize' ? win.tile : undefined;
}

export function reachTileOf(o: CombatObjective): Pos | undefined {
    return o.side?.kind === 'reach_tile' ? o.side.tile : undefined;
}

export function bystanderIdOf(o: CombatObjective): string | undefined {
    return o.side?.kind === 'save_bystander' ? o.side.bystanderId : undefined;
}

export function hasLose(o: CombatObjective, kind: string): boolean {
    return !!o.lose?.some(l => l.kind === kind);
}

export function objectiveMarks(state: Pick<CombatState, 'objective' | 'reinforcements'>): ObjectiveMarks {
    const o = state.objective;
    const incoming = (state.reinforcements?.waves ?? [])
        .filter(w => !w.done && typeof w.arriveRound === 'number' && !!w.tiles)
        .map(w => ({ waveId: w.id, round: w.arriveRound as number, tiles: (w.tiles as Pos[]).map(p => ({ ...p })), count: w.units.length }));
    if (!o) return { exits: [], leaderExits: [], incoming };
    const seize = seizeTileOf(o);
    const reach = reachTileOf(o);
    const leaderId = leaderIdOf(o);
    const wardId = wardIdOf(o);
    const bystanderId = bystanderIdOf(o);
    return {
        exits: exitsOf(o).map(p => ({ ...p })),
        leaderExits: leaderExitsOf(o).map(p => ({ ...p })),
        ...(seize ? { seize: { ...seize } } : {}),
        ...(reach ? { reach: { ...reach } } : {}),
        ...(leaderId ? { leaderId } : {}),
        ...(wardId ? { wardId } : {}),
        ...(bystanderId ? { bystanderId } : {}),
        incoming,
    };
}

export function objectiveClock(state: Pick<CombatState, 'objective' | 'round'>): ObjectiveClock | null {
    const o = state.objective;
    if (!o) return null;
    const win = mainWin(o);
    let clock: ObjectiveClock | null = null;
    const consider = (kind: ObjectiveClock['kind'], round: number) => {
        if (!clock || round < clock.round) clock = { kind, round, left: Math.max(0, round - state.round + 1) };
    };
    if (win?.kind === 'survive') consider('survive', win.rounds);
    if (o.win.kind === 'protect' && !o.win.with && typeof o.win.rounds === 'number') consider('protect', o.win.rounds);
    if (typeof o.roundLimit === 'number' && hasLose(o, 'round_limit')) consider('round_limit', o.roundLimit);
    return clock;
}

export function unitOf(state: Pick<CombatState, 'combatants'>, id: string | undefined): Combatant | undefined {
    return id ? state.combatants[id] : undefined;
}
