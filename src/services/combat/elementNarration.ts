import { ELEMENT_IDS, TILE_MARKS, TILE_MARK_IDS } from '@narrative/engine';
import type { ElementId, TileMarkId } from '@narrative/engine';
import type { CombatEvent } from '../../types';

type NameOf = (id?: string) => string;

export const ELEMENT_IMAGERY: Readonly<Record<ElementId, string>> = {
    fire: 'flame and heat',
    water: 'water and spray',
    earth: 'stone and earth',
    kinetic: 'raw force',
    lightning: 'lightning and thunder',
    ice: 'frost and cold',
    steel: 'blades and metal',
    light: 'blinding light',
    darkness: 'shadow and darkness',
    slime: 'clinging slime',
    mental: 'a crushing pressure on the mind',
    lava: 'molten rock',
    madness: 'madness clawing at the mind',
    almighty: 'pure, unstoppable power',
};

export const ELEMENT_CONDITION_WORDS: Readonly<Record<string, string>> = {
    burning: 'burning',
    soaked: 'soaked',
    staggered: 'staggered',
    revealed: 'exposed',
    blinded: 'blinded',
    coated: 'coated in slime',
    dazed: 'dazed',
    confused: 'confused',
    snared: 'held fast',
    feared: 'afraid',
    vanished: 'hidden from sight',
};

export function eventElement(event: CombatEvent): ElementId | null {
    const raw = event.data.element;
    return typeof raw === 'string' && (ELEMENT_IDS as readonly string[]).includes(raw) ? raw as ElementId : null;
}

function markOf(raw: unknown): TileMarkId | null {
    return typeof raw === 'string' && (TILE_MARK_IDS as readonly string[]).includes(raw) ? raw as TileMarkId : null;
}

function abilityOf(event: CombatEvent, fallback: string): string {
    const raw = event.data.ability;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
}

const RIDER_LINES: Readonly<Record<string, (target: string) => string>> = {
    burning: target => `${target} catches fire.`,
    soaked: target => `${target} is soaked through.`,
    staggered: target => `${target} staggers, thrown off balance.`,
    chilled: target => `${target} is chilled, the cold slowing every step.`,
    revealed: target => `${target} is lit up, with nowhere left to hide.`,
    blinded: target => `${target} is blinded by the dark.`,
    sticky: target => `${target} is stuck fast in the slime.`,
    coated: target => `${target} is coated in slime, every blow made clumsy.`,
    dazed: target => `${target} reels, dazed.`,
    confused: target => `${target}'s mind clouds over with confusion.`,
};

function placedLine(event: CombatEvent, name: NameOf): string {
    const actor = name(event.actorId);
    const ability = abilityOf(event, 'the spell');
    switch (event.data.kind) {
        case 'sigil':
            return `${actor} lays a sigil on the ground.`;
        case 'mantle':
            return `${actor} wraps themselves in ${ability}.`;
        case 'wall':
            return `${actor} raises a wall.`;
        case 'delay':
            return `${actor} readies ${ability}; it will go off at the start of their next turn.`;
        case 'mark': {
            if (event.data.continued === true) return '';
            const mark = markOf(event.data.mark);
            return mark ? `${capitalise(TILE_MARKS[mark].word)} spread across the ground.` : '';
        }
        default:
            return '';
    }
}

function capitalise(text: string): string {
    return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

function triggeredLine(event: CombatEvent, name: NameOf): string {
    const ability = abilityOf(event, 'The spell');
    const target = name(event.targetId);
    switch (event.data.kind) {
        case 'sigil':
            return `A sigil flares under ${target}.`;
        case 'mantle':
            return `${ability} lashes ${target}.`;
        case 'wall':
            return `The wall lashes ${target}.`;
        case 'delay':
            return event.data.missed === true ? `${ability} goes off, but no one is there.` : `${ability} goes off.`;
        default:
            return '';
    }
}

function endedLine(event: CombatEvent): string {
    if (event.data.why !== 'expired') return '';
    switch (event.data.kind) {
        case 'sigil':
            return 'A sigil fades from the ground.';
        case 'mantle':
            return 'A mantle fades.';
        case 'wall':
            return 'A wall crumbles away.';
        case 'mark': {
            const placed = event.data.placed as { mark?: unknown } | undefined;
            const mark = markOf(placed?.mark);
            return mark ? `The ground is clear of ${TILE_MARKS[mark].word} again.` : '';
        }
        default:
            return '';
    }
}

function reactionLine(event: CombatEvent, name: NameOf): string {
    const target = name(event.targetId);
    switch (event.data.reaction) {
        case 'douse':
            return 'The water douses the flames.';
        case 'cool':
            return 'The water cools the molten ground to rubble.';
        case 'melt':
            return 'The heat melts the slick ground away.';
        case 'burn_away':
            return 'The fire burns the sticky ground away.';
        case 'brighten':
            return 'The light drives the shadow back.';
        case 'freeze':
            return `The cold bites deeper into the soaked ${target}.`;
        case 'conduct':
            return `The lightning runs through the soaked ${target} to everyone beside them.`;
        default:
            return '';
    }
}

export function elementDamageLine(event: CombatEvent, name: NameOf, how: string): string | null {
    const element = eventElement(event);
    const target = name(event.targetId);
    if (event.data.immune === true) return `${target} is untouched by the ${element ?? (typeof event.data.damageType === 'string' ? event.data.damageType : 'blast')}.`;
    if (event.data.arc === true) return `The lightning arcs on to ${target}.`;
    if (event.data.impact === true) return `${target} slams into what stands behind them.`;
    if (!element) return null;
    const extra = event.data.weakness === true ? ', which it is weak to' : event.data.resisted === true ? ', which it resists' : '';
    return `${target} ${how} ${element}${extra}.`;
}

export function elementPushLine(event: CombatEvent, name: NameOf): string | null {
    const target = name(event.targetId);
    if (event.data.kind === 'slide') return `${target} slides across the slick ground.`;
    if (event.data.gravity === true) return Number(event.data.squares) > 0 ? `${target} is dragged toward the centre.` : `${target} holds against the pull.`;
    if (event.data.rider === true) {
        const element = eventElement(event);
        return Number(event.data.squares) > 0 ? `${target} is knocked back by the ${element ?? 'blow'}.` : `${target} braces against the ${element ?? 'blow'} and holds.`;
    }
    return null;
}

export function elementNarrationLine(event: CombatEvent, name: NameOf): string | null {
    switch (event.type) {
        case 'element_rider': {
            const rider = typeof event.data.rider === 'string' ? RIDER_LINES[event.data.rider] : undefined;
            return rider ? rider(name(event.targetId)) : '';
        }
        case 'burn':
            return `${name(event.targetId)} burns.`;
        case 'confused':
            return `${name(event.actorId)} is confused and turns on ${name(event.targetId)}.`;
        case 'placed':
            return placedLine(event, name);
        case 'placed_triggered':
            return triggeredLine(event, name);
        case 'placed_ended':
            return endedLine(event);
        case 'dispelled':
            return event.data.friend === true
                ? `${name(event.targetId)} is freed of what afflicted them.`
                : `${name(event.targetId)}'s protections are stripped away.`;
        case 'decayed':
            return `${name(event.targetId)} withers, and the loss will not heal.`;
        case 'rewound':
            return `${name(event.actorId)} slips back to where they stood a moment ago.`;
        case 'gravity':
            return `${abilityOf(event, 'The spell')} drags everything toward a single point.`;
        case 'mark_harm': {
            const mark = markOf(event.data.mark);
            const word = mark ? TILE_MARKS[mark].word : 'ground';
            return event.data.immune === true ? `${name(event.targetId)} passes through the ${word} unharmed.` : `${name(event.targetId)} is burned by the ${word}.`;
        }
        case 'reaction':
            return reactionLine(event, name);
        default:
            return null;
    }
}

export function elementsInEvents(events: readonly CombatEvent[]): ElementId[] {
    const out: ElementId[] = [];
    for (const e of events) {
        const element = eventElement(e);
        if (element && !out.includes(element)) out.push(element);
    }
    return out;
}

export function elementStakes(elements: readonly ElementId[]): string {
    if (elements.length === 0) return '';
    return `Elements: ${elements.map(e => `${e} (${ELEMENT_IMAGERY[e]})`).join(', ')}. Describe these abilities and what they leave behind in those terms, and keep each element as named.`;
}
