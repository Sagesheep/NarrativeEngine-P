import { SPAWN_COLUMNS } from '../areas/canvas';
import { distance, distanceField, inBounds, speedOf, tileAt } from '../grid';
import { TIER_LEVEL } from '../abilities';
import type {
    CombatantSpec, CombatObjective, CombatTier, Combatant, Grid, LoseCondition, LoseKind, ObjectiveRepair, ObjectiveRequest, PairedWin, Pos,
    ReinforcementEdge, ReinforcementLevel, ReinforcementRequest, ReinforcementTrigger, RepairCode, SideKind, SideObjective, WinCondition, WinKind,
} from '../types';
import { leaderIdOf, mainWin, reachTileOf, seizeTileOf, exitsOf } from './marks';
import {
    LOSE_KINDS, OBJECTIVE_LIMITS, REINFORCEMENT_BUDGET, REINFORCEMENT_KIND_SCALE, REINFORCEMENT_LEVELS, REINFORCEMENT_MIN_BUDGET,
    REINFORCEMENT_THREAT, REINFORCEMENT_WAVES, SIDE_KINDS, WIN_KINDS,
} from './tables';
import type { Bounds } from './tables';

export type ObjectiveSetupUnit = Pick<Combatant, 'id' | 'name' | 'side' | 'tier'> & { position?: Pos; speed?: number };

export type ObjectiveSetup = { grid: Grid; combatants: readonly ObjectiveSetupUnit[] };

export type WavePlan = { id: string; trigger: ReinforcementTrigger; edge: ReinforcementEdge; combatants: CombatantSpec[] };

export type ReinforcementPlan = { budget: number; waves: WavePlan[] };

type Repairs = ObjectiveRepair[];

function note(repairs: Repairs, field: string, code: RepairCode, text: string, from?: unknown, to?: unknown): void {
    repairs.push({ field, code, text, ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) });
}

function asRecord(raw: unknown): Record<string, unknown> | null {
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

function keyOf(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
}

function posOf(raw: unknown): Pos | undefined {
    const r = asRecord(raw);
    return r && typeof r.x === 'number' && typeof r.y === 'number' && Number.isFinite(r.x) && Number.isFinite(r.y)
        ? { x: Math.round(r.x), y: Math.round(r.y) } : undefined;
}

function numOf(raw: unknown): number | undefined {
    return typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : undefined;
}

function strOf(raw: unknown): string | undefined {
    return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 80) : undefined;
}

export function normalizeObjectiveRequest(raw: unknown): ObjectiveRequest | null {
    if (typeof raw === 'string') return keyOf(raw) ? { win: keyOf(raw) } : null;
    const r = asRecord(raw);
    if (!r) return null;
    const win = keyOf(r.win ?? r.kind);
    if (!win) return null;
    const out: ObjectiveRequest = { win };
    const withKind = keyOf(r.with);
    if (withKind) out.with = withKind;
    for (const k of ['leader', 'ward', 'bystander'] as const) {
        const v = strOf(r[k]);
        if (v) out[k] = v;
    }
    const rounds = numOf(r.rounds);
    if (rounds !== undefined) out.rounds = rounds;
    if (typeof r.everyone === 'boolean') out.everyone = r.everyone;
    const lose = Array.isArray(r.lose) ? r.lose.map(keyOf).filter(Boolean) : typeof r.lose === 'string' ? [keyOf(r.lose)].filter(Boolean) : [];
    if (lose.length > 0) out.lose = lose;
    const side = keyOf(r.side);
    if (side) out.side = side;
    const sideRounds = numOf(r.sideRounds);
    if (sideRounds !== undefined) out.sideRounds = sideRounds;
    const roundLimit = numOf(r.roundLimit);
    if (roundLimit !== undefined) out.roundLimit = roundLimit;
    if (Array.isArray(r.exits)) out.exits = r.exits.map(posOf).filter((p): p is Pos => !!p);
    if (Array.isArray(r.leaderExits)) out.leaderExits = r.leaderExits.map(posOf).filter((p): p is Pos => !!p);
    const seize = posOf(r.seize);
    if (seize) out.seize = seize;
    const reach = posOf(r.reach);
    if (reach) out.reach = reach;
    return out;
}

export function normalizeReinforcementRequest(raw: unknown): ReinforcementRequest | null {
    const key = keyOf(raw);
    if (key && (REINFORCEMENT_LEVELS as readonly string[]).includes(key)) return key as ReinforcementLevel;
    const r = asRecord(raw);
    if (r && Array.isArray(r.waves)) return { waves: r.waves.filter(w => !!asRecord(w) && Array.isArray((w as { combatants?: unknown }).combatants)) as never };
    return null;
}

function clampTo(repairs: Repairs, field: string, raw: number | undefined, b: Bounds): number {
    if (raw === undefined) return b.fallback;
    const v = Math.min(b.max, Math.max(b.min, raw));
    if (v !== raw) note(repairs, field, 'clamped', `${field} ${raw} is outside ${b.min} to ${b.max}; set to ${v}.`, raw, v);
    return v;
}

function findUnit(setup: ObjectiveSetup, ref: string | undefined): ObjectiveSetupUnit | undefined {
    if (!ref) return undefined;
    const want = ref.trim().toLowerCase();
    return setup.combatants.find(c => c.id === ref) ?? setup.combatants.find(c => c.name.trim().toLowerCase() === want);
}

function interior(grid: Grid, p: Pos): boolean {
    return p.x >= SPAWN_COLUMNS && p.x < grid.width - SPAWN_COLUMNS;
}

function onBorder(grid: Grid, p: Pos): boolean {
    return p.x === 0 || p.y === 0 || p.x === grid.width - 1 || p.y === grid.height - 1;
}

function idx(grid: Grid, p: Pos): number {
    return p.y * grid.width + p.x;
}

type Geo = {
    grid: Grid;
    pc: ObjectiveSetupUnit;
    occupied: Set<number>;
    party: number[];
    enemy: number[];
    minDist: number;
    reachDist: number;
    leaderDist: number;
    anyBorder: boolean;
};

function markable(geo: Geo, p: Pos): boolean {
    const t = tileAt(geo.grid, p);
    return inBounds(geo.grid, p) && (t === 'floor' || t === 'difficult') && interior(geo.grid, p) && !geo.occupied.has(idx(geo.grid, p))
        && Number.isFinite(geo.party[idx(geo.grid, p)]);
}

function allTiles(grid: Grid): Pos[] {
    const out: Pos[] = [];
    for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) out.push({ x, y });
    return out;
}

function best(tiles: Pos[], score: (p: Pos) => number): Pos | undefined {
    let top: { p: Pos; s: number } | undefined;
    for (const p of tiles) {
        const s = score(p);
        if (!top || s > top.s || (s === top.s && (p.y < top.p.y || (p.y === top.p.y && p.x < top.p.x)))) top = { p, s };
    }
    return top?.p;
}

function nearestValid(valid: Pos[], to: Pos): Pos | undefined {
    return best(valid, p => -distance(p, to));
}

function exitOk(geo: Geo, p: Pos): boolean {
    return markable(geo, p) && geo.party[idx(geo.grid, p)] >= geo.minDist && (onBorder(geo.grid, p) || !geo.anyBorder);
}

function growGate(anchor: Pos, ok: (p: Pos) => boolean): Pos[] {
    const gate = [anchor];
    const queue = [anchor];
    while (queue.length > 0 && gate.length < OBJECTIVE_LIMITS.exitWidth) {
        const here = queue.shift() as Pos;
        const around: Pos[] = [];
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const q = { x: here.x + dx, y: here.y + dy };
                if ((dx || dy) && ok(q) && !gate.some(g => g.x === q.x && g.y === q.y)) around.push(q);
            }
        }
        around.sort((a, b) => (a.y - b.y) || (a.x - b.x));
        for (const q of around) {
            if (gate.length >= OBJECTIVE_LIMITS.exitWidth) break;
            gate.push(q);
            queue.push(q);
        }
    }
    return gate.sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

function chooseExits(geo: Geo, requested: Pos[] | undefined, repairs: Repairs, field: string): Pos[] | null {
    const valid = allTiles(geo.grid).filter(p => exitOk(geo, p));
    if (valid.length === 0) return null;
    let anchor: Pos | undefined;
    if (requested && requested.length > 0) {
        const kept = requested.filter(p => exitOk(geo, p));
        if (kept.length === requested.length) return requested.map(p => ({ ...p }));
        anchor = kept[0] ?? nearestValid(valid, requested[0]);
        note(repairs, field, 'tile_moved', 'An exit tile was not usable; it was moved to the nearest valid edge tile.', requested, anchor);
    }
    anchor ??= best(valid, p => geo.party[idx(geo.grid, p)] * 10 + p.x / geo.grid.width);
    if (!anchor) return null;
    return growGate(anchor, q => exitOk(geo, q));
}

function chooseLeaderExits(geo: Geo, leader: ObjectiveSetupUnit, requested: Pos[] | undefined, repairs: Repairs): Pos[] | null {
    if (!leader.position) return null;
    const own = distanceField(geo.grid, [leader.position]);
    const ok = (p: Pos) => markable(geo, p) && (onBorder(geo.grid, p) || !geo.anyBorder) && own[idx(geo.grid, p)] >= geo.leaderDist;
    const valid = allTiles(geo.grid).filter(ok);
    if (valid.length === 0) return null;
    let anchor: Pos | undefined;
    if (requested && requested.length > 0) {
        const kept = requested.filter(ok);
        if (kept.length === requested.length) return requested.map(p => ({ ...p }));
        anchor = kept[0] ?? nearestValid(valid, requested[0]);
        note(repairs, 'leaderExits', 'tile_moved', 'A leader exit tile was not usable; it was moved to the nearest valid edge tile.', requested, anchor);
    }
    const lead = (p: Pos) => own[idx(geo.grid, p)] - geo.party[idx(geo.grid, p)];
    const fair = valid.filter(p => lead(p) >= OBJECTIVE_LIMITS.leaderLead);
    anchor ??= best(fair.length > 0 ? fair : valid, p => own[idx(geo.grid, p)] * 10 + lead(p));
    return anchor ? growGate(anchor, ok) : null;
}

function coverAround(grid: Grid, p: Pos): number {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const t = tileAt(grid, { x: p.x + dx, y: p.y + dy });
            if (t === 'cover') n += 2;
            else if (t === 'wall' && inBounds(grid, { x: p.x + dx, y: p.y + dy })) n += 0.5;
            else if (t === 'hazard') n -= 3;
        }
    }
    return n;
}

function chooseTile(geo: Geo, requested: Pos | undefined, ok: (p: Pos) => boolean, score: (p: Pos) => number, repairs: Repairs, field: string): Pos | null {
    const valid = allTiles(geo.grid).filter(ok);
    if (valid.length === 0) return null;
    if (requested) {
        if (ok(requested)) return { ...requested };
        const moved = nearestValid(valid, requested) as Pos;
        note(repairs, field, 'tile_moved', `The ${field} tile was not usable; it was moved to the nearest valid tile.`, requested, moved);
        return moved;
    }
    return best(valid, score) ?? null;
}

function chooseSeize(geo: Geo, requested: Pos | undefined, repairs: Repairs): Pos | null {
    const ok = (p: Pos) => markable(geo, p) && geo.party[idx(geo.grid, p)] >= geo.minDist;
    return chooseTile(geo, requested, ok, p => 2 * coverAround(geo.grid, p) - geo.enemy[idx(geo.grid, p)], repairs, 'seize');
}

function chooseReach(geo: Geo, requested: Pos | undefined, avoid: Pos[], repairs: Repairs): Pos | null {
    const ok = (p: Pos) => markable(geo, p) && geo.party[idx(geo.grid, p)] >= geo.reachDist && !avoid.some(a => a.x === p.x && a.y === p.y);
    const mid = (geo.grid.height - 1) / 2;
    return chooseTile(geo, requested, ok, p => Math.min(geo.party[idx(geo.grid, p)], geo.enemy[idx(geo.grid, p)]) + 0.5 * Math.abs(p.y - mid), repairs, 'reach');
}

function leaderFallback(setup: ObjectiveSetup): ObjectiveSetupUnit | undefined {
    const enemies = setup.combatants.filter(c => c.side === 'enemy');
    if (enemies.length === 1) return enemies[0];
    const top = Math.max(...enemies.map(e => TIER_LEVEL[e.tier] ?? 0));
    const tops = enemies.filter(e => (TIER_LEVEL[e.tier] ?? 0) === top);
    return tops.length === 1 ? tops[0] : undefined;
}

function resolveLeader(setup: ObjectiveSetup, ref: string | undefined, field: string, repairs: Repairs): ObjectiveSetupUnit | undefined {
    const named = findUnit(setup, ref);
    if (named && named.side === 'enemy') return named;
    if (named) note(repairs, field, 'wrong_side', `${named.name} is not an enemy and cannot be the leader.`, ref);
    else if (ref) note(repairs, field, 'missing_unit', `No combatant called ${ref} is in the fight.`, ref);
    const picked = leaderFallback(setup);
    if (picked) note(repairs, field, 'picked_leader', `${picked.name} was made the leader.`, ref, picked.id);
    return picked;
}

function resolveSided(setup: ObjectiveSetup, ref: string | undefined, field: string, ok: (c: ObjectiveSetupUnit) => boolean, role: string, repairs: Repairs): ObjectiveSetupUnit | undefined {
    const named = findUnit(setup, ref);
    if (named && ok(named)) return named;
    if (named) note(repairs, field, 'wrong_side', `${named.name} cannot be the ${role}.`, ref);
    else note(repairs, field, 'missing_unit', ref ? `No combatant called ${ref} is in the fight to be the ${role}.` : `No ${role} was named.`, ref);
    return undefined;
}

function isWin(k: string): k is WinKind {
    return (WIN_KINDS as readonly string[]).includes(k);
}

function buildPaired(kind: Exclude<WinKind, 'protect'>, request: ObjectiveRequest, setup: ObjectiveSetup, geo: Geo, repairs: Repairs, field: string): PairedWin | null {
    switch (kind) {
        case 'rout':
            return { kind: 'rout' };
        case 'defeat_leader': {
            const leader = resolveLeader(setup, request.leader, 'leader', repairs);
            return leader ? { kind: 'defeat_leader', leaderId: leader.id } : null;
        }
        case 'survive':
            return { kind: 'survive', rounds: clampTo(repairs, 'rounds', request.rounds, OBJECTIVE_LIMITS.survive) };
        case 'escape': {
            const exits = chooseExits(geo, request.exits, repairs, field === 'win' ? 'exits' : 'with.exits');
            if (!exits) {
                note(repairs, 'exits', 'no_tile', 'No usable exit could be placed on this map.');
                return null;
            }
            return { kind: 'escape', exits, everyone: request.everyone === true };
        }
        case 'seize': {
            const tile = chooseSeize(geo, request.seize, repairs);
            if (!tile) {
                note(repairs, 'seize', 'no_tile', 'No usable tile to seize could be placed on this map.');
                return null;
            }
            return { kind: 'seize', tile };
        }
    }
}

function geometry(setup: ObjectiveSetup): Geo | null {
    const pc = setup.combatants.find(c => c.side === 'player');
    if (!pc?.position) return null;
    const grid = setup.grid;
    const occupied = new Set<number>(setup.combatants.filter(c => c.position && inBounds(grid, c.position)).map(c => idx(grid, c.position as Pos)));
    const party = distanceField(grid, [pc.position]);
    const enemyStarts = setup.combatants.filter(c => c.side === 'enemy' && c.position).map(c => c.position as Pos);
    const enemy = distanceField(grid, enemyStarts);
    const span = Math.max(grid.width, grid.height);
    const geo: Geo = {
        grid, pc, occupied, party, enemy,
        minDist: Math.max(3, Math.round(span * OBJECTIVE_LIMITS.markShare)),
        reachDist: Math.max(2, Math.round(span * OBJECTIVE_LIMITS.reachShare)),
        leaderDist: Math.max(3, Math.round(span * OBJECTIVE_LIMITS.leaderExitShare)),
        anyBorder: false,
    };
    geo.anyBorder = allTiles(grid).some(p => onBorder(grid, p) && markable(geo, p) && party[idx(grid, p)] >= geo.minDist);
    return geo;
}

export function validateObjective(raw: ObjectiveRequest | unknown, setup: ObjectiveSetup): { objective: CombatObjective; repairs: ObjectiveRepair[] } {
    const repairs: Repairs = [];
    const request = normalizeObjectiveRequest(raw);
    const rout = (): { objective: CombatObjective; repairs: ObjectiveRepair[] } => ({ objective: { win: { kind: 'rout' } }, repairs });
    const fallback = (why: string) => {
        note(repairs, 'win', 'fallback_rout', `${why} The fight is a plain rout instead.`);
        return rout();
    };
    if (!request) return rout();
    const geo = geometry(setup);
    if (!geo) return fallback('The fight has no placed player character.');
    let kind = request.win;
    if (!isWin(kind)) {
        note(repairs, 'win', 'unknown_kind', `Unknown win condition "${kind}".`, kind, 'rout');
        kind = 'rout';
    }
    let win: WinCondition;
    if (kind === 'protect') {
        const ward = resolveSided(setup, request.ward, 'ward', c => c.side === 'ally', 'ward (an ally)', repairs);
        if (!ward) return fallback('Protect needs a ward on the player\'s side.');
        let paired: PairedWin | undefined;
        if (request.with) {
            const inner = request.with;
            if (isWin(inner) && inner !== 'protect') {
                const built = buildPaired(inner, request, setup, geo, repairs, 'with');
                if (built) paired = built;
                else note(repairs, 'with', 'unknown_kind', `The paired condition ${inner} could not be set up; the ward must survive a number of rounds instead.`, inner);
            } else {
                note(repairs, 'with', 'unknown_kind', `Unknown paired condition "${inner}"; the ward must survive a number of rounds instead.`, inner);
            }
        }
        win = paired
            ? { kind: 'protect', wardId: ward.id, with: paired }
            : { kind: 'protect', wardId: ward.id, rounds: clampTo(repairs, 'rounds', request.rounds, OBJECTIVE_LIMITS.protect) };
    } else {
        const built = buildPaired(kind as Exclude<WinKind, 'protect'>, request, setup, geo, repairs, 'win');
        if (!built) return fallback(`The ${kind} condition could not be set up.`);
        win = built;
    }
    const objective: CombatObjective = { win };
    const lose: LoseCondition[] = [];
    const wardOfWin = win.kind === 'protect' ? win.wardId : undefined;
    let roundLimit: number | undefined;
    const wanted = [...new Set(request.lose ?? [])];
    if (request.roundLimit !== undefined && !wanted.includes('round_limit')) {
        wanted.push('round_limit');
        note(repairs, 'lose', 'lose_added', 'A round limit was given, so running out of rounds loses the fight.');
    }
    if (wardOfWin && !wanted.includes('ward_falls')) {
        wanted.push('ward_falls');
        note(repairs, 'lose', 'lose_added', 'Protect always loses if the ward falls.');
    }
    for (const k of wanted) {
        if (!(LOSE_KINDS as readonly string[]).includes(k)) {
            note(repairs, 'lose', 'lose_dropped', `Unknown lose condition "${k}" was dropped.`, k);
            continue;
        }
        const lk = k as LoseKind;
        if (lk === 'pc_falls') lose.push({ kind: 'pc_falls' });
        else if (lk === 'ward_falls') {
            const ward = wardOfWin ? setup.combatants.find(c => c.id === wardOfWin) : resolveSided(setup, request.ward, 'ward', c => c.side === 'ally', 'ward (an ally)', repairs);
            if (ward) lose.push({ kind: 'ward_falls', wardId: ward.id });
            else note(repairs, 'lose', 'lose_dropped', 'ward_falls was dropped: there is no ward.', k);
        } else if (lk === 'round_limit') {
            roundLimit = clampTo(repairs, 'roundLimit', request.roundLimit, OBJECTIVE_LIMITS.roundLimit);
            lose.push({ kind: 'round_limit' });
        } else {
            const main = mainWin(objective);
            const leader = main?.kind === 'defeat_leader' ? setup.combatants.find(c => c.id === main.leaderId) : resolveLeader(setup, request.leader, 'leader', repairs);
            const exits = leader ? chooseLeaderExits(geo, leader, request.leaderExits, repairs) : null;
            if (leader && exits) lose.push({ kind: 'leader_escapes', leaderId: leader.id, exits });
            else note(repairs, 'lose', 'lose_dropped', leader ? 'leader_escapes was dropped: no exit could be placed for the leader.' : 'leader_escapes was dropped: there is no leader.', k);
        }
    }
    if (roundLimit !== undefined) {
        const main = mainWin(objective);
        const clockRounds = main?.kind === 'survive' ? main.rounds : win.kind === 'protect' && !win.with ? win.rounds : undefined;
        if (clockRounds !== undefined && roundLimit < clockRounds) {
            note(repairs, 'roundLimit', 'round_limit_raised', `The round limit was raised to ${clockRounds} to match the rounds to hold out.`, roundLimit, clockRounds);
            roundLimit = clockRounds;
        }
        if (main?.kind === 'escape') {
            const len = Math.min(...main.exits.map(p => geo.party[idx(geo.grid, p)]));
            const need = Math.ceil(len / Math.max(1, speedOf(geo.pc))) + OBJECTIVE_LIMITS.escapeMargin;
            if (roundLimit < need) {
                note(repairs, 'roundLimit', 'round_limit_raised', `The round limit was raised to ${need} so the exit can be reached in time.`, roundLimit, need);
                roundLimit = need;
            }
        }
        objective.roundLimit = roundLimit;
    }
    if (lose.length > 0) objective.lose = lose;
    if (request.side) {
        const side = buildSide(request, setup, geo, objective, repairs);
        if (side) objective.side = side;
    }
    return { objective, repairs };
}

function buildSide(request: ObjectiveRequest, setup: ObjectiveSetup, geo: Geo, objective: CombatObjective, repairs: Repairs): SideObjective | null {
    const k = request.side as string;
    if (!(SIDE_KINDS as readonly string[]).includes(k)) {
        note(repairs, 'side', 'side_dropped', `Unknown side objective "${k}" was dropped.`, k);
        return null;
    }
    const kind = k as SideKind;
    if (kind === 'within_rounds') return { kind, rounds: clampTo(repairs, 'sideRounds', request.sideRounds, OBJECTIVE_LIMITS.withinRounds) };
    if (kind === 'no_one_falls') return { kind };
    if (kind === 'save_bystander') {
        const by = resolveSided(setup, request.bystander, 'bystander', c => c.side === 'neutral', 'bystander (a neutral)', repairs);
        if (by) return { kind, bystanderId: by.id };
        note(repairs, 'side', 'side_dropped', 'save_bystander was dropped: there is no neutral bystander.');
        return null;
    }
    const avoid = [...exitsOf(objective), ...(seizeTileOf(objective) ? [seizeTileOf(objective) as Pos] : [])];
    const tile = chooseReach(geo, request.reach, avoid, repairs);
    if (tile) return { kind, tile };
    note(repairs, 'side', 'side_dropped', 'reach_tile was dropped: no tile could be marked.');
    return null;
}

function threatOf(specs: readonly Pick<CombatantSpec, 'tier' | 'side'>[]): number {
    return specs.filter(s => s.side === 'enemy').reduce((sum, s) => sum + (REINFORCEMENT_THREAT[s.tier] ?? 2), 0);
}

function costOf(spec: Pick<CombatantSpec, 'tier'>): number {
    return REINFORCEMENT_THREAT[spec.tier] ?? 2;
}

export function reinforcementBudget(level: ReinforcementLevel, objective: CombatObjective, enemies: readonly Pick<CombatantSpec, 'tier' | 'side'>[]): number {
    const scale = REINFORCEMENT_KIND_SCALE[objective.win.kind] ?? 0;
    if (level === 'none' || scale <= 0) return 0;
    return Math.max(REINFORCEMENT_MIN_BUDGET, Math.round(threatOf(enemies) * REINFORCEMENT_BUDGET[level] * scale));
}

function markedArea(geo: Geo | null, objective: CombatObjective): Pos[] {
    const centre = seizeTileOf(objective) ?? reachTileOf(objective);
    const sources = centre ? [centre] : exitsOf(objective);
    if (sources.length === 0) return [];
    const out: Pos[] = [];
    const r = OBJECTIVE_LIMITS.triggerRadius;
    const grid = geo?.grid;
    for (const s of sources) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const p = { x: s.x + dx, y: s.y + dy };
                if (grid && !inBounds(grid, p)) continue;
                if (!out.some(q => q.x === p.x && q.y === p.y)) out.push(p);
            }
        }
    }
    return out;
}

function autoRounds(objective: CombatObjective, waves: number): number[] {
    const main = mainWin(objective);
    if (main?.kind === 'survive') {
        const n = main.rounds;
        return waves === 1 ? [Math.max(2, Math.ceil(n / 2))] : [2, Math.min(n, Math.max(3, Math.ceil(n / 2) + 1))];
    }
    return waves === 1 ? [3] : [3, 5];
}

function nameBase(name: string): string {
    return name.replace(/\s*\d+$/, '').trim() || 'Reinforcement';
}

function fillWave(budget: number, enemies: readonly CombatantSpec[], counter: { n: number }): CombatantSpec[] {
    const out: CombatantSpec[] = [];
    let left = budget;
    for (const tier of ['grunt', 'minion'] as CombatTier[]) {
        const cost = REINFORCEMENT_THREAT[tier];
        while (left >= cost && out.length < OBJECTIVE_LIMITS.maxWaveUnits) {
            const template = enemies.find(e => e.tier === tier) ?? enemies[0];
            counter.n += 1;
            out.push({
                name: `${nameBase(template?.name ?? 'Reinforcement')} ${enemies.length + counter.n}`,
                side: 'enemy',
                tier,
                ...(template?.archetype && template.tier === tier ? { archetype: template.archetype } : {}),
                ...(template?.range && template.tier === tier ? { range: template.range } : {}),
                ...(template?.species ? { species: template.species } : {}),
                ...(template?.look ? { look: template.look } : {}),
                ...(template?.speech ? { speech: template.speech } : {}),
            });
            left -= cost;
        }
    }
    return out;
}

export function planReinforcements(
    raw: ReinforcementRequest | unknown,
    objective: CombatObjective,
    enemies: readonly CombatantSpec[],
    setup: ObjectiveSetup | null,
): { plan: ReinforcementPlan | null; repairs: ObjectiveRepair[] } {
    const repairs: Repairs = [];
    const request = normalizeReinforcementRequest(raw);
    if (!request || request === 'none') return { plan: null, repairs };
    const scale = REINFORCEMENT_KIND_SCALE[objective.win.kind] ?? 0;
    if (scale <= 0) {
        note(repairs, 'reinforcements', 'reinforcements_dropped', `Reinforcements are not allowed for a ${objective.win.kind} fight, so it always ends.`);
        return { plan: null, repairs };
    }
    const geo = setup ? geometry(setup) : null;
    const foes = enemies.filter(e => e.side === 'enemy');
    const leaderId = leaderIdOf(objective);
    const area = markedArea(geo, objective);
    const waves: WavePlan[] = [];
    let budget: number;
    if (typeof request === 'string') {
        budget = reinforcementBudget(request, objective, foes);
        const count = REINFORCEMENT_WAVES[request];
        const rounds = autoRounds(objective, count);
        const counter = { n: 0 };
        let left = budget;
        for (let i = 0; i < count; i++) {
            const share = i === count - 1 ? left : Math.ceil(left / (count - i));
            const combatants = fillWave(share, foes, counter);
            left -= combatants.reduce((s, c) => s + costOf(c), 0);
            if (combatants.length === 0) continue;
            let trigger: ReinforcementTrigger = { kind: 'round', round: rounds[i] };
            const main = mainWin(objective);
            if (i === 0 && main?.kind === 'seize' && area.length > 0) trigger = { kind: 'tile', tiles: area };
            if (i === 0 && main?.kind === 'defeat_leader' && leaderId) trigger = { kind: 'leader_half', leaderId };
            waves.push({ id: `w${waves.length + 1}`, trigger, edge: 'far', combatants });
        }
    } else {
        budget = reinforcementBudget('many', objective, foes);
        let left = budget;
        for (const w of request.waves) {
            const kept: CombatantSpec[] = [];
            for (const c of w.combatants ?? []) {
                const spec: CombatantSpec = { ...c, side: 'enemy' };
                if (costOf(spec) > left || kept.length >= OBJECTIVE_LIMITS.maxWaveUnits) {
                    note(repairs, 'reinforcements', 'reinforcements_trimmed', `${spec.name} was left out of the reinforcements: over the budget of ${budget}.`, spec.name);
                    continue;
                }
                left -= costOf(spec);
                kept.push(spec);
            }
            if (kept.length === 0) continue;
            let trigger: ReinforcementTrigger;
            if (w.trigger === 'leader_half') {
                if (leaderId) trigger = { kind: 'leader_half', leaderId };
                else {
                    trigger = { kind: 'round', round: 3 };
                    note(repairs, 'reinforcements', 'trigger_changed', 'A leader trigger needs a leader; the wave comes in round 3 instead.');
                }
            } else if (w.trigger === 'tile') {
                if (area.length > 0) trigger = { kind: 'tile', tiles: area };
                else {
                    trigger = { kind: 'round', round: 3 };
                    note(repairs, 'reinforcements', 'trigger_changed', 'A tile trigger needs a marked tile; the wave comes in round 3 instead.');
                }
            } else {
                const round = Math.max(2, Math.round(w.round ?? 3));
                if (w.round !== undefined && round !== w.round) note(repairs, 'reinforcements', 'clamped', `A wave cannot arrive before round 2; set to ${round}.`, w.round, round);
                trigger = { kind: 'round', round };
            }
            const edge: ReinforcementEdge = w.edge === 'near' || w.edge === 'flank' ? w.edge : 'far';
            waves.push({ id: `w${waves.length + 1}`, trigger, edge, combatants: kept });
        }
    }
    return { plan: waves.length > 0 ? { budget, waves } : null, repairs };
}
