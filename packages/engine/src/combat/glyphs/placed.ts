import { emit } from '../core';
import type { Draft } from '../core';
import { distance, hasLineOfSight, sameTeam, samePos, terrainOf } from '../grid';
import type { CombatEvent, CombatState, Combatant, GlyphAbility, PlacedEffect, PlacedEndReason, Pos } from '../types';
import { EFFECTS, GLYPH_NUMBERS as N } from './registry';
import { TILE_MARKS } from '../elements/marks';

export const PLACED_KINDS: readonly PlacedEffect['kind'][] = ['sigil', 'mantle', 'wall', 'delay', 'mark'];

export const PLACED_WORDS: Readonly<Record<PlacedEffect['kind'], string>> = {
    sigil: 'sigil',
    mantle: 'mantle',
    wall: 'wall',
    delay: 'delayed spell',
    mark: 'mark',
};

export function placedOf(state: Pick<CombatState, 'placed'>): readonly PlacedEffect[] {
    return state.placed ?? [];
}

export function copyPlaced(p: PlacedEffect): PlacedEffect {
    return { ...p, tiles: p.tiles.map(t => ({ ...t })), ...(p.origin ? { origin: { ...p.origin } } : {}), ...(p.targetIds ? { targetIds: [...p.targetIds] } : {}) };
}

export function hostilePayload(payload: GlyphAbility | undefined): boolean {
    return !!payload && payload.effects.some(e => EFFECTS[e.id]?.hostile === true);
}

export function touchesUnit(placed: PlacedEffect, unit: Pick<Combatant, 'side' | 'id'>): boolean {
    const friend = sameTeam(placed.side, unit.side);
    return hostilePayload(placed.payload) ? !friend : friend;
}

export function sigilAt(state: Pick<CombatState, 'placed'>, p: Pos): PlacedEffect | undefined {
    return placedOf(state).find(e => e.kind === 'sigil' && e.tiles.some(t => samePos(t, p)));
}

export function sigilTriggersOn(state: Pick<CombatState, 'placed'>, p: Pos, unit: Pick<Combatant, 'side' | 'id'>): PlacedEffect | undefined {
    const found = sigilAt(state, p);
    return found && found.ownerId !== unit.id && !sameTeam(found.side, unit.side) ? found : undefined;
}

export function sigilVisibleTo(state: CombatState, placed: PlacedEffect, viewer: Combatant): boolean {
    if (sameTeam(placed.side, viewer.side)) return true;
    const terrain = terrainOf(state);
    const tile = placed.tiles[0];
    if (!terrain || !tile || !viewer.position) return false;
    return distance(viewer.position, tile) <= N.sigilSight && hasLineOfSight(terrain, viewer.position, tile);
}

export function seenSigils(state: CombatState, viewer: Combatant): PlacedEffect[] {
    return placedOf(state).filter(p => p.kind === 'sigil' && !sameTeam(p.side, viewer.side) && sigilVisibleTo(state, p, viewer));
}

export function mantleOf(state: Pick<CombatState, 'placed'>, ownerId: string): PlacedEffect | undefined {
    return placedOf(state).find(p => p.kind === 'mantle' && p.ownerId === ownerId);
}

export function placedCovers(state: CombatState, placed: PlacedEffect, p: Pos): boolean {
    if (placed.kind === 'mantle') {
        const owner = state.combatants[placed.ownerId];
        return !!owner?.position && owner.status === 'up' && distance(owner.position, p) <= (placed.radius ?? N.mantleRadius);
    }
    if (placed.kind === 'wall') {
        const raised = (state.barriers ?? []).filter(b => b.sourceId === placed.ownerId);
        return placed.tiles.some(t => distance(t, p) === 1 && raised.some(b => samePos(b.pos, t)));
    }
    return false;
}

export function zonesAgainst(state: CombatState, unit: Combatant): PlacedEffect[] {
    return placedOf(state).filter(p => (p.kind === 'mantle' || p.kind === 'wall') && hostilePayload(p.payload) && !sameTeam(p.side, unit.side));
}

export function nextPlacedId(state: CombatState): string {
    const n = (state.nextPlaced ?? 0) + 1;
    state.nextPlaced = n;
    return `placed${n}`;
}

function placedText(owner: string, p: PlacedEffect): string {
    switch (p.kind) {
        case 'mark': return `${owner} leaves ${p.mark ? TILE_MARKS[p.mark].word : 'a mark'} until round ${p.expiresRound}.`;
        case 'sigil': return `${owner} lays a sigil (${p.name}) until round ${p.expiresRound}.`;
        case 'mantle': return `${owner} wraps a mantle (${p.name}) around themselves until round ${p.expiresRound}.`;
        case 'wall': return `${owner} raises a wall (${p.name}) until round ${p.expiresRound}.`;
        default: return `${owner} readies ${p.name} to go off at the start of their next turn.`;
    }
}

export type AddPlacedOptions = { text?: string; data?: Record<string, unknown> };

export function addPlaced(draft: Draft, entry: Omit<PlacedEffect, 'id'>, options: AddPlacedOptions = {}): PlacedEffect {
    const s = draft.state;
    const placed: PlacedEffect = { id: nextPlacedId(s), ...entry };
    s.placed = [...placedOf(s), placed];
    const owner = s.combatants[placed.ownerId];
    emit(draft, {
        type: 'placed',
        actorId: placed.ownerId,
        data: {
            placed: copyPlaced(placed), kind: placed.kind, ability: placed.name, ...(placed.element ? { element: placed.element } : {}),
            ...(placed.mark ? { mark: placed.mark } : {}), ...(options.data ?? {}),
        },
        text: options.text ?? placedText(owner?.name ?? 'Someone', placed),
    });
    return placed;
}

function endedText(p: PlacedEffect, why: PlacedEndReason): string {
    if (p.kind === 'mark' && p.mark) {
        const word = TILE_MARKS[p.mark].label;
        if (why === 'cleared') return `${word} is cleared away.`;
        if (why === 'replaced') return `${word} gives way to something new.`;
        return `${word} fades.`;
    }
    const what = `The ${PLACED_WORDS[p.kind]} (${p.name})`;
    if (why === 'cleared') return `${what} is cleared away.`;
    if (why === 'spent') return `${what} is spent.`;
    if (why === 'expired') return `${what} fades.`;
    if (why === 'replaced') return `${what} gives way to a new one.`;
    return `${what} fades with its maker.`;
}

export function endPlaced(draft: Draft, placed: PlacedEffect, why: PlacedEndReason): void {
    const s = draft.state;
    if (!placedOf(s).some(p => p.id === placed.id)) return;
    s.placed = placedOf(s).filter(p => p.id !== placed.id);
    emit(draft, {
        type: 'placed_ended',
        actorId: placed.ownerId,
        data: { placed: copyPlaced(placed), kind: placed.kind, why, ability: placed.name },
        text: endedText(placed, why),
    });
}

function ownerGone(state: CombatState, p: PlacedEffect): boolean {
    if (p.kind !== 'mantle' && p.kind !== 'delay') return false;
    return state.combatants[p.ownerId]?.status !== 'up';
}

export function expirePlaced(draft: Draft, nextRound: number): void {
    const s = draft.state;
    if (!s.placed || s.placed.length === 0) return;
    for (const p of [...s.placed]) {
        if (ownerGone(s, p)) endPlaced(draft, p, 'owner_gone');
        else if (p.expiresRound <= nextRound) endPlaced(draft, p, 'expired');
    }
}

export function sweepOwnerless(draft: Draft): void {
    const s = draft.state;
    if (!s.placed || s.placed.length === 0) return;
    for (const p of [...s.placed]) if (ownerGone(s, p)) endPlaced(draft, p, 'owner_gone');
}

export function undoPlacedEvent(placed: readonly PlacedEffect[], event: CombatEvent): PlacedEffect[] | null {
    const raw = event.data.placed as PlacedEffect | undefined;
    if (event.type === 'placed') return raw ? placed.filter(p => p.id !== raw.id) : [...placed];
    if (event.type === 'placed_ended') return raw && !placed.some(p => p.id === raw.id) ? [...placed, copyPlaced(raw)] : [...placed];
    if (event.type === 'placed_triggered') return [...placed];
    return null;
}
