import { describe, it, expect } from 'vitest';
import { abilityTargets, applyAction, directionOf, legalAims, pathTo, terrainOf, checkAttack } from '../index';
import type { Pos } from '../index';
import { arena, caster, foe, glyph, openGrid } from './glyphFixtures';

const key = (p: Pos) => `${p.x},${p.y}`;
const keys = (ps: Pos[]) => ps.map(key).sort();

describe('single-target forms', () => {
    it('touch reaches distance 1 only', () => {
        const a = glyph('touch', ['damage']);
        const s = arena([caster([a], { x: 5, y: 5 }), foe('near', { x: 6, y: 6 }), foe('far', { x: 8, y: 5 })]);
        expect(abilityTargets(s, 'pc', a, { x: 6, y: 6 }).targetIds).toEqual(['near']);
        expect(abilityTargets(s, 'pc', a, { x: 8, y: 5 }).ok).toBe(false);
        expect(keys(legalAims(s, 'pc', a))).toEqual(['6,6']);
    });

    it('projectile reaches 12 squares, 18 when extended, and needs line of sight', () => {
        const a = glyph('projectile', ['damage']);
        const ext = glyph('projectile', ['damage'], ['extend']);
        const s = arena([caster([a], { x: 0, y: 0 }), foe('f13', { x: 13, y: 0 }), foe('f12', { x: 12, y: 1 })], { grid: openGrid(20, 12) });
        expect(abilityTargets(s, 'pc', a, { x: 12, y: 1 }).ok).toBe(true);
        expect(abilityTargets(s, 'pc', a, { x: 13, y: 0 }).reason).toBe('out of range');
        expect(abilityTargets(s, 'pc', ext, { x: 13, y: 0 }).ok).toBe(true);
        const walled = { ...s, grid: openGrid(20, 12, [{ x: 6, y: 0 }]) };
        expect(abilityTargets(walled, 'pc', a, { x: 13, y: 0 }).ok).toBe(false);
        expect(abilityTargets(walled, 'pc', ext, { x: 13, y: 0 }).reason).toBe('no line of sight');
    });

    it('pierce hits every combatant on the path and split adds a target within 3 squares', () => {
        const pierce = glyph('projectile', ['damage'], ['pierce']);
        const split = glyph('projectile', ['damage'], ['split']);
        const s = arena([caster([pierce], { x: 0, y: 5 }), foe('a', { x: 3, y: 5 }), foe('b', { x: 6, y: 5 }), foe('c', { x: 8, y: 7 }), foe('d', { x: 15, y: 0 })]);
        expect(abilityTargets(s, 'pc', pierce, { x: 6, y: 5 }).targetIds).toEqual(['a', 'b']);
        expect(abilityTargets(s, 'pc', split, { x: 6, y: 5 }).targetIds).toEqual(['b', 'c']);
        expect(abilityTargets(s, 'pc', glyph('projectile', ['damage']), { x: 6, y: 5 }).targetIds).toEqual(['b']);
    });

    it('dash moves in a straight line to an empty square next to the target, blocked by hostiles', () => {
        const a = glyph('dash', ['damage']);
        const s = arena([caster([a], { x: 2, y: 5 }), foe('t', { x: 6, y: 5 })]);
        const res = abilityTargets(s, 'pc', a, { x: 6, y: 5 });
        expect(res.ok).toBe(true);
        expect(res.destination).toEqual({ x: 5, y: 5 });
        const far = arena([caster([a], { x: 0, y: 5 }), foe('t', { x: 7, y: 5 })]);
        expect(abilityTargets(far, 'pc', a, { x: 7, y: 5 }).ok).toBe(false);
        expect(abilityTargets(far, 'pc', glyph('dash', ['damage'], ['extend']), { x: 7, y: 5 }).destination).toEqual({ x: 6, y: 5 });
        const blocked = arena([caster([a], { x: 2, y: 5 }), foe('t', { x: 6, y: 5 }), foe('wall', { x: 4, y: 5 }), foe('w2', { x: 4, y: 4 }), foe('w3', { x: 4, y: 6 })]);
        expect(abilityTargets(blocked, 'pc', a, { x: 6, y: 5 }).ok).toBe(false);
    });
});

describe('self and blink', () => {
    it('self targets the user; blink aims at an empty seen square within 6, 9 when extended (R2)', () => {
        const haste = glyph('self', ['haste']);
        const blink = glyph('self', ['blink']);
        const s = arena([caster([haste], { x: 2, y: 2 }), foe('f', { x: 4, y: 2 })]);
        expect(abilityTargets(s, 'pc', haste, null)).toMatchObject({ ok: true, targetIds: ['pc'] });
        expect(legalAims(s, 'pc', haste)).toEqual([{ x: 2, y: 2 }]);
        expect(abilityTargets(s, 'pc', blink, { x: 8, y: 2 }).destination).toEqual({ x: 8, y: 2 });
        expect(abilityTargets(s, 'pc', blink, { x: 9, y: 2 }).ok).toBe(false);
        expect(abilityTargets(s, 'pc', glyph('self', [['blink', ['extend']]]), { x: 11, y: 2 }).ok).toBe(true);
        expect(abilityTargets(s, 'pc', blink, { x: 4, y: 2 }).reason).toBe('the square is not empty');
    });
});

describe('area forms', () => {
    it('takes the direction from the aim octant', () => {
        expect(directionOf({ x: 5, y: 5 }, { x: 9, y: 6 })).toEqual({ x: 1, y: 0 });
        expect(directionOf({ x: 5, y: 5 }, { x: 8, y: 8 })).toEqual({ x: 1, y: 1 });
        expect(directionOf({ x: 5, y: 5 }, { x: 5, y: 1 })).toEqual({ x: 0, y: -1 });
        expect(directionOf({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeNull();
    });

    it('a line runs 6 squares and stops at a wall; widen makes it 3 wide; extend 9 long', () => {
        const a = glyph('line', ['damage']);
        const s = arena([caster([a], { x: 1, y: 5 }), foe('in', { x: 4, y: 5 }), foe('side', { x: 4, y: 6 }), foe('beyond', { x: 8, y: 5 })]);
        const res = abilityTargets(s, 'pc', a, { x: 9, y: 5 });
        expect(res.tiles).toHaveLength(6);
        expect(res.targetIds).toEqual(['in']);
        expect(abilityTargets(s, 'pc', glyph('line', ['damage'], ['widen']), { x: 9, y: 5 }).targetIds).toEqual(['in', 'side']);
        expect(abilityTargets(s, 'pc', glyph('line', ['damage'], ['extend']), { x: 9, y: 5 }).targetIds).toContain('beyond');
        const walled = { ...s, grid: openGrid(16, 12, [{ x: 3, y: 5 }]) };
        expect(abilityTargets(walled, 'pc', a, { x: 9, y: 5 }).tiles).toEqual([{ x: 2, y: 5 }]);
    });

    it('a barrier line takes the first 4 empty squares (R7)', () => {
        const a = glyph('line', ['barrier']);
        const s = arena([caster([a], { x: 1, y: 5 }), foe('f', { x: 3, y: 5 })]);
        expect(abilityTargets(s, 'pc', a, { x: 9, y: 5 }).barrierTiles).toEqual([{ x: 2, y: 5 }, { x: 4, y: 5 }, { x: 5, y: 5 }, { x: 6, y: 5 }]);
    });

    it('a cone covers squares within 45 degrees up to 3 away; widen adds 1', () => {
        const a = glyph('cone', ['damage']);
        const s = arena([caster([a], { x: 5, y: 5 }), foe('front', { x: 7, y: 5 }), foe('edge', { x: 7, y: 7 }), foe('behind', { x: 4, y: 5 }), foe('far', { x: 9, y: 5 })]);
        const res = abilityTargets(s, 'pc', a, { x: 8, y: 5 });
        expect(res.targetIds.sort()).toEqual(['edge', 'front']);
        expect(res.tiles.every(t => t.x > 5)).toBe(true);
        expect(abilityTargets(s, 'pc', glyph('cone', ['damage'], ['widen']), { x: 8, y: 5 }).targetIds).toContain('far');
    });

    it('a burst is 3×3 within 8 with sight to the centre, 5×5 widened, and catches the user inside', () => {
        const a = glyph('burst', ['damage']);
        const s = arena([caster([a], { x: 2, y: 2 }), foe('a', { x: 6, y: 6 }), foe('b', { x: 7, y: 7 }), foe('c', { x: 8, y: 8 })]);
        const res = abilityTargets(s, 'pc', a, { x: 6, y: 6 });
        expect(res.tiles).toHaveLength(9);
        expect(res.targetIds.sort()).toEqual(['a', 'b']);
        expect(abilityTargets(s, 'pc', glyph('burst', ['damage'], ['widen']), { x: 6, y: 6 }).targetIds.sort()).toEqual(['a', 'b', 'c']);
        expect(abilityTargets(s, 'pc', a, { x: 11, y: 2 }).reason).toBe('out of range');
        expect(abilityTargets(s, 'pc', a, { x: 3, y: 3 }).targetIds).toContain('pc');
    });

    it('a burst centre must be open with sight, and walls shelter squares from the centre (R16)', () => {
        const a = glyph('burst', ['damage']);
        const walls = [{ x: 7, y: 5 }, { x: 7, y: 6 }, { x: 7, y: 4 }];
        const s = arena([caster([a], { x: 2, y: 5 }), foe('safe', { x: 8, y: 5 })], { grid: openGrid(16, 12, walls) });
        expect(abilityTargets(s, 'pc', a, { x: 7, y: 5 }).ok).toBe(false);
        const res = abilityTargets(s, 'pc', a, { x: 6, y: 5 });
        expect(res.ok).toBe(true);
        expect(res.targetIds).toEqual([]);
        expect(legalAims(s, 'pc', a).some(p => p.x === 7 && p.y === 5)).toBe(false);
    });
});

describe('barriers as an overlay (C8)', () => {
    it('block sight, attacks and movement without touching the generated grid', () => {
        const a = glyph('projectile', ['damage']);
        const pc = caster([a], { x: 1, y: 5 }, { range: 'ranged' });
        const s = arena([pc, foe('f', { x: 6, y: 5 })], {
            barriers: [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter(y => y >= 0 && y < 12).map(y => ({ pos: { x: 3, y }, expiresRound: 4, sourceId: 'pc' })),
        });
        expect(terrainOf(s)!.tiles.filter(t => t === 'wall')).toHaveLength(12);
        expect(s.grid!.tiles.every(t => t === 'floor')).toBe(true);
        expect(abilityTargets(s, 'pc', a, { x: 6, y: 5 }).reason).toBe('no line of sight');
        expect(checkAttack(s, 'pc', 'f').ok).toBe(false);
        expect(pathTo(s, 'pc', { x: 4, y: 5 })).toBeNull();
        expect(applyAction(s, { type: 'move', actorId: 'pc', to: { x: 4, y: 5 } }).events[0].type).toBe('rejected');
    });
});
