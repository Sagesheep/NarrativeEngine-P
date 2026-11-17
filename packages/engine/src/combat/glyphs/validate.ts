import type { AttackRange, AugmentId, Combatant, EffectId, ElementPresetId, FormId, GlyphAbility } from '../types';
import { abilityDamageType, abilityElement, checkElement, describeElement, elementCost, isElementId } from '../elements/rules';
import { abilityRoll, builtinStats, isBuiltinId, leapRange, strengthMod, throwProfile, weaponReach } from './builtins';
import { throwRangeOf } from './throw';
import {
    AUGMENT_COSTS, AUGMENT_IDS, DAMPENED_COST_FLOOR, DELAY_REFUSED_EFFECTS, EFFECT_IDS, EFFECTS, FORM_IDS, FORMS, GLYPH_NUMBERS as N,
    SINGLE_TARGET_FORMS, TELEPORT_EFFECTS,
} from './registry';
import {
    barrierRounds, blinkRange, burstRadius, burstRange, chainJumps, chainRange, coneLength, count, damageDice, dashLength, decayDice, drainDice,
    fearTurns, gravitySquares, hasteTurns, healDice, isDelayed, isQuickened, leapGlyphRange, lineLength, lineWidth, mantleRadius, mantleRounds,
    projectileRange, pushDistance, saveDc, shieldAmount, shieldTurns, sigilRange, sigilRounds, slowTurns, snareTurns, splitCount, stunTurns,
    summonRounds, summonTier, wallLength, wallRange, wallRounds,
} from './numbers';
import type { CasterStats } from './numbers';

export type AbilityLimits = { maxChainLength: number; maxSummons?: number; elementPreset?: ElementPresetId };

export const DEFAULT_ABILITY_LIMITS: Readonly<AbilityLimits> = { maxChainLength: 6, maxSummons: 2 };

export function cleanAbilityName(raw: unknown): string {
    return typeof raw === 'string' ? raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, N.nameMax) : '';
}

export function glyphCount(ability: GlyphAbility): number {
    return (ability.element ? 1 : 0) + 1 + ability.form.augments.length + ability.effects.reduce((sum, e) => sum + 1 + e.augments.length, 0);
}

export function abilityCost(ability: GlyphAbility): number {
    if (ability.builtin) return 0;
    const element = elementCost(abilityElement(ability));
    const form = FORMS[ability.form.id]?.cost ?? 0;
    const formAug = ability.form.augments.reduce((sum, a) => sum + (AUGMENT_COSTS[a] ?? 0), 0);
    const effects = ability.effects.reduce(
        (sum, e) => sum + (EFFECTS[e.id]?.cost ?? 0) + e.augments.reduce((s, a) => s + (AUGMENT_COSTS[a] ?? 0), 0),
        0,
    );
    return dampenedCost(form + formAug + effects + element, ability.effects);
}

export function dampenedCost(total: number, effects: readonly { augments: readonly AugmentId[] }[]): number {
    return effects.some(e => e.augments.includes('dampen')) ? Math.max(DAMPENED_COST_FLOOR, total) : total;
}

function chainRules(formId: FormId, formAugments: readonly AugmentId[], effects: readonly { id: EffectId; augments: readonly AugmentId[] }[]): string[] {
    const reasons: string[] = [];
    const ids = effects.map(e => e.id);
    if (count(formAugments, 'delay') > 0) {
        for (const id of ids) if (DELAY_REFUSED_EFFECTS.has(id)) reasons.push(`delay cannot hold ${id}`);
    }
    for (const e of effects) {
        if (count(e.augments, 'dampen') > 0 && count(e.augments, 'amplify') > 0) reasons.push(`the ${e.id} effect cannot be both amplified and dampened`);
    }
    if (ids.filter(id => TELEPORT_EFFECTS.has(id)).length > 1) reasons.push('an ability may hold only one of blink and leap');
    if (FORMS[formId]?.placed) {
        const hostile = ids.some(id => EFFECTS[id]?.hostile);
        const helpful = ids.some(id => EFFECTS[id]?.helpful);
        if (hostile && helpful) reasons.push(`a ${formId} carries either hostile or helpful effects, not both`);
    }
    return reasons;
}

function checkAugments(label: string, augments: readonly AugmentId[], allowed: readonly AugmentId[], reasons: string[]): void {
    for (const a of augments) {
        if (!(AUGMENT_IDS as readonly string[]).includes(a)) reasons.push(`${label}: unknown augment "${String(a)}"`);
        else if (!allowed.includes(a)) reasons.push(`${label} does not accept ${a}`);
    }
    for (const a of new Set(augments)) {
        if (count(augments, a) > N.maxSameAugment) reasons.push(`${label} has ${a} more than ${N.maxSameAugment} times`);
    }
}

export function validateAbility(ability: GlyphAbility, limits: AbilityLimits = DEFAULT_ABILITY_LIMITS): string[] {
    const reasons: string[] = [];
    if (!ability || typeof ability !== 'object') return ['the ability is not an object'];
    if (ability.builtin !== undefined || isBuiltinId(ability.id)) reasons.push('built-in actions cannot be built, changed or stored');
    if (!cleanAbilityName(ability.name)) reasons.push('the ability needs a name');
    if (ability.element !== undefined) {
        const checked = checkElement(limits.elementPreset, ability.element);
        if (!checked.ok) {
            reasons.push(checked.reason === 'unknown'
                ? `unknown element "${String(ability.element)}"`
                : `the ${String(ability.element)} element is not available in this setting`);
        }
    }
    const formId = ability.form?.id as FormId;
    const form = FORMS[formId];
    if (!form) {
        reasons.push('the ability needs exactly one form');
        return reasons;
    }
    const formAugments = Array.isArray(ability.form.augments) ? ability.form.augments : [];
    checkAugments(`the ${formId} form`, formAugments, form.augments, reasons);
    const effects = Array.isArray(ability.effects) ? ability.effects : [];
    if (effects.length < 1) reasons.push('the ability needs at least one effect');
    if (effects.length > N.maxEffects) reasons.push(`the ability may have at most ${N.maxEffects} effects`);
    const ids = effects.map(e => e?.id as EffectId);
    for (const e of effects) {
        const spec = EFFECTS[e?.id as EffectId];
        if (!spec) {
            reasons.push(`unknown effect "${String(e?.id)}"`);
            continue;
        }
        if (spec.builtin) {
            reasons.push(`the ${e.id} glyph is reserved for built-in actions`);
            continue;
        }
        if (!form.effects.includes(e.id)) reasons.push(`the ${formId} form cannot carry ${e.id}`);
        checkAugments(`the ${e.id} effect`, Array.isArray(e.augments) ? e.augments : [], spec.augments, reasons);
    }
    if (ids.some(id => id === 'barrier' || id === 'summon') && effects.length > 1) {
        reasons.push('barrier and summon must be the only effect in an ability');
    }
    if (ids.includes('swap') && (count(formAugments, 'split') > 0 || count(formAugments, 'pierce') > 0)) {
        reasons.push('swap cannot be combined with split or pierce');
    }
    if (ids.includes('swap') && !SINGLE_TARGET_FORMS.has(formId)) reasons.push('swap needs a single-target form');
    if (ids.includes('barrier') && count(formAugments, 'widen') > 0) reasons.push('barrier cannot be widened');
    if (ids.includes('summon') && (limits.maxSummons ?? 1) <= 0) reasons.push('summons are switched off in the combat settings');
    if (new Set(ids).size !== ids.length) reasons.push('each effect may appear only once');
    reasons.push(...chainRules(formId, formAugments, effects.filter(e => !!EFFECTS[e?.id as EffectId]).map(e => ({ id: e.id, augments: Array.isArray(e.augments) ? e.augments : [] }))));
    const glyphs = glyphCount({ ...ability, form: { id: formId, augments: formAugments }, effects });
    if (glyphs > limits.maxChainLength) reasons.push(`the ability has ${glyphs} glyphs; the limit is ${limits.maxChainLength}`);
    return reasons;
}

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

function signed(n: number): string {
    return n >= 0 ? `+${n}` : `${n}`;
}

function shotClause(reach: number): string {
    return `Projectile, one target within ${reach} squares in line of sight; cover applies, and a hostile beside the user gives disadvantage`;
}

function weaponClause(range: AttackRange): string {
    const reach = weaponReach(range);
    if (range === 'ranged') return shotClause(reach);
    if (range === 'reach') return `Touch, one target within ${reach} squares in line of sight`;
    return 'Touch, one target at 1 square';
}

export type Wielder = Pick<Combatant, 'attackBonus' | 'damage'> & Partial<Pick<Combatant, 'abilities' | 'proficiency' | 'tier'>>;

type Sturdy = Pick<Combatant, 'abilities' | 'proficiency' | 'tier'>;

function sturdy(w: Wielder | undefined): Sturdy | null {
    return w && w.abilities && w.tier ? { abilities: w.abilities, tier: w.tier, ...(w.proficiency !== undefined ? { proficiency: w.proficiency } : {}) } : null;
}

function ranges(w: Sturdy | null): { light: string; medium: string; heavy: string } {
    if (!w) return { light: '4 + STR modifier (at least 2)', medium: '2 + STR modifier (at least 2)', heavy: '1 + STR modifier (at least 1)' };
    return { light: `${throwRangeOf(w, 'light')}`, medium: `${throwRangeOf(w, 'medium')}`, heavy: `${throwRangeOf(w, 'heavy')}` };
}

function throwRules(ability: GlyphAbility, wielder?: Wielder): string {
    const s = sturdy(wielder);
    const r = ranges(s);
    const bonus = s ? signed(throwProfile(s).attackBonus) : 'using proficiency and STR';
    const mod = s ? signed(strengthMod(s)) : ' plus STR modifier';
    return [
        `${formClause(ability)}.`,
        `Hurl it as a projectile to a square in line of sight, within ${r.light} squares for something light, ${r.medium} for a cover object and ${r.heavy} for a creature; walls stop it.`,
        `A creature on the landing square is attacked: attack roll ${bonus}, cover applies. A hit deals 2d6${mod} for a creature, 1d8${mod} for a cover object, a carried weapon's own die${mod}, or 1d4 for whatever is at hand; doubled dice on a critical hit.`,
        'A creature thrown against its will makes a STR or DEX save (its better one) against DC 8 + proficiency + STR modifier first, and takes 1d6 on landing; only minions and grunts can be lifted, or any fallen creature but a boss. A willing ally takes no damage and cannot be thrown onto a hazard.',
        'A creature lands on the square, or on the nearest free one. A thrown cover object leaves open floor behind and difficult ground where it lands. A carried item lies where it lands until the party walks over it. No MP.',
    ].join(' ');
}

export function formClause(ability: GlyphAbility): string {
    const kind = ability.builtin?.kind;
    if (kind === 'throw') return 'Touch an adjacent creature or cover object, or take a carried item or whatever is at hand';
    if (kind === 'shove') return 'Touch, one hostile target at 1 square';
    if (kind === 'help') return 'Touch, one adjacent ally';
    if (ability.builtin?.kind === 'attack') return weaponClause(ability.builtin.range ?? 'close');
    const split = splitCount(ability);
    const extra = split > 0 ? `, plus ${plural(split, 'more target', 'more targets')} within ${N.splitRange} squares` : '';
    switch (ability.form.id) {
        case 'touch':
            return `Touch, one target or square at 1 square${extra}`;
        case 'projectile': {
            const pierce = count(ability.form.augments, 'pierce') > 0 ? ', passing through everyone on its path' : '';
            return `Projectile, one target or square within ${projectileRange(ability)} squares${pierce}${extra}`;
        }
        case 'self':
            return 'Self';
        case 'line': {
            const w = lineWidth(ability);
            return `Line, ${lineLength(ability)} squares${w > 1 ? `, ${w} wide` : ''}`;
        }
        case 'cone':
            return `Cone, ${coneLength(ability)} squares`;
        case 'burst': {
            const side = burstRadius(ability) * 2 + 1;
            return `Burst, ${side}×${side}, within ${burstRange(ability)} squares`;
        }
        case 'dash':
            return `Dash up to ${dashLength(ability)} squares to a target`;
        case 'sigil':
            return `Sigil on an empty square within ${sigilRange(ability)} squares for ${plural(sigilRounds(ability), 'round', 'rounds')}; it goes off on the first foe to enter it`;
        case 'mantle': {
            const side = mantleRadius(ability) * 2 + 1;
            return `Mantle, ${side}×${side} around the user for ${plural(mantleRounds(ability), 'round', 'rounds')}; it touches each foe (each friend, if it only helps) that starts a turn inside`;
        }
        case 'chain':
            return `Chain, one target within ${chainRange(ability)} squares, then up to ${plural(chainJumps(ability), 'jump', 'jumps')} to the nearest unit of the same side within ${N.chainJumpRange} squares, each at half the strength of the last`;
        case 'wall':
            return `Wall of ${wallLength(ability)} barrier squares across a point within ${wallRange(ability)} squares for ${plural(wallRounds(ability), 'round', 'rounds')}; it touches each foe that starts a turn beside it`;
        default:
            return '';
    }
}

function delayClause(ability: GlyphAbility): string {
    return isDelayed(ability) ? ` It goes off at the start of the user's next turn on whoever is then in the squares aimed at, with ${plural(N.delayBoost, 'more die', 'more dice')} of damage or healing.` : '';
}

export function effectClause(ability: GlyphAbility, effect: GlyphAbility['effects'][number], stats: CasterStats, roll: string, wielder?: Wielder): string {
    const a = effect.augments;
    const type = abilityDamageType(ability);
    const dc = saveDc(stats);
    const save = (key: string, what: string, success: string) => roll === 'save' ? `${key} save (DC ${dc}) or ${what}${success}` : what;
    switch (effect.id) {
        case 'damage':
            return roll === 'save' ? save('DEX', `take ${damageDice(stats, a)}d6 ${type} damage`, ', half on a save') : `takes ${damageDice(stats, a)}d6 ${type} damage`;
        case 'drain':
            return (roll === 'save' ? save('DEX', `take ${drainDice(stats, a)}d6 ${type} damage`, ', half on a save') : `takes ${drainDice(stats, a)}d6 ${type} damage`) + '; the user heals half the damage dealt';
        case 'heal':
            return `restores ${healDice(stats, a)}d4${stats.castingMod >= 0 ? '+' : ''}${stats.castingMod} HP`;
        case 'shield':
            return `gains ${shieldAmount(stats, a)} temporary HP for ${shieldTurns(a)} of its turns`;
        case 'push': {
            if (ability.builtin?.kind === 'shove') {
                const s = sturdy(wielder);
                const against = s ? `DC ${saveDc(builtinStats(s))}` : 'DC 8 + proficiency + STR modifier';
                return `makes a STR or DEX save (its better one) against ${against} or is pushed ${plural(pushDistance(a), 'square', 'squares')} straight away, hurt by any hazard it passes over; bosses cannot be shoved`;
            }
            return save('DEX', `is pushed ${plural(pushDistance(a), 'square', 'squares')} away`, '');
        }
        case 'pull':
            return save('DEX', `is pulled ${plural(pushDistance(a), 'square', 'squares')} closer`, '');
        case 'stun':
            return save('CON', stunTurns(a) === 1 ? 'loses its next turn' : `loses its next ${stunTurns(a)} turns`, ' (bosses are slowed instead)');
        case 'slow':
            return save('CON', `is slowed for ${slowTurns(a)} of its turns`, '');
        case 'haste':
            return `is hasted for ${hasteTurns(a)} of its turns`;
        case 'blink':
            return `the user teleports to an empty square it can see within ${blinkRange(a)}`;
        case 'swap':
            return save('WIS', 'the user and the target swap places', '');
        case 'barrier':
            return `empty squares become barriers for ${barrierRounds(a)} rounds`;
        case 'summon':
            return `summons a ${summonTier(a)} ally for ${summonRounds(a)} rounds`;
        case 'sprint':
            return 'gains one more full allowance of movement this turn';
        case 'leap': {
            if (ability.builtin?.kind !== 'jump') return `the user leaps to an empty square within ${leapGlyphRange(a)}, over anything in between`;
            const s = sturdy(wielder);
            const within = s ? `${leapRange(s)} squares` : '2 + its STR modifier squares (at least 2)';
            return `leaps to an empty square it can see within ${within}, spending that much movement and ignoring difficult ground, hazards and low cover on the way`;
        }
        case 'rally':
            return 'ends Stunned and Slowed on an adjacent ally, or stands a downed ally up with 1 HP';
        case 'weapon': {
            if (!wielder) return 'takes weapon damage';
            const d = wielder.damage;
            return `takes ${d.count}d${d.sides}${d.bonus !== 0 ? signed(d.bonus) : ''} ${d.type} damage, doubled dice on a critical hit`;
        }
        case 'guard':
            return 'takes a defensive stance; attacks against it have disadvantage until its next turn';
        case 'snare':
            return save('STR', `cannot move for ${plural(snareTurns(a), 'turn', 'turns')} of its own (it can still act)`, '');
        case 'dispel':
            return 'loses its harmful conditions if it is a friend, or (WIS save for an area) its helpful ones if it is a foe';
        case 'gravity':
            return save('STR', `is dragged up to ${plural(gravitySquares(a), 'square', 'squares')} toward the centre`, '');
        case 'fear':
            return save('WIS', `must move away from the user on its next ${fearTurns(a) === 1 ? 'turn' : `${fearTurns(a)} turns`} and may not come closer`, '');
        case 'decay':
            return save('CON', `loses ${decayDice(stats, a)}d${N.decaySides} maximum HP and HP for the rest of the fight (never below half its maximum)`, '');
        case 'vanish':
            return 'cannot be targeted until the start of its next turn (areas still reach it)';
        case 'rewind':
            return 'returns to its square, HP and conditions at the start of its last turn';
        default:
            return '';
    }
}

export function describeAbility(ability: GlyphAbility, caster: CasterStats = { proficiency: 2, castingMod: 0 }, wielder?: Wielder): string {
    const form = FORMS[ability.form?.id];
    if (!form) return '';
    if (ability.builtin?.kind === 'throw') return throwRules(ability, wielder);
    const parts: string[] = [formClause(ability) + (isQuickened(ability) || ability.builtin?.slot === 'bonus' ? ', bonus action' : '') + '.'];
    const roll = abilityRoll(ability);
    const clauses = ability.effects.filter(e => EFFECTS[e.id]).map(e => effectClause(ability, e, caster, roll, wielder));
    if (clauses.length > 0) {
        const bonus = ability.builtin
            ? (wielder ? signed(wielder.attackBonus) : 'with the weapon')
            : `+${caster.proficiency + caster.castingMod}`;
        const lead = roll === 'attack'
            ? `Attack roll ${bonus}; on a hit the target `
            : ability.form.id === 'self' ? 'The user ' : ability.builtin ? 'The target ' : 'Targets ';
        const body = clauses.join('; then ');
        parts.push(`${lead}${body}.${delayClause(ability)}`);
    }
    const element = abilityElement(ability);
    if (element) parts.push(describeElement(element));
    parts.push(ability.builtin ? 'No MP.' : `${abilityCost(ability)} MP.`);
    return parts.join(' ');
}

export function isGlyphAbilityShape(raw: unknown): raw is GlyphAbility {
    if (!raw || typeof raw !== 'object') return false;
    const r = raw as Record<string, unknown>;
    const form = r.form as Record<string, unknown> | undefined;
    if (typeof r.id !== 'string' || typeof r.name !== 'string') return false;
    if (!form || !(FORM_IDS as readonly unknown[]).includes(form.id) || !Array.isArray(form.augments)) return false;
    if (!form.augments.every(a => (AUGMENT_IDS as readonly unknown[]).includes(a))) return false;
    if (!Array.isArray(r.effects)) return false;
    if (r.element !== undefined && !isElementId(r.element)) return false;
    return r.effects.every(e => {
        const eff = e as Record<string, unknown> | null;
        return !!eff && (EFFECT_IDS as readonly unknown[]).includes(eff.id) && Array.isArray(eff.augments)
            && eff.augments.every(a => (AUGMENT_IDS as readonly unknown[]).includes(a));
    });
}
