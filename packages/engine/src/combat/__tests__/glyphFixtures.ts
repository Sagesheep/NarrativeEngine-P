import { buildPcCombatant, createRng, freshTurn } from '../index';
import type { AugmentId, CombatSheet, CombatState, Combatant, EffectId, FormId, GlyphAbility, Grid, Pos, Tile } from '../index';

export const casterSheet: CombatSheet = {
    abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 10 },
    budget: 'NORMAL',
    level: 3,
    needsAllocation: false,
};

export function glyph(form: FormId, effects: Array<EffectId | [EffectId, AugmentId[]]>, formAugments: AugmentId[] = [], extra: Partial<GlyphAbility> = {}): GlyphAbility {
    return {
        id: extra.id ?? `${form}-${effects.map(e => Array.isArray(e) ? e[0] : e).join('-')}`,
        name: extra.name ?? 'Test',
        form: { id: form, augments: formAugments },
        effects: effects.map(e => Array.isArray(e) ? { id: e[0], augments: e[1] } : { id: e, augments: [] }),
        source: 'player',
        ...extra,
    };
}

export function openGrid(width = 16, height = 12, walls: Pos[] = [], tiles: Array<[Pos, Tile]> = []): Grid {
    const out: Tile[] = new Array(width * height).fill('floor');
    for (const w of walls) out[w.y * width + w.x] = 'wall';
    for (const [p, t] of tiles) out[p.y * width + p.x] = t;
    return { width, height, tiles: out };
}

export function caster(kit: GlyphAbility[], pos: Pos, overrides: Partial<Combatant> = {}): Combatant {
    const pc = buildPcCombatant({ name: 'Kira', sheet: casterSheet, weapon: { quality: 'common' }, kit });
    return { ...pc, position: pos, ...overrides };
}

export function foe(id: string, pos: Pos, overrides: Partial<Combatant> = {}): Combatant {
    return {
        id, name: id, side: 'enemy', controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 30, hp: 30, ac: 10, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 5, status: 'up', conditions: [], position: pos, range: 'close', ...overrides,
    };
}

export function arena(combatants: Combatant[], extra: Partial<CombatState> = {}): CombatState {
    const map: Record<string, Combatant> = {};
    for (const c of combatants) map[c.id] = c;
    const base: CombatState = {
        id: 'arena', round: 1, order: combatants.map(c => c.id), turnIndex: 0, combatants: map,
        rngSeed: 7, rngCursor: 0, eventSeq: 0, outcome: null, grid: openGrid(), turnCount: 1, ...extra,
    };
    const actor = base.order[base.turnIndex];
    return { ...base, turn: extra.turn ?? freshTurn(base, actor) };
}

export function cursorFor(seed: number, predicate: (rolls: number[]) => boolean, count = 2, sides = 20): number {
    for (let cursor = 0; cursor < 20000; cursor++) {
        const rng = createRng(seed, cursor);
        const rolls = Array.from({ length: count }, () => rng.roll(sides));
        if (predicate(rolls)) return cursor;
    }
    throw new Error('no cursor found');
}
