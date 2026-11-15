import { describe, it, expect } from 'vitest';
import {
    abilityTargets, applyAction, BUILTIN_SHOVE_ID, builtinShove, checkAbility, createRng, currentActorId, legalAims, previewAbilityPushes,
    previewPush, previewPushes, SHOVE_NO_ROOM,
} from '../index';
import type { CombatEvent, CombatState, Combatant, Pos, Tile } from '../index';
import { arena, caster, cursorFor, foe, glyph, openGrid } from './glyphFixtures';

const SEED = 7;

const at = (x: number, y: number): Pos => ({ x, y });

const seeded = (state: CombatState, cursor: number): CombatState => ({ ...state, rngSeed: SEED, rngCursor: cursor });

const failSave = cursorFor(SEED, r => r[0] <= 5, 1);
const hits = cursorFor(SEED, r => r[0] >= 5 && r[1] >= 5, 2);

const act = (state: CombatState, abilityId: string, aim: Pos | null = null) =>
    applyAction(state, { type: 'use_ability', actorId: 'pc', abilityId, aim });

const kinds = (events: CombatEvent[]) => events.map(e => e.type);

const gridWith = (tiles: Array<[Pos, Tile]>, width = 16, height = 12) => openGrid(width, height, [], tiles);

const pc = (pos: Pos = at(2, 2), overrides: Partial<Combatant> = {}) => caster([], pos, overrides);

const plan = (state: CombatState, targetId: string, kind: 'push' | 'pull' = 'push', squares = 2, options = {}) =>
    previewPush(state, 'pc', targetId, kind, squares, options);

describe('previewPush: the straight path', () => {
    it('walks two squares straight away from the shover', () => {
        const s = arena([pc(), foe('f', at(3, 2))]);
        expect(plan(s, 'f')).toMatchObject({ squares: 2, asked: 2, from: at(3, 2), landing: at(5, 2), path: [at(4, 2), at(5, 2)], slid: false, direction: at(1, 0), hazards: [] });
        expect(plan(s, 'f')?.stoppedBy).toBeUndefined();
    });

    it('walks a diagonal when the shover stands diagonally', () => {
        const s = arena([pc(at(2, 2)), foe('f', at(3, 3))]);
        expect(plan(s, 'f')).toMatchObject({ squares: 2, landing: at(5, 5), direction: at(1, 1), slid: false });
    });

    it('pulls toward the origin and stops short of the puller', () => {
        const s = arena([pc(at(2, 5)), foe('f', at(8, 5))]);
        expect(plan(s, 'f', 'pull')).toMatchObject({ squares: 2, landing: at(6, 5), path: [at(7, 5), at(6, 5)] });
        const near = arena([pc(at(2, 5)), foe('f', at(4, 5))]);
        expect(plan(near, 'f', 'pull')).toMatchObject({ squares: 1, landing: at(3, 5), stoppedBy: { kind: 'creature', id: 'pc' } });
    });

    it('returns null for a missing target or a target on the origin', () => {
        const s = arena([pc(), foe('f', at(3, 2))]);
        expect(plan(s, 'nobody')).toBeNull();
        expect(plan(s, 'f', 'push', 2, { origin: at(3, 2) })).toBeNull();
    });
});

describe('previewPush: what stops a step', () => {
    it('is stopped by a wall, by cover, by the map edge and by a creature, and says which', () => {
        const wall = arena([pc(), foe('f', at(3, 2))], { grid: gridWith([[at(5, 2), 'wall']]) });
        expect(plan(wall, 'f')).toMatchObject({ squares: 1, stoppedBy: { kind: 'wall' } });
        const cover = arena([pc(), foe('f', at(3, 2))], { grid: gridWith([[at(5, 2), 'cover']]) });
        expect(plan(cover, 'f')).toMatchObject({ squares: 1, stoppedBy: { kind: 'cover' } });
        const edge = arena([pc(at(2, 2)), foe('f', at(1, 2))]);
        expect(plan(edge, 'f')).toMatchObject({ squares: 1, landing: at(0, 2), stoppedBy: { kind: 'edge' } });
        const crowd = arena([pc(), foe('f', at(3, 2)), foe('g', at(5, 2))]);
        expect(plan(crowd, 'f')).toMatchObject({ squares: 1, stoppedBy: { kind: 'creature', id: 'g' } });
    });

    it('ignores a fallen creature on the path', () => {
        const s = arena([pc(), foe('f', at(3, 2)), foe('g', at(4, 2), { status: 'down', hp: 0 })]);
        expect(plan(s, 'f')?.squares).toBe(2);
    });

    it('marks hazards: every tile entered for a shove, only the landing tile otherwise', () => {
        const grid = gridWith([[at(4, 2), 'hazard'], [at(5, 2), 'hazard']]);
        const s = arena([pc(), foe('f', at(3, 2))], { grid });
        expect(plan(s, 'f', 'push', 2, { strike: true })?.hazards).toEqual([at(4, 2), at(5, 2)]);
        expect(plan(s, 'f', 'push', 2)?.hazards).toEqual([at(5, 2)]);
        const clear = arena([pc(), foe('f', at(3, 2))], { grid: gridWith([[at(4, 2), 'hazard']]) });
        expect(plan(clear, 'f', 'push', 2)?.hazards).toEqual([]);
        expect(plan(clear, 'f', 'push', 2, { strike: true })?.hazards).toEqual([at(4, 2)]);
    });
});

describe('previewPush: the slide rule', () => {
    it('slides to the clockwise neighbour first when the straight step is blocked and the angles tie', () => {
        const s = arena([pc(), foe('f', at(3, 2)), foe('g', at(4, 2))]);
        expect(plan(s, 'f')).toMatchObject({ squares: 2, slid: true, direction: at(1, 1), path: [at(4, 3), at(5, 4)], landing: at(5, 4) });
    });

    it('slides to the other side when the clockwise neighbour is blocked too', () => {
        const s = arena([pc(), foe('f', at(3, 2)), foe('g', at(4, 2)), foe('h', at(4, 3))]);
        expect(plan(s, 'f')).toMatchObject({ squares: 2, slid: true, direction: at(1, -1), landing: at(5, 0) });
    });

    it('prefers the neighbour nearer the true line when the origin is not adjacent', () => {
        const s = arena([pc(at(0, 0)), foe('f', at(4, 1)), foe('g', at(5, 2))]);
        const result = previewPush(s, 'pc', 'f', 'push', 2, { origin: at(0, 0) });
        expect(result).toMatchObject({ slid: true, direction: at(1, 0), landing: at(6, 1) });
    });

    it('lets one tree beside a diagonal shove no longer cancel it', () => {
        const open = arena([pc(at(2, 2)), foe('f', at(3, 3))]);
        expect(plan(open, 'f')?.squares).toBe(2);
        const tree = arena([pc(at(2, 2)), foe('f', at(3, 3))], { grid: gridWith([[at(4, 3), 'wall']]) });
        const result = plan(tree, 'f');
        expect(result).toMatchObject({ slid: true, direction: at(0, 1), squares: 2, landing: at(3, 5) });
    });

    it('reports the corner as the cause when the diagonal destination is open but a neighbour is a wall', () => {
        const grid = gridWith([[at(4, 3), 'wall'], [at(3, 4), 'wall']]);
        const s = arena([pc(at(2, 2)), foe('f', at(3, 3))], { grid });
        expect(plan(s, 'f')).toMatchObject({ squares: 0, slid: false, stoppedBy: { kind: 'corner' } });
        const cover = arena([pc(at(2, 2)), foe('f', at(3, 3))], { grid: gridWith([[at(4, 3), 'cover'], [at(3, 4), 'cover']]) });
        expect(plan(cover, 'f')).toMatchObject({ squares: 0, stoppedBy: { kind: 'corner' } });
    });

    it('stays put and names the straight blocker when nothing allows a step', () => {
        const s = arena([pc(), foe('f', at(3, 2)), foe('g', at(4, 2)), foe('h', at(4, 1)), foe('i', at(4, 3))]);
        expect(plan(s, 'f')).toMatchObject({ squares: 0, slid: false, landing: at(3, 2), stoppedBy: { kind: 'creature', id: 'g' } });
    });

    it('keeps the chosen direction for every square after a slide', () => {
        const s = arena([pc(), foe('f', at(3, 2)), foe('g', at(4, 2))], { grid: gridWith([[at(5, 4), 'wall']]) });
        expect(plan(s, 'f')).toMatchObject({ squares: 1, landing: at(4, 3), stoppedBy: { kind: 'wall' } });
    });

    it('applies to pull as well', () => {
        const s = arena([pc(at(2, 5)), foe('f', at(8, 5)), foe('g', at(7, 5))]);
        expect(plan(s, 'f', 'pull')).toMatchObject({ slid: true, squares: 2 });
    });

    it('is deterministic and does not touch the RNG', () => {
        const s = arena([pc(), foe('f', at(3, 2)), foe('g', at(4, 2))]);
        const a = plan(s, 'f');
        const b = plan(s, 'f');
        expect(a).toEqual(b);
        expect(s.rngCursor).toBe(0);
    });
});

describe('Shove refuses when nothing can move the target', () => {
    const pinned = () => arena([pc(), foe('f', at(3, 2)), foe('g', at(4, 2)), foe('h', at(4, 1)), foe('i', at(4, 3))]);

    it('refuses at aim time with a reason, wastes no bonus action and rolls nothing', () => {
        const s = seeded(pinned(), failSave);
        expect(abilityTargets(s, 'pc', builtinShove(), at(3, 2))).toMatchObject({ ok: false, reason: SHOVE_NO_ROOM });
        expect(checkAbility(s, 'pc', BUILTIN_SHOVE_ID, at(3, 2))).toMatchObject({ ok: false, reason: 'no room to shove them' });
        const r = act(s, BUILTIN_SHOVE_ID, at(3, 2));
        expect(kinds(r.events)).toEqual(['rejected']);
        expect(r.state.turn?.bonusUsed).toBeFalsy();
        expect(r.state.rngCursor).toBe(s.rngCursor);
    });

    it('drops the pinned target from the legal aims and explains the Shove button', () => {
        const s = pinned();
        expect(legalAims(s, 'pc', builtinShove())).toEqual([]);
        expect(checkAbility(s, 'pc', BUILTIN_SHOVE_ID)).toMatchObject({ ok: false, reason: 'no room to shove them' });
        const open = arena([pc(), foe('f', at(3, 2))]);
        expect(legalAims(open, 'pc', builtinShove())).toEqual([at(3, 2)]);
        const far = arena([pc(), foe('f', at(9, 9))]);
        expect(checkAbility(far, 'pc', BUILTIN_SHOVE_ID).reason).toBe('no target');
        const boss = arena([pc(), foe('f', at(3, 2), { tier: 'boss' })]);
        expect(checkAbility(boss, 'pc', BUILTIN_SHOVE_ID).reason).toBe('no target');
    });

    it('allows the shove again once one neighbour opens up', () => {
        const s = arena([pc(), foe('f', at(3, 2)), foe('g', at(4, 2)), foe('h', at(4, 1))]);
        expect(checkAbility(s, 'pc', BUILTIN_SHOVE_ID, at(3, 2)).ok).toBe(true);
        const r = act(seeded(s, failSave), BUILTIN_SHOVE_ID, at(3, 2));
        expect(kinds(r.events)).toEqual(['ability', 'save', 'pushed']);
        expect(r.events[2].data).toMatchObject({ squares: 2, slid: true });
        expect(r.state.combatants.f.position).toEqual(at(5, 4));
    });

    it('ends a player-driven turn that has only a pinned shove left, and holds it open for a free one', () => {
        const drive = (state: CombatState) => {
            const ready = { ...state, turn: { ...(state.turn as NonNullable<CombatState['turn']>), moveLeft: 0 } };
            return applyAction(ready, { type: 'attack', actorId: 'pc', targetId: 'f' }, { driven: true });
        };
        const stuck = drive(pinned());
        expect(currentActorId(stuck.state)).not.toBe('pc');
        const free = drive(arena([pc(), foe('f', at(3, 2))]));
        expect(currentActorId(free.state)).toBe('pc');
    });
});

describe('a kit push that cannot move its target', () => {
    it('still resolves and logs a zero-square event that says why', () => {
        const kit = glyph('touch', ['push'], [], { id: 'p' });
        const s = seeded(arena([caster([kit], at(2, 2)), foe('f', at(3, 2), { ac: 0 }), foe('g', at(4, 2)), foe('h', at(4, 1)), foe('i', at(4, 3))]), hits);
        const r = act(s, 'p', at(3, 2));
        const pushed = r.events.filter(e => e.type === 'pushed');
        expect(pushed).toHaveLength(1);
        expect(pushed[0].data).toMatchObject({ kind: 'push', squares: 0, moves: [], stopped: { kind: 'creature', id: 'g' } });
        expect(pushed[0].text).toBe('f is pushed but has nowhere to go, stopped by g.');
        expect(r.state.combatants.f.position).toEqual(at(3, 2));
    });

    it('says why a push moved fewer squares than asked', () => {
        const kit = glyph('touch', ['push'], [], { id: 'p' });
        const s = seeded(arena([caster([kit], at(2, 2)), foe('f', at(3, 2), { ac: 0 }), foe('g', at(5, 2))]), hits);
        const pushed = act(s, 'p', at(3, 2)).events.find(e => e.type === 'pushed') as CombatEvent;
        expect(pushed.data).toMatchObject({ squares: 1, stopped: { kind: 'creature', id: 'g' } });
        expect(pushed.text).toBe('f is pushed back 1 square, stopped by g.');
        const walled = seeded(arena([caster([kit], at(2, 2)), foe('f', at(3, 2), { ac: 0 })], { grid: gridWith([[at(5, 2), 'wall']]) }), hits);
        expect((act(walled, 'p', at(3, 2)).events.find(e => e.type === 'pushed') as CombatEvent).text).toBe('f is pushed back 1 square, stopped by the wall.');
        const full = seeded(arena([caster([kit], at(2, 2)), foe('f', at(3, 2), { ac: 0 })]), hits);
        expect((act(full, 'p', at(3, 2)).events.find(e => e.type === 'pushed') as CombatEvent).text).toBe('f is pushed back 2 squares.');
    });
});

describe('area pushes', () => {
    it('previews every target in a burst, each against the positions the earlier ones leave behind', () => {
        const kit = glyph('burst', ['push'], [], { id: 'b' });
        const user = caster([kit], at(2, 5));
        const s = arena([user, foe('a', at(6, 5)), foe('b', at(7, 5)), foe('c', at(6, 6))]);
        const aim = abilityTargets(s, 'pc', kit, at(6, 5));
        expect(aim.ok).toBe(true);
        const plans = previewAbilityPushes(s, 'pc', kit, aim);
        expect(plans.map(p => p.targetId).sort()).toEqual(['b', 'c']);
        for (const p of plans) expect(p.squares).toBeGreaterThanOrEqual(0);
        const direct = previewPushes(s, 'pc', aim.targetIds, 'push', 2, { origin: aim.origin });
        expect(plans).toEqual(direct);
    });

    it('returns nothing for abilities without a push or pull, or for a self form', () => {
        const dmg = glyph('touch', ['damage'], [], { id: 'd' });
        const s = arena([caster([dmg], at(2, 2)), foe('f', at(3, 2))]);
        const aim = abilityTargets(s, 'pc', dmg, at(3, 2));
        expect(previewAbilityPushes(s, 'pc', dmg, aim)).toEqual([]);
    });
});

describe('previewPush equals the resolved result for 200 seeded random positions', () => {
    const DIRS: Pos[] = [at(1, 0), at(1, 1), at(0, 1), at(-1, 1), at(-1, 0), at(-1, -1), at(0, -1), at(1, -1)];
    const KINDS: Tile[] = ['wall', 'cover', 'hazard', 'difficult', 'floor', 'floor', 'floor', 'floor', 'floor', 'floor'];

    function scenario(seed: number, range: number) {
        const rng = createRng(seed, 0);
        const size = 10;
        const tiles = new Array<Tile>(size * size).fill('floor');
        for (let i = 0; i < tiles.length; i++) tiles[i] = KINDS[rng.int(0, KINDS.length - 1)];
        const user = at(rng.int(2, 7), rng.int(2, 7));
        const dir = DIRS[rng.int(0, 7)];
        const target = at(user.x + dir.x * range, user.y + dir.y * range);
        const taken = new Set([`${user.x},${user.y}`, `${target.x},${target.y}`]);
        const crowd: Combatant[] = [];
        for (let i = 0; i < 4; i++) {
            const p = at(rng.int(0, size - 1), rng.int(0, size - 1));
            const key = `${p.x},${p.y}`;
            if (taken.has(key)) continue;
            taken.add(key);
            crowd.push(foe(`x${i}`, p));
        }
        for (const p of [user, target]) tiles[p.y * size + p.x] = 'floor';
        for (const c of crowd) tiles[(c.position as Pos).y * size + (c.position as Pos).x] = 'floor';
        return { grid: { width: size, height: size, tiles }, user, target, crowd };
    }

    it('matches the shove resolver square for square, hazard for hazard', () => {
        let moved = 0;
        let refused = 0;
        let slid = 0;
        for (let i = 0; i < 200; i++) {
            const { grid, user, target, crowd } = scenario(1000 + i, 1);
            const s = seeded(arena([caster([], user), foe('t', target), ...crowd], { grid }), failSave);
            const expected = previewPush(s, 'pc', 't', 'push', 2, { origin: user, strike: true });
            const r = act(s, BUILTIN_SHOVE_ID, target);
            if (!expected || expected.squares === 0) {
                expect(kinds(r.events)).toEqual(['rejected']);
                refused++;
                continue;
            }
            const pushed = r.events.find(e => e.type === 'pushed') as CombatEvent;
            expect(pushed.data.squares).toBe(expected.squares);
            expect(pushed.data.moves).toEqual([{ id: 't', from: expected.from, to: expected.landing }]);
            expect(Boolean(pushed.data.slid)).toBe(expected.slid);
            expect(pushed.data.stopped).toEqual(expected.stoppedBy);
            expect(r.events.filter(e => e.type === 'hazard')).toHaveLength(expected.hazards.length);
            expect(r.state.combatants.t.position).toEqual(expected.landing);
            moved++;
            if (expected.slid) slid++;
        }
        expect(moved).toBeGreaterThan(50);
        expect(refused).toBeGreaterThan(0);
        expect(slid).toBeGreaterThan(0);
    });

    it('matches a kit pull from range', () => {
        const kit = glyph('projectile', ['pull'], [], { id: 'q' });
        let checked = 0;
        for (let i = 0; i < 200; i++) {
            const { grid, user, target, crowd } = scenario(5000 + i, 3);
            if (target.x < 0 || target.y < 0 || target.x > 9 || target.y > 9) continue;
            const s = seeded(arena([caster([kit], user), foe('t', target, { ac: 0 }), ...crowd], { grid }), hits);
            const aim = abilityTargets(s, 'pc', kit, target);
            if (!aim.ok || aim.targetIds.length !== 1) continue;
            const expected = previewPush(s, 'pc', 't', 'pull', 2, { origin: aim.origin });
            const r = act(s, 'q', target);
            const pushed = r.events.find(e => e.type === 'pushed');
            if (!expected) continue;
            expect(pushed?.data.squares).toBe(expected.squares);
            expect(r.state.combatants.t.position).toEqual(expected.landing);
            checked++;
        }
        expect(checked).toBeGreaterThan(30);
    });
});
