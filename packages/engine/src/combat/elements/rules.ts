import type { Combatant, ElementId, ElementPresetId, GlyphAbility } from '../types';
import { GLYPH_NUMBERS } from '../glyphs/registry';
import {
    BLINDED, DEFAULT_ELEMENT_PRESET, REVEALED, ELEMENT_IDS, ELEMENT_NUMBERS, ELEMENT_PRESETS, ELEMENT_PRESET_IDS, ELEMENT_WORDS, ELEMENTS, MINDLESS_KINDS, SOAKED,
    SOAKED_WEAK_TO,
} from './tables';

export type ElementFactor = { factor: number; weak: boolean; resist: boolean; immune: boolean };

export type ElementDropReason = 'unknown' | 'outside_preset';

export type ElementFilter = { kept: ElementId[]; dropped: Array<{ value: string; reason: ElementDropReason }> };

export function isElementId(raw: unknown): raw is ElementId {
    return typeof raw === 'string' && (ELEMENT_IDS as readonly string[]).includes(raw);
}

export function elementOfWord(raw: unknown): ElementId | null {
    if (typeof raw !== 'string') return null;
    const word = raw.trim().toLowerCase();
    if (!word) return null;
    return isElementId(word) ? word : ELEMENT_WORDS[word] ?? null;
}

export function normalizePreset(raw: unknown): ElementPresetId {
    const word = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return (ELEMENT_PRESET_IDS as readonly string[]).includes(word) ? word as ElementPresetId : DEFAULT_ELEMENT_PRESET;
}

export function elementsFor(preset?: ElementPresetId | string | null): readonly ElementId[] {
    return ELEMENT_PRESETS[normalizePreset(preset)];
}

export function inPreset(preset: ElementPresetId | string | null | undefined, element: ElementId): boolean {
    return elementsFor(preset).includes(element);
}

export function checkElement(preset: ElementPresetId | string | null | undefined, raw: unknown): { ok: true; element: ElementId } | { ok: false; reason: ElementDropReason } {
    const element = elementOfWord(raw);
    if (!element) return { ok: false, reason: 'unknown' };
    return inPreset(preset, element) ? { ok: true, element } : { ok: false, reason: 'outside_preset' };
}

export function filterElements(preset: ElementPresetId | string | null | undefined, raw: unknown): ElementFilter {
    const kept: ElementId[] = [];
    const dropped: ElementFilter['dropped'] = [];
    const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;]/) : [];
    for (const item of list) {
        const value = typeof item === 'string' ? item.trim() : '';
        if (!value) continue;
        const checked = checkElement(preset, value);
        if (!checked.ok) dropped.push({ value, reason: checked.reason });
        else if (!kept.includes(checked.element)) kept.push(checked.element);
    }
    return { kept, dropped };
}

export function abilityElement(ability: Pick<GlyphAbility, 'element'>): ElementId | undefined {
    return isElementId(ability.element) ? ability.element : undefined;
}

export function abilityDamageType(ability: Pick<GlyphAbility, 'element' | 'damageType'>, fallback: string = GLYPH_NUMBERS.defaultDamageType): string {
    return abilityElement(ability) ?? (ability.damageType?.trim() || fallback);
}

export function stripElement(ability: GlyphAbility): GlyphAbility {
    if (ability.element === undefined) return ability;
    const copy: GlyphAbility = { ...ability };
    delete copy.element;
    return copy;
}

export function setElement(ability: GlyphAbility, element: ElementId | null | undefined): GlyphAbility {
    const base = stripElement(ability);
    return element ? { ...base, element } : base;
}

export function elementCost(element: ElementId | undefined): number {
    return element ? ELEMENTS[element]?.cost ?? 0 : 0;
}

function mapWords(words: readonly string[] | undefined): ElementId[] {
    const out: ElementId[] = [];
    for (const word of words ?? []) {
        const element = elementOfWord(word);
        if (element && !out.includes(element)) out.push(element);
    }
    return out;
}

export function isSoaked(c: Pick<Combatant, 'conditions'>): boolean {
    return c.conditions.some(x => x.id === SOAKED);
}

export function weakSet(c: Pick<Combatant, 'weak' | 'weaknesses' | 'conditions'>): Set<ElementId> {
    const out = new Set<ElementId>([...(c.weak ?? []), ...mapWords(c.weaknesses)]);
    if (isSoaked(c)) for (const e of SOAKED_WEAK_TO) out.add(e);
    return out;
}

export function resistSet(c: Pick<Combatant, 'resist' | 'resistances'>): Set<ElementId> {
    return new Set<ElementId>([...(c.resist ?? []), ...mapWords(c.resistances)]);
}

export function isMindless(c: Pick<Combatant, 'mindless' | 'species'>): boolean {
    if (typeof c.mindless === 'boolean') return c.mindless;
    const tokens = (c.species ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
    return tokens.some(t => MINDLESS_KINDS.has(t) || (t.endsWith('s') && MINDLESS_KINDS.has(t.slice(0, -1))));
}

export function isImmune(c: Pick<Combatant, 'immune' | 'mindless' | 'species'>, element: ElementId): boolean {
    const row = ELEMENTS[element];
    if (row.neutral) return false;
    if ((c.immune ?? []).includes(element)) return true;
    return row.mindlessImmune === true && isMindless(c);
}

export function elementMultiplier(
    target: Pick<Combatant, 'weak' | 'resist' | 'immune' | 'weaknesses' | 'resistances' | 'conditions' | 'mindless' | 'species'>,
    element: ElementId,
): ElementFactor {
    if (ELEMENTS[element].neutral) return { factor: 1, weak: false, resist: false, immune: false };
    if (isImmune(target, element)) return { factor: 0, weak: false, resist: false, immune: true };
    const weak = weakSet(target).has(element);
    const resist = resistSet(target).has(element);
    if (weak && !resist) return { factor: ELEMENT_NUMBERS.weakFactor, weak, resist, immune: false };
    if (resist && !weak) return { factor: ELEMENT_NUMBERS.resistFactor, weak, resist, immune: false };
    return { factor: 1, weak: false, resist: false, immune: false };
}

export function blindPenalty(c: Pick<Combatant, 'conditions'>): number {
    return c.conditions.some(x => x.id === BLINDED) ? ELEMENT_NUMBERS.blindPenalty : 0;
}

export function revealedCover(target: Pick<Combatant, 'conditions'>, cover: number): number {
    return cover > 0 && target.conditions.some(x => x.id === REVEALED) ? Math.floor(cover * ELEMENT_NUMBERS.coverShare) : cover;
}

export function scaleDamage(amount: number, factor: number): number {
    return Math.floor(amount * factor);
}

export function describeElement(element: ElementId): string {
    const n = ELEMENT_NUMBERS;
    switch (element) {
        case 'fire':
            return `Fire damage; the target burns for ${n.burnTurns} turns, taking ${n.burnDamage} damage at the start of each of them.`;
        case 'water':
            return `Water damage; the target is soaked for ${n.soakedTurns} turns (weak to lightning and ice) and pushed ${n.shoveSquares} square.`;
        case 'earth':
            return `Earth damage; the target is staggered and loses ${n.staggerLoss} squares of movement on its next turn.`;
        case 'kinetic':
            return `Kinetic damage; the target is pushed ${n.kineticSquares} more square, taking 1d${n.impactDie} extra if a wall or unit blocks it.`;
        case 'lightning':
            return 'Lightning damage; it arcs to one adjacent foe of the target for half damage.';
        case 'ice':
            return `Ice damage; the target is chilled (slowed) for ${n.chillTurns} turn.`;
        case 'steel':
            return `Steel damage; attack rolls ignore ${ELEMENTS.steel.ignoresArmour ?? 0} points of armour.`;
        case 'light':
            return `Light damage; the target is revealed for ${n.revealTurns} turns, so cover counts for half against it.`;
        case 'darkness':
            return `Darkness damage; the target is blinded for ${n.blindTurns} turns (-${n.blindPenalty} to hit).`;
        case 'slime':
            return `Slime damage; the target is slowed for ${n.stickyTurns} turn and its next damaging action deals ${n.coatPenalty} less.`;
        case 'mental':
            return 'Mental damage; resolved against a WIS save, ignoring armour and cover; the target is dazed and loses its bonus action on its next turn.';
        case 'lava':
            return 'Lava damage; the target burns and is staggered.';
        case 'madness':
            return 'Madness damage; the target is confused and its next action goes against the nearest unit.';
        case 'almighty':
            return 'Almighty damage; nothing resists it and nothing is weak to it.';
        default:
            return '';
    }
}
