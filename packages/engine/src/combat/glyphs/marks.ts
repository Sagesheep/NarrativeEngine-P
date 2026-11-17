import { applyDamage, emit, markDown } from '../core';
import type { Draft } from '../core';
import { canStep, distance, isWalkable, samePos, terrainOf } from '../grid';
import type { CombatCondition, CombatState, Combatant, ElementId, GlyphAbility, PlacedEffect, Pos, TileMarkId } from '../types';
import { elementMultiplier } from '../elements/rules';
import { ELEMENTS } from '../elements/tables';
import { conditionReactions, MARK_FORMS, TILE_MARKS, tileReactions } from '../elements/marks';
import type { MarkHarm, ReactionRow } from '../elements/marks';
import { addPlaced, endPlaced, placedOf } from './placed';
import type { AimResult } from './targeting';

export type MarkTrigger = 'enter' | 'turn_start';

export function markRecordAt(state: Pick<CombatState, 'placed'>, p: Pos): PlacedEffect | undefined {
    return placedOf(state).find(e => e.kind === 'mark' && e.tiles.some(t => samePos(t, p)));
}

export function markIdAt(state: Pick<CombatState, 'placed'>, p: Pos): TileMarkId | undefined {
    return markRecordAt(state, p)?.mark;
}

export function marksOf(state: Pick<CombatState, 'placed'>): PlacedEffect[] {
    return placedOf(state).filter(e => e.kind === 'mark' && !!e.mark);
}

export function harmAt(state: Pick<CombatState, 'placed'>, p: Pos): MarkHarm | undefined {
    const mark = markIdAt(state, p);
    return mark ? TILE_MARKS[mark].harm : undefined;
}

export function slideAt(state: Pick<CombatState, 'placed'>, p: Pos): number {
    const mark = markIdAt(state, p);
    return mark ? TILE_MARKS[mark].slide ?? 0 : 0;
}

export function dimBonus(state: Pick<CombatState, 'placed'>, a?: Pos, b?: Pos): number {
    if (!state.placed || state.placed.length === 0) return 0;
    let best = 0;
    for (const p of [a, b]) {
        const mark = p ? markIdAt(state, p) : undefined;
        const bonus = mark ? TILE_MARKS[mark].coverBonus ?? 0 : 0;
        if (bonus > best) best = bonus;
    }
    return best;
}

export function expectedMarkHarm(state: Pick<CombatState, 'placed'>, unit: Pick<Combatant, 'weak' | 'resist' | 'immune' | 'weaknesses' | 'resistances' | 'conditions' | 'mindless' | 'species'>, p: Pos): number {
    const harm = harmAt(state, p);
    if (!harm) return 0;
    return Math.floor(harm.amount * elementMultiplier(unit, harm.element).factor);
}

export function markText(owner: string, mark: TileMarkId, tiles: number, expiresRound: number): string {
    const word = TILE_MARKS[mark].word;
    return `${owner} leaves ${word} across ${tiles} ${tiles === 1 ? 'square' : 'squares'} until round ${expiresRound}.`;
}

export function trimMark(draft: Draft, record: PlacedEffect, remove: readonly Pos[], why: 'cleared' | 'replaced'): void {
    const keep = record.tiles.filter(t => !remove.some(r => samePos(r, t)));
    if (keep.length === record.tiles.length) return;
    endPlaced(draft, record, why);
    if (keep.length === 0) return;
    const { id: _id, ...rest } = record;
    addPlaced(draft, { ...rest, tiles: keep.map(t => ({ ...t })) }, { text: `${TILE_MARKS[record.mark as TileMarkId].label} remains on ${keep.length} ${keep.length === 1 ? 'square' : 'squares'}.`, data: { continued: true } });
}

export function markedTiles(state: CombatState, user: Combatant, ability: GlyphAbility, aim: Pick<AimResult, 'tiles'>, fire?: PlacedEffect): Pos[] {
    const form = ability.form.id;
    const area = fire
        ? fire.kind === 'sigil' || (fire.kind === 'delay' && MARK_FORMS.includes(form))
        : MARK_FORMS.includes(form);
    if (!area) return [];
    const terrain = terrainOf(state);
    if (!terrain) return [];
    const out: Pos[] = [];
    for (const t of fire ? fire.tiles : aim.tiles) {
        if (!isWalkable(terrain, t) || samePos(user.position, t) || out.some(o => samePos(o, t))) continue;
        out.push({ x: t.x, y: t.y });
    }
    return out;
}

export type MarkCast = { draft: Draft; user: Combatant; element: ElementId; abilityName: string; tiles: readonly Pos[] };

export function reactTiles(cast: MarkCast): void {
    const s = cast.draft.state;
    for (const row of tileReactions(cast.element)) {
        if (!('mark' in row.on)) continue;
        const wanted = row.on.mark;
        const hit = cast.tiles.filter(t => markIdAt(s, t) === wanted);
        if (hit.length === 0) continue;
        const effect = row.effect;
        const becomes = effect.kind === 'become' ? effect.mark : undefined;
        emit(cast.draft, {
            type: 'reaction',
            actorId: cast.user.id,
            data: {
                reaction: row.id, element: cast.element, ability: cast.abilityName, kind: effect.kind, mark: wanted, tiles: hit.map(t => ({ ...t })),
                ...(becomes ? { becomes } : {}),
            },
            text: row.word,
        });
        const records = new Map<string, PlacedEffect>();
        for (const t of hit) {
            const record = markRecordAt(s, t);
            if (record) records.set(record.id, record);
        }
        for (const record of records.values()) {
            const live = placedOf(s).find(p => p.id === record.id);
            if (live) trimMark(cast.draft, live, hit, 'cleared');
        }
        if (becomes) layMark(cast, becomes, hit);
    }
}

function layMark(cast: MarkCast, mark: TileMarkId, tiles: readonly Pos[]): void {
    const s = cast.draft.state;
    const wanted = tiles.filter(t => !!markIdAt(s, t));
    if (wanted.length > 0) {
        const seen = new Set<string>();
        for (const t of wanted) {
            const record = markRecordAt(s, t);
            if (!record || seen.has(record.id)) continue;
            seen.add(record.id);
            trimMark(cast.draft, record, wanted, 'replaced');
        }
    }
    addPlaced(cast.draft, {
        kind: 'mark',
        mark,
        ownerId: cast.user.id,
        side: cast.user.side,
        name: cast.abilityName,
        trigger: 'enter',
        tiles: tiles.map(t => ({ ...t })),
        element: cast.element,
        placedRound: s.round,
        expiresRound: s.round + TILE_MARKS[mark].rounds,
    }, { text: markText(cast.user.name, mark, tiles.length, s.round + TILE_MARKS[mark].rounds) });
}

export function leaveMarks(cast: MarkCast): void {
    const mark = ELEMENTS[cast.element].mark;
    if (!mark || cast.tiles.length === 0) return;
    layMark(cast, mark, cast.tiles);
}

export function strikeAt(draft: Draft, unit: Combatant, p: Pos, why: MarkTrigger): void {
    const s = draft.state;
    if (unit.status !== 'up' || !s.placed || s.placed.length === 0) return;
    const record = markRecordAt(s, p);
    const harm = record?.mark ? TILE_MARKS[record.mark].harm : undefined;
    if (!record || !record.mark || !harm) return;
    const mult = elementMultiplier(unit, harm.element);
    const amount = Math.floor(harm.amount * mult.factor);
    const base = {
        mark: record.mark, placed: record.id, why, element: harm.element, damageType: harm.element, sourceId: record.ownerId,
        weakness: mult.factor > 1, resisted: mult.factor < 1,
    };
    if (amount <= 0) {
        emit(draft, {
            type: 'mark_harm',
            targetId: unit.id,
            data: { ...base, damage: 0, immune: mult.immune, absorbed: 0, hpBefore: unit.hp, tempBefore: unit.tempHp ?? 0, hpAfter: unit.hp },
            text: `${unit.name} is unharmed by the ${TILE_MARKS[record.mark].word}.`,
        });
        return;
    }
    const result = applyDamage(unit, amount);
    emit(draft, {
        type: 'mark_harm',
        targetId: unit.id,
        data: { ...base, damage: amount, absorbed: result.absorbed, hpBefore: result.hpBefore, tempBefore: result.tempBefore, hpAfter: unit.hp },
        text: `${unit.name} takes ${amount} ${harm.element} damage from the ${TILE_MARKS[record.mark].word}.`,
    });
    if (unit.hp <= 0) markDown(draft, unit, {});
}

export function strikeStanding(draft: Draft, unit: Combatant, why: MarkTrigger): void {
    if (unit.position) strikeAt(draft, unit, unit.position, why);
}

export function walkMarks(draft: Draft, unit: Combatant, path: readonly Pos[]): void {
    for (const p of path.slice(0, -1)) {
        if (unit.status !== 'up') return;
        strikeAt(draft, unit, p, 'enter');
    }
}

export function slideStep(state: CombatState, unit: Combatant, from: Pos): Pos | null {
    const at = unit.position;
    const terrain = terrainOf(state);
    if (!at || !terrain || unit.status !== 'up') return null;
    const squares = slideAt(state, at);
    if (squares <= 0) return null;
    const dx = Math.sign(at.x - from.x);
    const dy = Math.sign(at.y - from.y);
    if (dx === 0 && dy === 0) return null;
    let here: Pos = { x: at.x, y: at.y };
    for (let i = 0; i < squares; i++) {
        const next = { x: here.x + dx, y: here.y + dy };
        if (!canStep(terrain, here, next)) break;
        if (Object.values(state.combatants).some(o => o.id !== unit.id && o.status === 'up' && samePos(o.position, next))) break;
        here = next;
    }
    return samePos(here, at) ? null : here;
}

export function slideUnit(draft: Draft, unit: Combatant, from: Pos): boolean {
    const s = draft.state;
    const landing = slideStep(s, unit, from);
    const at = unit.position;
    if (!landing || !at) return false;
    const record = markRecordAt(s, at);
    unit.position = { ...landing };
    const squares = distance(at, landing);
    emit(draft, {
        type: 'pushed',
        ...(record ? { actorId: record.ownerId } : {}),
        targetId: unit.id,
        data: {
            kind: 'slide', squares, slick: true, mark: record?.mark, ability: record?.name,
            moves: [{ id: unit.id, from: { ...at }, to: { ...landing } }],
        },
        text: `${unit.name} slides ${squares} ${squares === 1 ? 'square' : 'squares'} on the ${TILE_MARKS[record?.mark ?? 'slick'].word}.`,
    });
    return true;
}

export function reactExtend(draft: Draft, user: Combatant, target: Combatant, element: ElementId, abilityName: string): void {
    for (const row of conditionReactions(element)) {
        if (row.effect.kind !== 'extend' || !('condition' in row.on)) continue;
        const need = row.on.condition;
        if (!target.conditions.some(c => c.id === need)) continue;
        const effect = row.effect;
        const found = target.conditions.find(c => c.id === effect.condition && (!effect.tag || c.element === effect.tag));
        if (!found) continue;
        const before: CombatCondition = { ...found };
        found.turns = (found.turns ?? 0) + effect.turns;
        emit(draft, {
            type: 'reaction',
            actorId: user.id,
            targetId: target.id,
            data: {
                reaction: row.id, element, ability: abilityName, kind: 'extend', condition: effect.condition, turns: found.turns,
                before,
            },
            text: `${target.name}: ${row.word}`,
        });
    }
}

export function conductRow(target: Pick<Combatant, 'conditions'>, element: ElementId): ReactionRow | undefined {
    return conditionReactions(element).find(r => r.effect.kind === 'arc_all' && 'condition' in r.on && target.conditions.some(c => c.id === (r.on as { condition: string }).condition));
}

export function announceConduct(draft: Draft, user: Combatant, target: Combatant, element: ElementId, abilityName: string, row: ReactionRow): void {
    emit(draft, {
        type: 'reaction',
        actorId: user.id,
        targetId: target.id,
        data: { reaction: row.id, element, ability: abilityName, kind: 'arc_all' },
        text: `${target.name}: ${row.word}`,
    });
}
