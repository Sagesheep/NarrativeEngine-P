import { ELEMENT_IDS, TILE_MARK_IDS } from '@narrative/engine';
import type { ElementId, PlacedKind, TileMarkId } from '@narrative/engine';
import type { TranslateKey, TranslateVars } from '../../i18n';

type T = (key: TranslateKey, vars?: TranslateVars) => string;

export const ELEMENT_COLORS: Readonly<Record<ElementId, string>> = {
    fire: '#f97316',
    water: '#3b82f6',
    earth: '#a16207',
    kinetic: '#94a3b8',
    lightning: '#facc15',
    ice: '#67e8f9',
    steel: '#cbd5e1',
    light: '#fde68a',
    darkness: '#7c3aed',
    slime: '#84cc16',
    mental: '#ec4899',
    lava: '#dc2626',
    madness: '#c026d3',
    almighty: '#e7e5e4',
};

export const MARK_COLORS: Readonly<Record<TileMarkId, string>> = {
    flames: ELEMENT_COLORS.fire,
    rubble: ELEMENT_COLORS.earth,
    slick: ELEMENT_COLORS.ice,
    sticky: ELEMENT_COLORS.slime,
    molten: ELEMENT_COLORS.lava,
    dim: ELEMENT_COLORS.darkness,
};

export const NEUTRAL_PLACED_COLOR = 'var(--combat-path)';

export function isElement(raw: unknown): raw is ElementId {
    return typeof raw === 'string' && (ELEMENT_IDS as readonly string[]).includes(raw);
}

export function isMark(raw: unknown): raw is TileMarkId {
    return typeof raw === 'string' && (TILE_MARK_IDS as readonly string[]).includes(raw);
}

export function elementColor(raw: unknown): string | null {
    return isElement(raw) ? ELEMENT_COLORS[raw] : null;
}

export function elementName(element: ElementId, t: T): string {
    return t(`combat.element.${element}`);
}

export function elementDescription(element: ElementId, t: T): string {
    return t(`combat.element.${element}.desc`);
}

export function markName(mark: TileMarkId, t: T): string {
    return t(`combat.mark.${mark}`);
}

export type ElementRelation = 'none' | 'weak' | 'resist' | 'immune';

export const ELEMENT_RELATIONS: readonly ElementRelation[] = ['none', 'weak', 'resist', 'immune'];

type ElementLists = { weak?: ElementId[]; resist?: ElementId[]; immune?: ElementId[] };

export function relationOf(c: ElementLists, element: ElementId): ElementRelation {
    if (c.immune?.includes(element)) return 'immune';
    if (c.resist?.includes(element)) return 'resist';
    if (c.weak?.includes(element)) return 'weak';
    return 'none';
}

function without(list: readonly ElementId[] | undefined, element: ElementId): ElementId[] {
    return (list ?? []).filter(e => e !== element);
}

export function setRelation(c: ElementLists, element: ElementId, relation: ElementRelation): ElementLists {
    const weak = without(c.weak, element);
    const resist = without(c.resist, element);
    const immune = without(c.immune, element);
    if (relation === 'weak') weak.push(element);
    if (relation === 'resist') resist.push(element);
    if (relation === 'immune') immune.push(element);
    return {
        weak: weak.length > 0 ? weak : undefined,
        resist: resist.length > 0 ? resist : undefined,
        immune: immune.length > 0 ? immune : undefined,
    };
}

export function placedName(kind: Exclude<PlacedKind, 'mark'>, t: T): string {
    return t(`combat.placed.${kind}`);
}
