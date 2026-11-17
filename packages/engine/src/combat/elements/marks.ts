import type { ElementId, FormId, TileMarkId } from '../types';
import { SOAKED } from './tables';

export const TILE_MARK_IDS: readonly TileMarkId[] = ['flames', 'rubble', 'slick', 'sticky', 'molten', 'dim'];

export type MarkHarm = { amount: number; element: ElementId };

export type MarkRow = {
    rounds: number;
    extraCost: number;
    harm?: MarkHarm;
    slide?: number;
    coverBonus?: number;
    avoid: number;
    word: string;
    label: string;
};

export const TILE_MARKS: Readonly<Record<TileMarkId, MarkRow>> = {
    flames: { rounds: 3, extraCost: 0, harm: { amount: 1, element: 'fire' }, avoid: 10, word: 'flames', label: 'Flames' },
    rubble: { rounds: 4, extraCost: 1, avoid: 0, word: 'rubble', label: 'Rubble' },
    slick: { rounds: 3, extraCost: 0, slide: 1, avoid: 3, word: 'slick ground', label: 'Slick' },
    sticky: { rounds: 3, extraCost: 2, avoid: 0, word: 'sticky ground', label: 'Sticky' },
    molten: { rounds: 3, extraCost: 1, harm: { amount: 2, element: 'lava' }, avoid: 10, word: 'molten ground', label: 'Molten' },
    dim: { rounds: 3, extraCost: 0, coverBonus: 2, avoid: 0, word: 'deep shadow', label: 'Dim' },
};

export const MARK_FORMS: readonly FormId[] = ['line', 'cone', 'burst'];

export const MARK_EVENT_TYPES: readonly string[] = ['mark_harm', 'reaction'];

export type ReactionEffect =
    | { kind: 'clear' }
    | { kind: 'become'; mark: TileMarkId }
    | { kind: 'extend'; condition: string; tag?: ElementId; turns: number }
    | { kind: 'arc_all' };

export type ReactionTrigger = { mark: TileMarkId } | { condition: string };

export type ReactionRow = {
    id: string;
    element: ElementId;
    on: ReactionTrigger;
    effect: ReactionEffect;
    word: string;
};

export const REACTIONS: readonly ReactionRow[] = [
    { id: 'douse', element: 'water', on: { mark: 'flames' }, effect: { kind: 'clear' }, word: 'The water douses the flames.' },
    { id: 'cool', element: 'water', on: { mark: 'molten' }, effect: { kind: 'become', mark: 'rubble' }, word: 'The water cools the molten ground to rubble.' },
    { id: 'melt', element: 'fire', on: { mark: 'slick' }, effect: { kind: 'clear' }, word: 'The heat melts the slick ground away.' },
    { id: 'burn_away', element: 'fire', on: { mark: 'sticky' }, effect: { kind: 'clear' }, word: 'The fire burns the sticky ground away.' },
    { id: 'brighten', element: 'light', on: { mark: 'dim' }, effect: { kind: 'clear' }, word: 'The light drives the shadow back.' },
    { id: 'freeze', element: 'ice', on: { condition: SOAKED }, effect: { kind: 'extend', condition: 'slowed', tag: 'ice', turns: 1 }, word: 'The cold bites deeper into the soaked.' },
    { id: 'conduct', element: 'lightning', on: { condition: SOAKED }, effect: { kind: 'arc_all' }, word: 'The soaked conduct the lightning.' },
];

export function markRow(mark: TileMarkId | undefined): MarkRow | undefined {
    return mark ? TILE_MARKS[mark] : undefined;
}

export function tileReactions(element: ElementId): ReactionRow[] {
    return REACTIONS.filter(r => r.element === element && 'mark' in r.on);
}

export function conditionReactions(element: ElementId): ReactionRow[] {
    return REACTIONS.filter(r => r.element === element && 'condition' in r.on);
}
