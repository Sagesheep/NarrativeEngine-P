import { coverBetween, distance, hasLineOfSight, inBounds, isWalkable, samePos, sameTeam, terrainOf, tileAt, traceLine } from '../grid';
import {
    applyDamage, canTarget, DEFEND_CONDITION, emit, fieldItemData, hasCondition, hazardStrike, isPlayerSide, markDown, rollDamage, SLOWED, STUNNED,
} from '../core';
import type { Draft } from '../core';
import { UNARMED_DIE } from '../pc';
import type {
    AbilityKey, CarriedItem, CombatState, Combatant, DamageSpec, FieldItem, GlyphAbility, Grid, Pos, ThrowPayload, Tile, WeaponFields,
} from '../types';
import { builtinStats, strengthMod, THROWN_WEAPON_NAME } from './builtins';
import { GLYPH_NUMBERS as N, UNSTUNNABLE_TIERS } from './registry';
import { proficiencyOf, saveDc, saveModifier } from './numbers';

export type ThrowWeight = 'heavy' | 'medium' | 'light';

export type TerrainChange = { pos: Pos; from: Tile; to: Tile };

export const THROW_REASONS = {
    stunned: 'the thrower is stunned',
    noPayload: 'nothing to throw there',
    tooHeavy: 'too heavy to lift',
    noLanding: 'no square to throw it to',
    allyHazard: 'a willing ally cannot be thrown onto a hazard',
    noItem: 'that item is not carried',
    notOpen: 'the square is not open ground',
} as const;

export type ThrowPlan = {
    payload: ThrowPayload;
    name: string;
    weight: ThrowWeight;
    creatureId?: string;
    willing: boolean;
    body: boolean;
    from: Pos;
    landing: Pos;
    range: number;
    path: Pos[];
    struckId?: string;
    cover: number;
    endsAt?: Pos;
    displaced: boolean;
    hazard: boolean;
    hurtOnLanding: boolean;
    save?: { key: AbilityKey; dc: number };
    terrain: TerrainChange[];
    damage: DamageSpec;
    item?: CarriedItem;
};

export type ThrowPreview = { ok: true; plan: ThrowPlan } | { ok: false; reason: string };

export type PayloadInfo = {
    payload: ThrowPayload;
    weight: ThrowWeight;
    name: string;
    creatureId?: string;
    willing: boolean;
    body: boolean;
    coverAt?: Pos;
    item?: CarriedItem;
    damage: DamageSpec;
};

export type PayloadChoice = { payload: ThrowPayload; pos?: Pos; name: string; weight: ThrowWeight };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

export function throwWeight(payload: ThrowPayload): ThrowWeight {
    if (payload.kind === 'creature') return 'heavy';
    return payload.kind === 'cover' ? 'medium' : 'light';
}

export function throwRangeOf(user: Pick<Combatant, 'abilities'>, weight: ThrowWeight): number {
    const mod = strengthMod(user);
    if (weight === 'heavy') return Math.max(N.throwHeavyMin, N.throwHeavyRange + mod);
    if (weight === 'medium') return Math.max(N.throwMediumMin, N.throwMediumRange + mod);
    return Math.max(N.throwLightMin, N.throwLightRange + mod);
}

export function normalizeThrowPayload(raw: unknown): ThrowPayload | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Record<string, unknown>;
    if (r.kind === 'hand') return { kind: 'hand' };
    if (r.kind === 'creature' && typeof r.id === 'string') return { kind: 'creature', id: r.id };
    if (r.kind === 'item' && typeof r.itemId === 'string') return { kind: 'item', itemId: r.itemId };
    const at = r.at as Record<string, unknown> | undefined;
    if (r.kind === 'cover' && at && Number.isInteger(at.x) && Number.isInteger(at.y)) return { kind: 'cover', at: { x: at.x as number, y: at.y as number } };
    return undefined;
}

export function samePayload(a: ThrowPayload, b: ThrowPayload): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'creature') return a.id === (b as typeof a).id;
    if (a.kind === 'cover') return samePos(a.at, (b as typeof a).at);
    if (a.kind === 'item') return a.itemId === (b as typeof a).itemId;
    return true;
}

export function standingAt(state: CombatState, p: Pos, exceptIds: readonly string[] = []): Combatant | undefined {
    return Object.values(state.combatants).find(c => c.status === 'up' && !exceptIds.includes(c.id) && samePos(c.position, p));
}

function betterSaveKey(target: Combatant): AbilityKey {
    return saveModifier(target, 'DEX') > saveModifier(target, 'STR') ? 'DEX' : 'STR';
}

function coverName(state: CombatState): string {
    return state.grid?.labels?.cover?.replace(/\s+/g, ' ').trim().toLowerCase() || 'cover';
}

function liftable(user: Combatant, target: Combatant): { ok: true; willing: boolean; body: boolean } | { ok: false; reason: string } {
    if (target.id === user.id || !target.position || distance(user.position as Pos, target.position) !== N.touchRange) return fail(THROW_REASONS.noPayload);
    if (target.status === 'down') {
        return UNSTUNNABLE_TIERS.has(target.tier) ? fail(THROW_REASONS.tooHeavy) : { ok: true, willing: false, body: true };
    }
    if (target.status !== 'up') return fail(THROW_REASONS.noPayload);
    if (sameTeam(user.side, target.side)) {
        if (target.summonerId && target.tier !== 'minion' && target.tier !== 'grunt') return fail(THROW_REASONS.tooHeavy);
        return { ok: true, willing: true, body: false };
    }
    if (target.tier !== 'minion' && target.tier !== 'grunt') return fail(THROW_REASONS.tooHeavy);
    return { ok: true, willing: false, body: false };
}

export function payloadInfo(state: CombatState, user: Combatant, payload: ThrowPayload): { ok: true; info: PayloadInfo } | { ok: false; reason: string } {
    const mod = strengthMod(user);
    const weight = throwWeight(payload);
    if (payload.kind === 'creature') {
        const target = state.combatants[payload.id];
        if (!target) return fail(THROW_REASONS.noPayload);
        const lift = liftable(user, target);
        if (!lift.ok) return lift;
        return {
            ok: true,
            info: {
                payload, weight, name: target.name, creatureId: target.id, willing: lift.willing, body: lift.body,
                damage: { count: N.throwHeavyCount, sides: N.throwHeavySides, bonus: mod, type: 'bludgeoning' },
            },
        };
    }
    if (payload.kind === 'cover') {
        const terrain = terrainOf(state);
        if (!terrain || !user.position || distance(user.position, payload.at) !== N.touchRange || tileAt(terrain, payload.at) !== 'cover') return fail(THROW_REASONS.noPayload);
        return {
            ok: true,
            info: {
                payload, weight, name: coverName(state), willing: false, body: false, coverAt: { ...payload.at },
                damage: { count: 1, sides: N.throwMediumSides, bonus: mod, type: 'bludgeoning' },
            },
        };
    }
    if (payload.kind === 'item') {
        const item = (user.carried ?? []).find(i => i.id === payload.itemId);
        if (!item) return fail(THROW_REASONS.noItem);
        return {
            ok: true,
            info: {
                payload, weight, name: item.name, willing: false, body: false, item,
                damage: { count: item.count, sides: item.sides, bonus: mod, type: item.damageType?.trim() || 'bludgeoning' },
            },
        };
    }
    return {
        ok: true,
        info: { payload, weight, name: THROWN_WEAPON_NAME, willing: false, body: false, damage: { count: 1, sides: N.throwDie, bonus: 0, type: 'bludgeoning' } },
    };
}

function withTile(grid: Grid, p: Pos, tile: Tile): Grid {
    const tiles = [...grid.tiles];
    tiles[p.y * grid.width + p.x] = tile;
    return { ...grid, tiles };
}

export function nearestFree(state: CombatState, terrain: Grid, around: Pos, exceptIds: readonly string[], noHazard: boolean): Pos | null {
    let best: Pos | null = null;
    let bestD = Infinity;
    for (let y = 0; y < terrain.height; y++) {
        for (let x = 0; x < terrain.width; x++) {
            const p = { x, y };
            if (!isWalkable(terrain, p)) continue;
            if (noHazard && tileAt(terrain, p) === 'hazard') continue;
            if (standingAt(state, p, exceptIds)) continue;
            const d = (x - around.x) ** 2 + (y - around.y) ** 2;
            if (d < bestD) {
                best = p;
                bestD = d;
            }
        }
    }
    return best;
}

function pathOf(from: Pos, to: Pos): Pos[] {
    return traceLine(from, to).slice(1).filter(step => step.length === 1).map(step => ({ ...step[0] }));
}

export function previewThrow(state: CombatState, userId: string, payload: ThrowPayload, landing: Pos | null | undefined): ThrowPreview {
    const user = state.combatants[userId];
    const terrain = terrainOf(state);
    if (!user || user.status !== 'up' || !user.position || !terrain) return fail('the user cannot act');
    if (hasCondition(user, STUNNED)) return fail(THROW_REASONS.stunned);
    const got = payloadInfo(state, user, payload);
    if (!got.ok) return got;
    const info = got.info;
    if (!landing || !inBounds(terrain, landing)) return fail('choose a square');
    const from = user.position;
    if (samePos(from, landing)) return fail('aim at another square');
    const range = throwRangeOf(user, info.weight);
    if (distance(from, landing) > range) return fail('out of range');
    const open = info.coverAt ? withTile(terrain, info.coverAt, 'floor') : terrain;
    if (!isWalkable(open, landing)) return fail(THROW_REASONS.notOpen);
    if (!hasLineOfSight(open, from, landing)) return fail('no line of sight');
    const landingTile = tileAt(open, landing);
    if (info.willing && landingTile === 'hazard') return fail(THROW_REASONS.allyHazard);
    const except = info.creatureId ? [user.id, info.creatureId] : [user.id];
    const struck = standingAt(state, landing, except);
    let endsAt: Pos | undefined;
    let displaced = false;
    if (info.creatureId) {
        if (struck) {
            const free = nearestFree(state, open, landing, [info.creatureId], info.willing);
            if (!free) return fail(THROW_REASONS.noLanding);
            endsAt = free;
            displaced = true;
        } else {
            endsAt = { ...landing };
        }
    }
    const end = endsAt ?? landing;
    const terrainChanges: TerrainChange[] = [];
    if (info.coverAt) {
        terrainChanges.push({ pos: { ...info.coverAt }, from: 'cover', to: 'floor' });
        const base = tileAt(open, landing);
        if (base !== 'hazard' && base !== 'difficult') terrainChanges.push({ pos: { ...landing }, from: base, to: 'difficult' });
    }
    const target = info.creatureId ? state.combatants[info.creatureId] : undefined;
    const unwilling = !!target && !info.willing && !info.body;
    const plan: ThrowPlan = {
        payload: info.payload,
        name: info.name,
        weight: info.weight,
        ...(info.creatureId ? { creatureId: info.creatureId } : {}),
        willing: info.willing,
        body: info.body,
        from: { ...from },
        landing: { ...landing },
        range,
        path: pathOf(from, landing),
        ...(struck ? { struckId: struck.id } : {}),
        cover: struck ? coverBetween(open, from, landing) : 0,
        ...(endsAt ? { endsAt } : {}),
        displaced,
        hazard: tileAt(open, end) === 'hazard',
        hurtOnLanding: unwilling,
        ...(unwilling && target ? { save: { key: betterSaveKey(target), dc: saveDc(builtinStats(user)) } } : {}),
        terrain: terrainChanges,
        damage: info.damage,
        ...(info.item ? { item: { ...info.item } } : {}),
    };
    return { ok: true, plan };
}

function adjacentTiles(user: Combatant): Pos[] {
    const at = user.position as Pos;
    const out: Pos[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx !== 0 || dy !== 0) out.push({ x: at.x + dx, y: at.y + dy });
    return out;
}

export function payloadAt(state: CombatState, userId: string, pos: Pos): { ok: true; payload: ThrowPayload } | { ok: false; reason: string } {
    const user = state.combatants[userId];
    const terrain = terrainOf(state);
    if (!user || user.status !== 'up' || !user.position || !terrain) return fail('the user cannot act');
    if (distance(user.position, pos) !== N.touchRange) return fail('out of reach');
    const here = Object.values(state.combatants).filter(c => c.id !== user.id && samePos(c.position, pos));
    const creature = here.find(c => c.status === 'up') ?? here.find(c => c.status === 'down') ?? here.find(c => c.status === 'surrendered');
    if (creature) {
        const lift = liftable(user, creature);
        return lift.ok ? { ok: true, payload: { kind: 'creature', id: creature.id } } : lift;
    }
    if (tileAt(terrain, pos) === 'cover') return { ok: true, payload: { kind: 'cover', at: { ...pos } } };
    return fail(THROW_REASONS.noPayload);
}

export function payloadChoices(state: CombatState, userId: string): PayloadChoice[] {
    const user = state.combatants[userId];
    if (!user || user.status !== 'up' || !user.position || !terrainOf(state)) return [];
    const out: PayloadChoice[] = [];
    for (const pos of adjacentTiles(user)) {
        const found = payloadAt(state, userId, pos);
        if (!found.ok) continue;
        const info = payloadInfo(state, user, found.payload);
        if (info.ok) out.push({ payload: found.payload, pos, name: info.info.name, weight: info.info.weight });
    }
    for (const item of user.carried ?? []) out.push({ payload: { kind: 'item', itemId: item.id }, name: item.name, weight: 'light' });
    out.push({ payload: { kind: 'hand' }, name: THROWN_WEAPON_NAME, weight: 'light' });
    return out;
}

export function payloadTiles(state: CombatState, userId: string): Pos[] {
    return payloadChoices(state, userId).flatMap(c => (c.pos ? [{ ...c.pos }] : []));
}

export function legalLandings(state: CombatState, userId: string, payload: ThrowPayload): Pos[] {
    const user = state.combatants[userId];
    if (!user?.position) return [];
    const got = payloadInfo(state, user, payload);
    if (!got.ok || hasCondition(user, STUNNED)) return [];
    const range = throwRangeOf(user, got.info.weight);
    const out: Pos[] = [];
    for (let y = user.position.y - range; y <= user.position.y + range; y++) {
        for (let x = user.position.x - range; x <= user.position.x + range; x++) {
            if (previewThrow(state, userId, payload, { x, y }).ok) out.push({ x, y });
        }
    }
    return out;
}

export function throwReason(state: CombatState, userId: string): string | null {
    const user = state.combatants[userId];
    if (!user?.position) return 'the user cannot act';
    if (hasCondition(user, STUNNED)) return THROW_REASONS.stunned;
    for (const choice of payloadChoices(state, userId)) {
        if (legalLandings(state, userId, choice.payload).length > 0) return null;
    }
    return THROW_REASONS.noLanding;
}

export function weaponFieldsOf(c: Combatant): WeaponFields {
    return { damage: { ...c.damage }, ...(c.weaponName ? { weaponName: c.weaponName } : {}), ...(c.range ? { range: c.range } : {}) };
}

export function bareHands(fields: WeaponFields): WeaponFields {
    return { damage: { count: UNARMED_DIE.count, sides: UNARMED_DIE.sides, bonus: fields.damage.bonus, type: 'bludgeoning' }, range: 'close' };
}

export function applyWeaponFields(c: Combatant, fields: WeaponFields): void {
    c.damage = { ...fields.damage };
    if (fields.weaponName) c.weaponName = fields.weaponName;
    else delete c.weaponName;
    if (fields.range) c.range = fields.range;
    else delete c.range;
}

function payloadData(plan: ThrowPlan): Record<string, unknown> {
    const p = plan.payload;
    return {
        kind: p.kind,
        name: plan.name,
        weight: plan.weight,
        ...(p.kind === 'creature' ? { id: p.id, willing: plan.willing, body: plan.body } : {}),
        ...(p.kind === 'item' ? { itemId: p.itemId } : {}),
        ...(p.kind === 'cover' ? { at: { ...p.at } } : {}),
    };
}

function hostileBeside(state: CombatState, user: Combatant, exceptId: string | undefined): boolean {
    const at = user.position as Pos;
    return Object.values(state.combatants).some(o => o.id !== user.id && o.id !== exceptId && canTarget(user, o) && !!o.position && distance(o.position, at) <= 1);
}

export type ThrownCreature = { creatureId: string; from: Pos };

export function resolveThrow(draft: Draft, actorId: string, ability: GlyphAbility, payload: ThrowPayload, landing: Pos): ThrownCreature | null {
    const s = draft.state;
    const user = s.combatants[actorId];
    const preview = previewThrow(s, actorId, payload, landing);
    if (!preview.ok) return null;
    const plan = preview.plan;
    const creature = plan.creatureId ? s.combatants[plan.creatureId] : undefined;
    const struck = plan.struckId ? s.combatants[plan.struckId] : undefined;
    emit(draft, {
        type: 'ability',
        actorId,
        data: {
            abilityId: ability.id, name: ability.name, damageType: plan.damage.type, form: ability.form.id,
            effects: ability.effects.map(e => e.id), cost: 0, slot: 'action', targets: struck ? [struck.id] : [], payload: payloadData(plan),
        },
        text: `${user.name} uses ${ability.name}.`,
    });
    if (plan.save && creature) {
        const natural = draft.rng.roll(20);
        const total = natural + saveModifier(creature, plan.save.key);
        const success = total >= plan.save.dc;
        emit(draft, {
            type: 'save',
            actorId,
            targetId: creature.id,
            data: { save: plan.save.key, dc: plan.save.dc, natural, total, success, ability: ability.name, builtin: 'throw' },
            text: success
                ? `${creature.name} succeeds on a ${plan.save.key} save (${total} against DC ${plan.save.dc}) and wrenches free.`
                : `${creature.name} fails a ${plan.save.key} save (${total} against DC ${plan.save.dc}) and is lifted.`,
        });
        if (success) return null;
    }
    let roll: { natural: number; total: number; ac: number; disadvantage: boolean; defending: boolean; crit: boolean; hit: boolean } | null = null;
    if (struck) {
        const defending = hasCondition(struck, DEFEND_CONDITION);
        const disadvantage = defending || hostileBeside(s, user, plan.creatureId) || hasCondition(user, SLOWED);
        const first = draft.rng.roll(20);
        const natural = disadvantage ? Math.min(first, draft.rng.roll(20)) : first;
        const total = natural + proficiencyOf(user) + strengthMod(user);
        const ac = struck.ac + plan.cover;
        const crit = natural === 20;
        roll = { natural, total, ac, disadvantage, defending, crit, hit: crit || (natural !== 1 && total >= ac) };
    }
    let hurt: Record<string, unknown> = {};
    let dealt = 0;
    if (struck && roll?.hit) {
        const dice = roll.crit ? plan.damage.count * 2 : plan.damage.count;
        dealt = rollDamage(draft.rng, dice, plan.damage.sides, plan.damage.bonus);
        const result = applyDamage(struck, dealt);
        hurt = {
            damage: dealt, damageType: plan.damage.type, hpBefore: result.hpBefore, tempBefore: result.tempBefore, hpAfter: struck.hp,
            ...(result.absorbed > 0 ? { absorbed: result.absorbed } : {}),
        };
    }
    const moves: Array<{ id: string; from: Pos; to: Pos }> = [];
    let carried: ThrownCreature | null = null;
    if (creature && plan.endsAt) {
        const origin = { ...(creature.position as Pos) };
        moves.push({ id: creature.id, from: origin, to: { ...plan.endsAt } });
        creature.position = { ...plan.endsAt };
        carried = { creatureId: creature.id, from: origin };
    }
    if (plan.terrain.length > 0) s.terrainEdits = [...(s.terrainEdits ?? []), ...plan.terrain.map(c => ({ pos: { ...c.pos }, tile: c.to }))];
    emit(draft, {
        type: 'thrown',
        actorId,
        ...(struck ? { targetId: struck.id } : {}),
        data: {
            ability: ability.name,
            builtin: 'throw',
            payload: payloadData(plan),
            from: { ...plan.from },
            to: { ...plan.landing },
            range: plan.range,
            moves,
            displaced: plan.displaced,
            hazard: plan.hazard,
            terrain: plan.terrain.map(c => ({ pos: { ...c.pos }, from: c.from, to: c.to })),
            ...(roll
                ? {
                    natural: roll.natural, total: roll.total, ac: roll.ac, cover: plan.cover, disadvantage: roll.disadvantage,
                    ...(roll.defending ? { defending: true } : {}), hit: roll.hit, crit: roll.hit && roll.crit, fumble: roll.natural === 1,
                }
                : {}),
            ...hurt,
        },
        text: thrownText(user, plan, struck, roll?.hit === true, dealt),
    });
    if (struck && struck.hp <= 0) markDown(draft, struck, { actorId });
    if (creature && plan.hurtOnLanding && creature.status === 'up') {
        const landed = draft.rng.roll(N.throwLandingSides);
        const result = applyDamage(creature, landed);
        emit(draft, {
            type: 'ability_damage',
            actorId,
            targetId: creature.id,
            data: {
                ability: ability.name, builtin: 'throw', kind: 'landing', damage: landed, damageType: 'bludgeoning', saved: false, crit: false,
                weakness: false, resisted: false, absorbed: result.absorbed, hpBefore: result.hpBefore, tempBefore: result.tempBefore, hpAfter: creature.hp,
            },
            text: `${creature.name} takes ${landed} bludgeoning damage from the landing.`,
        });
        if (creature.hp <= 0) markDown(draft, creature, { actorId });
    }
    if (creature && plan.hazard && creature.status === 'up') hazardStrike(draft, creature);
    if (plan.item) dropItem(draft, user, plan);
    return carried;
}

function thrownText(user: Combatant, plan: ThrowPlan, struck: Combatant | undefined, hit: boolean, damage: number): string {
    const what = plan.payload.kind === 'hand' ? 'whatever was at hand' : plan.name;
    if (!struck) return `${user.name} hurls ${what} across the field.`;
    return hit
        ? `${user.name} hurls ${what} at ${struck.name} and hits for ${damage} ${plan.damage.type}.`
        : `${user.name} hurls ${what} at ${struck.name} and misses.`;
}

function dropItem(draft: Draft, user: Combatant, plan: ThrowPlan): void {
    const s = draft.state;
    const item = plan.item as CarriedItem;
    const carried = user.carried ?? [];
    const index = carried.findIndex(i => i.id === item.id);
    user.carried = carried.filter(i => i.id !== item.id);
    const field: FieldItem = { ...item, pos: { ...plan.landing }, ownerId: user.id };
    if (item.equipped) {
        field.armed = weaponFieldsOf(user);
        applyWeaponFields(user, bareHands(field.armed));
    }
    s.fieldItems = [...(s.fieldItems ?? []), field];
    emit(draft, {
        type: 'item_dropped',
        actorId: user.id,
        data: { itemId: item.id, name: item.name, at: { ...plan.landing }, index, item: fieldItemData(field), disarmed: !!field.armed },
        text: `${item.name} lies on the ground at ${plan.landing.x + 1},${plan.landing.y + 1}.`,
    });
}

export function pickUpItems(draft: Draft, actor: Combatant, path: readonly Pos[]): void {
    const s = draft.state;
    if (!s.fieldItems || s.fieldItems.length === 0 || !isPlayerSide(actor.side) || actor.status !== 'up') return;
    for (const p of path) {
        const here: FieldItem[] = (s.fieldItems ?? []).filter(i => samePos(i.pos, p));
        for (const item of here) {
            s.fieldItems = (s.fieldItems ?? []).filter(i => i.id !== item.id);
            const owner = item.ownerId === actor.id;
            const rearm = owner && !!item.armed;
            const carriedItem: CarriedItem = {
                id: item.id, name: item.name, count: item.count, sides: item.sides,
                ...(item.damageType ? { damageType: item.damageType } : {}),
                ...(owner && item.equipped ? { equipped: true } : {}),
            };
            actor.carried = [...(actor.carried ?? []), carriedItem];
            if (rearm && item.armed) applyWeaponFields(actor, item.armed);
            emit(draft, {
                type: 'item_recovered',
                actorId: actor.id,
                data: { how: 'picked_up', itemId: item.id, name: item.name, at: { ...item.pos }, item: fieldItemData(item), rearmed: rearm },
                text: `${actor.name} picks up ${item.name}.`,
            });
        }
    }
}
