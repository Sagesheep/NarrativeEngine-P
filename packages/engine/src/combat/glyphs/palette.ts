import type { AugmentId, EffectId, ElementId, ElementPresetId, FormId, GlyphAbility, GlyphTier } from '../types';
import { checkElement, elementCost, normalizePreset } from '../elements/rules';
import {
    AUGMENT_COSTS, AUGMENT_IDS, AUGMENT_TIERS, DAMPENED_COST_FLOOR, DELAY_REFUSED_EFFECTS, EFFECT_IDS, EFFECTS, FORM_IDS, FORMS, GLYPH_NUMBERS as N, TELEPORT_EFFECTS,
} from './registry';
import {
    barrierRounds, blinkRange, burstRadius, burstRange, chainJumps, chainRange, coneLength, count, damageDice, dashLength, decayDice, drainDice,
    fearTurns, gravitySquares, healDice, hasteTurns, leapGlyphRange, lineLength, lineWidth, mantleRadius, mantleRounds, projectileRange,
    pushDistance, saveDc, shieldAmount, shieldTurns, sigilRange, sigilRounds, slowTurns, snareTurns, stunTurns, summonRounds, summonTier,
    wallLength, wallRange, wallRounds,
} from './numbers';
import type { CasterStats } from './numbers';
import { dampenedCost, effectClause, formClause } from './validate';
import type { AbilityLimits } from './validate';

export type GlyphRef =
    | { kind: 'form'; id: FormId }
    | { kind: 'effect'; id: EffectId }
    | { kind: 'augment'; id: AugmentId };

export type GlyphKind = GlyphRef['kind'];

export type ChainDraft = {
    form: { id: FormId | null; augments: AugmentId[] };
    effects: { id: EffectId; augments: AugmentId[] }[];
    element?: ElementId;
};

export type ElementPlacementReason =
    | { code: 'unknown-element' }
    | { code: 'outside-preset'; preset: ElementPresetId }
    | { code: 'chain-full'; limit: number };

export type SocketOwner = 'form' | number;

export type Socket =
    | { kind: 'form' }
    | { kind: 'effect'; index: number }
    | { kind: 'augment'; owner: SocketOwner; index: number };

export type PlacementReason =
    | { code: 'wrong-socket'; expects: GlyphKind }
    | { code: 'needs-form' }
    | { code: 'form-cannot-carry'; forms: FormId[] }
    | { code: 'already-used' }
    | { code: 'must-be-alone' }
    | { code: 'solo-present'; with: EffectId }
    | { code: 'swap-conflict' }
    | { code: 'barrier-widen' }
    | { code: 'summons-off' }
    | { code: 'not-accepted'; by: GlyphRef }
    | { code: 'no-owner'; accepted: GlyphRef[] }
    | { code: 'augment-limit'; max: number }
    | { code: 'effects-full'; max: number }
    | { code: 'chain-full'; limit: number };

export type ChainColumn = {
    key: string;
    owner: Socket;
    ownerId: SocketOwner | null;
    glyph: GlyphRef | null;
    augments: { socket: Socket; glyph: GlyphRef | null }[];
};

const SOLO_EFFECTS: ReadonlySet<EffectId> = new Set<EffectId>(['barrier', 'summon']);

export function emptyChain(): ChainDraft {
    return { form: { id: null, augments: [] }, effects: [] };
}

export function chainOf(ability: GlyphAbility): ChainDraft {
    return {
        form: { id: ability.form.id, augments: [...ability.form.augments] },
        effects: ability.effects.map(e => ({ id: e.id, augments: [...e.augments] })),
        ...(ability.element ? { element: ability.element } : {}),
    };
}

export function placeElement(chain: ChainDraft, element: ElementId | null): ChainDraft {
    const next: ChainDraft = { ...chain };
    delete next.element;
    return element ? { ...next, element } : next;
}

export function elementPlacementReason(chain: ChainDraft, element: string, limits: AbilityLimits): ElementPlacementReason | null {
    const checked = checkElement(limits.elementPreset, element);
    if (!checked.ok) return checked.reason === 'unknown' ? { code: 'unknown-element' } : { code: 'outside-preset', preset: normalizePreset(limits.elementPreset) };
    const count = chainCount(chain.element ? placeElement(chain, null) : chain) + 1;
    return count > limits.maxChainLength ? { code: 'chain-full', limit: limits.maxChainLength } : null;
}

export function allGlyphs(kind: GlyphKind): GlyphRef[] {
    if (kind === 'form') return FORM_IDS.map(id => ({ kind, id }));
    if (kind === 'effect') return EFFECT_IDS.map(id => ({ kind, id }));
    return AUGMENT_IDS.map(id => ({ kind, id }));
}

export function acceptedAugments(glyph: GlyphRef): readonly AugmentId[] {
    if (glyph.kind === 'form') return FORMS[glyph.id].augments;
    if (glyph.kind === 'effect') return EFFECTS[glyph.id].augments;
    return [];
}

export function glyphsAccepting(augment: AugmentId): GlyphRef[] {
    return [
        ...FORM_IDS.filter(id => FORMS[id].augments.includes(augment)).map((id): GlyphRef => ({ kind: 'form', id })),
        ...EFFECT_IDS.filter(id => EFFECTS[id].augments.includes(augment)).map((id): GlyphRef => ({ kind: 'effect', id })),
    ];
}

export function augmentCapacity(glyph: GlyphRef): number {
    return acceptedAugments(glyph).length * N.maxSameAugment;
}

export function glyphCost(glyph: GlyphRef): number {
    if (glyph.kind === 'form') return FORMS[glyph.id].cost;
    if (glyph.kind === 'effect') return EFFECTS[glyph.id].cost;
    return AUGMENT_COSTS[glyph.id];
}

export function chainCost(chain: ChainDraft): number {
    const form = chain.form.id ? FORMS[chain.form.id].cost : 0;
    const formAug = chain.form.augments.reduce((sum, a) => sum + AUGMENT_COSTS[a], 0);
    const effects = chain.effects.reduce((sum, e) => sum + EFFECTS[e.id].cost + e.augments.reduce((s, a) => s + AUGMENT_COSTS[a], 0), 0);
    return dampenedCost(form + formAug + effects + elementCost(chain.element), chain.effects);
}

export function glyphTier(glyph: GlyphRef): GlyphTier {
    if (glyph.kind === 'form') return FORMS[glyph.id].tier;
    if (glyph.kind === 'effect') return EFFECTS[glyph.id].tier;
    return AUGMENT_TIERS[glyph.id];
}

function comboReason(formId: FormId, formAugments: readonly AugmentId[], effects: readonly { id: EffectId; augments: readonly AugmentId[] }[], placed: GlyphRef): PlacementReason | null {
    if (count(formAugments, 'delay') > 0) {
        const bad = effects.find(e => DELAY_REFUSED_EFFECTS.has(e.id));
        if (bad) return { code: 'not-accepted', by: placed.kind === 'effect' && placed.id === bad.id ? { kind: 'augment', id: 'delay' } : { kind: 'effect', id: bad.id } };
    }
    for (const e of effects) {
        if (count(e.augments, 'dampen') > 0 && count(e.augments, 'amplify') > 0) {
            return { code: 'not-accepted', by: placed.kind === 'augment' && placed.id === 'amplify' ? { kind: 'augment', id: 'dampen' } : { kind: 'augment', id: 'amplify' } };
        }
    }
    const teleports = effects.filter(e => TELEPORT_EFFECTS.has(e.id));
    if (teleports.length > 1) {
        const other = teleports.find(e => !(placed.kind === 'effect' && placed.id === e.id)) ?? teleports[0];
        return { code: 'not-accepted', by: { kind: 'effect', id: other.id } };
    }
    if (FORMS[formId].placed) {
        const hostile = effects.find(e => EFFECTS[e.id].hostile);
        const helpful = effects.find(e => EFFECTS[e.id].helpful);
        if (hostile && helpful) {
            const other = placed.kind === 'effect' && placed.id === hostile.id ? helpful : hostile;
            return { code: 'not-accepted', by: { kind: 'effect', id: other.id } };
        }
    }
    return null;
}

export function chainCount(chain: ChainDraft): number {
    return (chain.element ? 1 : 0) + (chain.form.id ? 1 : 0) + chain.form.augments.length + chain.effects.reduce((sum, e) => sum + 1 + e.augments.length, 0);
}

function ownerGlyph(chain: ChainDraft, owner: SocketOwner): GlyphRef | null {
    if (owner === 'form') return chain.form.id ? { kind: 'form', id: chain.form.id } : null;
    const effect = chain.effects[owner];
    return effect ? { kind: 'effect', id: effect.id } : null;
}

function ownerAugments(chain: ChainDraft, owner: SocketOwner): AugmentId[] {
    return owner === 'form' ? chain.form.augments : chain.effects[owner]?.augments ?? [];
}

export function socketGlyph(chain: ChainDraft, socket: Socket): GlyphRef | null {
    if (socket.kind === 'form') return ownerGlyph(chain, 'form');
    if (socket.kind === 'effect') return ownerGlyph(chain, socket.index);
    const id = ownerAugments(chain, socket.owner)[socket.index];
    return id ? { kind: 'augment', id } : null;
}

function withAugments(chain: ChainDraft, owner: SocketOwner, augments: AugmentId[]): ChainDraft {
    if (owner === 'form') return { ...chain, form: { ...chain.form, augments } };
    return { ...chain, effects: chain.effects.map((e, i) => i === owner ? { ...e, augments } : e) };
}

export function placeGlyph(chain: ChainDraft, socket: Socket, glyph: GlyphRef): ChainDraft {
    if (socket.kind === 'form' && glyph.kind === 'form') {
        const kept = chain.form.augments.filter(a => FORMS[glyph.id].augments.includes(a));
        return { ...chain, form: { id: glyph.id, augments: kept } };
    }
    if (socket.kind === 'effect' && glyph.kind === 'effect') {
        const accepted = EFFECTS[glyph.id].augments;
        const old = chain.effects[socket.index];
        const next = { id: glyph.id, augments: (old?.augments ?? []).filter(a => accepted.includes(a)) };
        if (old) return { ...chain, effects: chain.effects.map((e, i) => i === socket.index ? next : e) };
        return { ...chain, effects: [...chain.effects, next] };
    }
    if (socket.kind === 'augment' && glyph.kind === 'augment') {
        const list = ownerAugments(chain, socket.owner);
        const next = socket.index < list.length ? list.map((a, i) => i === socket.index ? glyph.id : a) : [...list, glyph.id];
        return withAugments(chain, socket.owner, next);
    }
    return chain;
}

export function removeGlyph(chain: ChainDraft, socket: Socket): ChainDraft {
    if (socket.kind === 'form') return { ...chain, form: { id: null, augments: [] } };
    if (socket.kind === 'effect') return { ...chain, effects: chain.effects.filter((_, i) => i !== socket.index) };
    return withAugments(chain, socket.owner, ownerAugments(chain, socket.owner).filter((_, i) => i !== socket.index));
}

export function placementReason(chain: ChainDraft, socket: Socket, glyph: GlyphRef, limits: AbilityLimits): PlacementReason | null {
    if (socket.kind !== glyph.kind) return { code: 'wrong-socket', expects: socket.kind };
    const next = placeGlyph(chain, socket, glyph);
    const chainFull: PlacementReason = { code: 'chain-full', limit: limits.maxChainLength };
    const tooLong = chainCount(next) > limits.maxChainLength;
    const combo = next.form.id ? comboReason(next.form.id, next.form.augments, next.effects, glyph) : null;
    if (socket.kind === 'form') return combo ?? (tooLong ? chainFull : null);
    if (socket.kind === 'effect' && glyph.kind === 'effect') {
        const id = glyph.id;
        const formId = chain.form.id;
        const others = chain.effects.filter((_, i) => i !== socket.index);
        if (!formId) return { code: 'needs-form' };
        if (!FORMS[formId].effects.includes(id)) {
            return { code: 'form-cannot-carry', forms: FORM_IDS.filter(f => FORMS[f].effects.includes(id)) };
        }
        if (others.some(e => e.id === id)) return { code: 'already-used' };
        if (id === 'summon' && (limits.maxSummons ?? 1) <= 0) return { code: 'summons-off' };
        if (SOLO_EFFECTS.has(id) && others.length > 0) return { code: 'must-be-alone' };
        const solo = others.find(e => SOLO_EFFECTS.has(e.id));
        if (solo) return { code: 'solo-present', with: solo.id };
        if (id === 'swap' && (count(chain.form.augments, 'split') > 0 || count(chain.form.augments, 'pierce') > 0)) return { code: 'swap-conflict' };
        if (id === 'barrier' && count(chain.form.augments, 'widen') > 0) return { code: 'barrier-widen' };
        if (socket.index >= chain.effects.length && chain.effects.length >= N.maxEffects) return { code: 'effects-full', max: N.maxEffects };
        return combo ?? (tooLong ? chainFull : null);
    }
    if (socket.kind === 'augment' && glyph.kind === 'augment') {
        const id = glyph.id;
        const owner = ownerGlyph(chain, socket.owner);
        if (!owner) return { code: 'no-owner', accepted: glyphsAccepting(id) };
        if (!acceptedAugments(owner).includes(id)) return { code: 'not-accepted', by: owner };
        const others = ownerAugments(chain, socket.owner).filter((_, i) => i !== socket.index);
        if (count(others, id) >= N.maxSameAugment) return { code: 'augment-limit', max: N.maxSameAugment };
        if (socket.owner === 'form') {
            const effectIds = chain.effects.map(e => e.id);
            if ((id === 'split' || id === 'pierce') && effectIds.includes('swap')) return { code: 'swap-conflict' };
            if (id === 'widen' && effectIds.includes('barrier')) return { code: 'barrier-widen' };
        }
        return combo ?? (tooLong ? chainFull : null);
    }
    return null;
}

export function chainColumns(chain: ChainDraft): ChainColumn[] {
    const build = (key: string, owner: Socket, ownerId: SocketOwner | null): ChainColumn => {
        const glyph = ownerId === null ? null : ownerGlyph(chain, ownerId);
        const augments: ChainColumn['augments'] = [];
        if (glyph && ownerId !== null) {
            const list = ownerAugments(chain, ownerId);
            const slots = Math.min(augmentCapacity(glyph), Math.max(N.maxSameAugment, list.length + 1));
            for (let index = 0; index < slots; index++) {
                const id = list[index];
                augments.push({ socket: { kind: 'augment', owner: ownerId, index }, glyph: id ? { kind: 'augment', id } : null });
            }
        }
        return { key, owner, ownerId, glyph, augments };
    };
    const columns: ChainColumn[] = [build('form', { kind: 'form' }, 'form')];
    chain.effects.forEach((_, index) => columns.push(build(`effect-${index}`, { kind: 'effect', index }, index)));
    if (chain.effects.length < N.maxEffects) {
        columns.push(build(`effect-${chain.effects.length}`, { kind: 'effect', index: chain.effects.length }, null));
    }
    return columns;
}

export function socketKey(socket: Socket): string {
    if (socket.kind === 'form') return 'form';
    if (socket.kind === 'effect') return `effect-${socket.index}`;
    return `augment-${socket.owner}-${socket.index}`;
}

export function sameSocket(a: Socket | null, b: Socket | null): boolean {
    return !!a && !!b && socketKey(a) === socketKey(b);
}

export function firstFreeSocket(chain: ChainDraft, glyph: GlyphRef, limits: AbilityLimits): Socket | null {
    if (glyph.kind === 'form') return placementReason(chain, { kind: 'form' }, glyph, limits) ? null : { kind: 'form' };
    const empties = chainColumns(chain)
        .flatMap(c => [c.owner, ...c.augments.map(a => a.socket)])
        .filter(s => s.kind === glyph.kind && !socketGlyph(chain, s));
    return empties.find(s => !placementReason(chain, s, glyph, limits)) ?? null;
}

export function autoPlacementReason(chain: ChainDraft, glyph: GlyphRef, limits: AbilityLimits): PlacementReason | null {
    if (firstFreeSocket(chain, glyph, limits)) return null;
    if (glyph.kind === 'form') return placementReason(chain, { kind: 'form' }, glyph, limits);
    if (glyph.kind === 'effect') return placementReason(chain, { kind: 'effect', index: chain.effects.length }, glyph, limits);
    const owners = chainColumns(chain).filter(c => c.glyph && c.ownerId !== null && acceptedAugments(c.glyph).includes(glyph.id));
    if (owners.length === 0) return { code: 'no-owner', accepted: glyphsAccepting(glyph.id) };
    for (const column of owners) {
        const socket: Socket = { kind: 'augment', owner: column.ownerId as SocketOwner, index: ownerAugments(chain, column.ownerId as SocketOwner).length };
        const reason = placementReason(chain, socket, glyph, limits);
        if (reason) return reason;
    }
    return { code: 'augment-limit', max: N.maxSameAugment };
}

function capitalise(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function probe(form: FormId, augments: AugmentId[] = []): GlyphAbility {
    return { id: 'probe', name: 'probe', form: { id: form, augments }, effects: [], source: 'player' };
}

function step(label: string, from: string | number, to: string | number, unit = ''): string {
    return `${label}: ${from}${unit} → ${to}${unit}`;
}

function augmentLines(id: AugmentId, stats: CasterStats): string[] {
    const a: AugmentId[] = [id];
    switch (id) {
        case 'amplify':
            return [
                step('Damage', damageDice(stats, []), damageDice(stats, a), 'd6'),
                step('Heal', healDice(stats, []), healDice(stats, a), 'd4'),
                step('Shield', shieldAmount(stats, []), shieldAmount(stats, a), ' HP'),
                step('Push, Pull', pushDistance([]), pushDistance(a), ' squares'),
                step('Drain', drainDice(stats, []), drainDice(stats, a), 'd6'),
                step('Summon', summonTier([]), summonTier(a)),
                step('Gravity', gravitySquares([]), gravitySquares(a), ' squares'),
                step('Decay', decayDice(stats, []), decayDice(stats, a), `d${N.decaySides}`),
            ];
        case 'extend':
            return [
                step('Projectile range', projectileRange(probe('projectile')), projectileRange(probe('projectile', a)), ' squares'),
                step('Line length', lineLength(probe('line')), lineLength(probe('line', a)), ' squares'),
                step('Cone length', coneLength(probe('cone')), coneLength(probe('cone', a)), ' squares'),
                step('Burst range', burstRange(probe('burst')), burstRange(probe('burst', a)), ' squares'),
                step('Dash length', dashLength(probe('dash')), dashLength(probe('dash', a)), ' squares'),
                step('Blink range', blinkRange([]), blinkRange(a), ' squares'),
                step('Shield', shieldTurns([]), shieldTurns(a), ' turns'),
                step('Stun', stunTurns([]), stunTurns(a), ' turns'),
                step('Slow', slowTurns([]), slowTurns(a), ' turns'),
                step('Haste', hasteTurns([]), hasteTurns(a), ' turns'),
                step('Barrier', barrierRounds([]), barrierRounds(a), ' rounds'),
                step('Summon', summonRounds([]), summonRounds(a), ' rounds'),
                step('Sigil range', sigilRange(probe('sigil')), sigilRange(probe('sigil', a)), ' squares'),
                step('Chain range', chainRange(probe('chain')), chainRange(probe('chain', a)), ' squares'),
                step('Wall range', wallRange(probe('wall')), wallRange(probe('wall', a)), ' squares'),
                step('Leap range', leapGlyphRange([]), leapGlyphRange(a), ' squares'),
            ];
        case 'widen': {
            const side = (ability: GlyphAbility) => burstRadius(ability) * 2 + 1;
            return [
                step('Burst', `${side(probe('burst'))}×${side(probe('burst'))}`, `${side(probe('burst', a))}×${side(probe('burst', a))}`),
                step('Cone length', coneLength(probe('cone')), coneLength(probe('cone', a)), ' squares'),
                step('Line width', lineWidth(probe('line')), lineWidth(probe('line', a)), ' squares'),
                step('Mantle', `${mantleRadius(probe('mantle')) * 2 + 1}×${mantleRadius(probe('mantle')) * 2 + 1}`, `${mantleRadius(probe('mantle', a)) * 2 + 1}×${mantleRadius(probe('mantle', a)) * 2 + 1}`),
                step('Chain jumps', chainJumps(probe('chain')), chainJumps(probe('chain', a))),
                step('Wall length', wallLength(probe('wall')), wallLength(probe('wall', a)), ' squares'),
            ];
        }
        case 'dampen':
            return [
                step('Damage', damageDice(stats, []), damageDice(stats, a), 'd6'),
                step('Heal', healDice(stats, []), healDice(stats, a), 'd4'),
                step('Shield', shieldAmount(stats, []), shieldAmount(stats, a), ' HP'),
                step('Push, Pull', pushDistance([]), pushDistance(a), ' squares'),
                step('Drain', drainDice(stats, []), drainDice(stats, a), 'd6'),
                `Costs ${-AUGMENT_COSTS.dampen} MP less (an ability never costs less than ${DAMPENED_COST_FLOOR} MP).`,
            ];
        case 'sustain':
            return [
                step('Sigil', sigilRounds(probe('sigil')), sigilRounds(probe('sigil', a)), ' rounds'),
                step('Mantle', mantleRounds(probe('mantle')), mantleRounds(probe('mantle', a)), ' rounds'),
                step('Wall', wallRounds(probe('wall')), wallRounds(probe('wall', a)), ' rounds'),
                step('Snare', snareTurns([]), snareTurns(a), ' turns'),
                step('Fear', fearTurns([]), fearTurns(a), ' turns'),
            ];
        case 'delay':
            return [`Goes off at the start of the user's next turn on whoever is then in the squares aimed at, with ${N.delayBoost} more die of damage or healing.`];
        case 'pierce':
            return ['Projectile: passes through combatants and cover, not walls, and hits every combatant on its path.'];
        case 'split':
            return [`Touch, Projectile: one extra target within ${N.splitRange} squares of the first.`];
        case 'quicken':
            return ['Uses the bonus action instead of the action.'];
        default:
            return [];
    }
}

export function describeGlyph(glyph: GlyphRef, stats: CasterStats): string[] {
    const lines: string[] = [];
    if (glyph.kind === 'form') {
        const spec = FORMS[glyph.id];
        lines.push(`${formClause(probe(glyph.id))}.`);
        if (spec.roll === 'attack') lines.push(`Attack roll +${stats.proficiency + stats.castingMod}.`);
        if (spec.roll === 'save') lines.push(`Targets make a saving throw, DC ${saveDc(stats)}.`);
    } else if (glyph.kind === 'effect') {
        const effect = { id: glyph.id, augments: [] };
        const base: GlyphAbility = { ...probe('touch'), effects: [effect] };
        lines.push(`${capitalise(effectClause(base, effect, stats, 'none'))}.`);
        const save = EFFECTS[glyph.id].save;
        if (save) lines.push(`${save} save, DC ${saveDc(stats)}, when delivered by an area form.`);
    } else {
        lines.push(...augmentLines(glyph.id, stats));
    }
    lines.push(`${glyphCost(glyph)} MP.`);
    return lines;
}
