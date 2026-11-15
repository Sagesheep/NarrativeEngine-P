import { canStep, inBounds, samePos, terrainOf, tileAt } from '../grid';
import type { CombatState, Pos } from '../types';

export type PushKind = 'push' | 'pull';

export type PushBlockerKind = 'wall' | 'cover' | 'edge' | 'corner' | 'creature';

export type PushBlocker = { kind: PushBlockerKind; id?: string };

export type PushPreview = {
    targetId: string;
    kind: PushKind;
    asked: number;
    squares: number;
    from: Pos;
    landing: Pos;
    path: Pos[];
    direction: Pos;
    slid: boolean;
    hazards: Pos[];
    stoppedBy?: PushBlocker;
};

export type PushOptions = {
    origin?: Pos;
    strike?: boolean;
};

export const SHOVE_NO_ROOM = 'no room to shove them';

const CLOCKWISE: readonly Pos[] = [
    { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
    { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
];

const TIE = 1e-9;

function livingBlocker(state: CombatState, p: Pos, exceptId: string): string | undefined {
    return Object.values(state.combatants).find(c => c.id !== exceptId && c.status === 'up' && samePos(c.position, p))?.id;
}

function blockerAt(state: CombatState, at: Pos, next: Pos, exceptId: string): PushBlocker | null {
    const terrain = terrainOf(state);
    if (!terrain) return { kind: 'wall' };
    if (!canStep(terrain, at, next)) {
        if (!inBounds(terrain, next)) return { kind: 'edge' };
        const tile = tileAt(terrain, next);
        if (tile === 'wall') return { kind: 'wall' };
        if (tile === 'cover') return { kind: 'cover' };
        return { kind: 'corner' };
    }
    const id = livingBlocker(state, next, exceptId);
    return id ? { kind: 'creature', id } : null;
}

function directionIndex(dir: Pos): number {
    return CLOCKWISE.findIndex(d => d.x === dir.x && d.y === dir.y);
}

function slideOrder(dir: Pos, toward: Pos): Pos[] {
    const index = directionIndex(dir);
    if (index < 0) return [];
    const clockwise = CLOCKWISE[(index + 1) % 8];
    const counter = CLOCKWISE[(index + 7) % 8];
    const length = Math.hypot(toward.x, toward.y) || 1;
    const alignment = (d: Pos) => (d.x * toward.x + d.y * toward.y) / (Math.hypot(d.x, d.y) * length);
    const a = alignment(clockwise);
    const b = alignment(counter);
    return b - a > TIE ? [counter, clockwise] : [clockwise, counter];
}

function walk(state: CombatState, target: { id: string; position: Pos }, dir: Pos, squares: number): { path: Pos[]; stoppedBy?: PushBlocker } {
    const path: Pos[] = [];
    let at = { ...target.position };
    for (let i = 0; i < squares; i++) {
        const next = { x: at.x + dir.x, y: at.y + dir.y };
        const blocker = blockerAt(state, at, next, target.id);
        if (blocker) return { path, stoppedBy: blocker };
        at = next;
        path.push(next);
    }
    return { path };
}

export function previewPush(
    state: CombatState,
    userId: string,
    targetId: string,
    kind: PushKind,
    squares: number,
    options: PushOptions = {},
): PushPreview | null {
    const user = state.combatants[userId];
    const target = state.combatants[targetId];
    const origin = options.origin ?? user?.position;
    if (!terrainOf(state) || !origin || !target?.position || samePos(origin, target.position)) return null;
    const away = { x: Math.sign(target.position.x - origin.x), y: Math.sign(target.position.y - origin.y) };
    const straight = kind === 'push' ? away : { x: -away.x, y: -away.y };
    const from = { ...target.position };
    const subject = { id: target.id, position: target.position };
    let chosen = straight;
    let result = walk(state, subject, straight, squares);
    let slid = false;
    if (result.path.length === 0) {
        const toward = { x: (target.position.x - origin.x) * (kind === 'push' ? 1 : -1), y: (target.position.y - origin.y) * (kind === 'push' ? 1 : -1) };
        for (const dir of slideOrder(straight, toward)) {
            const attempt = walk(state, subject, dir, squares);
            if (attempt.path.length > 0) {
                chosen = dir;
                result = attempt;
                slid = true;
                break;
            }
        }
    }
    const landing = result.path.length > 0 ? { ...result.path[result.path.length - 1] } : { ...from };
    const grid = state.grid;
    const hazardTiles = grid ? result.path.filter(p => tileAt(grid, p) === 'hazard') : [];
    const hazards = options.strike ? hazardTiles : hazardTiles.filter(p => samePos(p, landing));
    return {
        targetId,
        kind,
        asked: squares,
        squares: result.path.length,
        from,
        landing,
        path: result.path.map(p => ({ ...p })),
        direction: chosen,
        slid,
        hazards: hazards.map(p => ({ ...p })),
        ...(result.path.length < squares && result.stoppedBy ? { stoppedBy: result.stoppedBy } : {}),
    };
}

export function previewPushes(
    state: CombatState,
    userId: string,
    targetIds: readonly string[],
    kind: PushKind,
    squares: number,
    options: PushOptions = {},
): PushPreview[] {
    const out: PushPreview[] = [];
    let live = state;
    for (const id of targetIds) {
        const target = live.combatants[id];
        if (!target || target.status !== 'up') continue;
        const plan = previewPush(live, userId, id, kind, squares, options);
        if (!plan) continue;
        out.push(plan);
        if (plan.squares > 0) live = { ...live, combatants: { ...live.combatants, [id]: { ...target, position: { ...plan.landing } } } };
    }
    return out;
}

export function blockerLabel(blocker: PushBlocker, nameOf: (id: string) => string): string {
    switch (blocker.kind) {
        case 'wall': return 'the wall';
        case 'cover': return 'the cover';
        case 'edge': return 'the edge of the map';
        case 'corner': return 'a tight corner';
        default: return blocker.id ? nameOf(blocker.id) : 'another creature';
    }
}
