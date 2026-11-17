import { placedOf, sigilVisibleTo, sameTeam } from '@narrative/engine';
import type { ElementId, PlacedEffect, PlacedKind, TileMarkId } from '@narrative/engine';
import type { TranslateKey, TranslateVars } from '../../i18n';
import type { CombatPos, CombatState } from '../../types';
import { ELEMENT_COLORS, MARK_COLORS, NEUTRAL_PLACED_COLOR, isElement, isMark, markName, placedName } from './elementText';

type T = (key: TranslateKey, vars?: TranslateVars) => string;

export type PlacedView = {
    id: string;
    kind: PlacedKind;
    mark?: TileMarkId;
    element?: ElementId;
    tiles: CombatPos[];
    centre?: CombatPos;
    radius?: number;
    roundsLeft: number;
    ownerName: string;
    abilityName: string;
    color: string;
    label: string;
};

function partyViewers(state: CombatState) {
    return Object.values(state.combatants).filter(c => (c.side === 'player' || c.side === 'ally') && c.status === 'up');
}

export function placedVisible(state: CombatState, placed: PlacedEffect): boolean {
    if (placed.kind !== 'sigil') return true;
    if (sameTeam(placed.side, 'player')) return true;
    return partyViewers(state).some(v => sigilVisibleTo(state, placed, v));
}

function colorOf(placed: PlacedEffect): string {
    if (placed.kind === 'mark' && isMark(placed.mark)) return MARK_COLORS[placed.mark];
    return isElement(placed.element) ? ELEMENT_COLORS[placed.element] : NEUTRAL_PLACED_COLOR;
}

function labelOf(placed: PlacedEffect, owner: string, ability: string, rounds: number, t: T): string {
    if (placed.kind === 'mark' && isMark(placed.mark)) {
        return t('combat.placed.markLabel', { mark: markName(placed.mark, t), squares: placed.tiles.length, rounds });
    }
    const kind = placed.kind === 'mark' ? 'sigil' : placed.kind;
    if (kind === 'delay') return t('combat.placed.delayLabel', { ability, name: owner });
    return t('combat.placed.label', { kind: placedName(kind, t), ability, name: owner, rounds });
}

export function placedViews(state: CombatState, t: T): PlacedView[] {
    const out: PlacedView[] = [];
    for (const placed of placedOf(state)) {
        if (!placedVisible(state, placed)) continue;
        const owner = state.combatants[placed.ownerId];
        const ownerName = owner?.name ?? '?';
        const abilityName = placed.name || '?';
        const roundsLeft = Math.max(0, placed.expiresRound - state.round);
        const centre = placed.kind === 'mantle' && owner?.position && owner.status === 'up' ? { ...owner.position } : undefined;
        if (placed.kind === 'mantle' && !centre) continue;
        out.push({
            id: placed.id,
            kind: placed.kind,
            ...(placed.kind === 'mark' && isMark(placed.mark) ? { mark: placed.mark } : {}),
            ...(isElement(placed.element) ? { element: placed.element } : {}),
            tiles: placed.tiles.map(p => ({ x: p.x, y: p.y })),
            ...(centre ? { centre } : {}),
            ...(placed.kind === 'mantle' ? { radius: placed.radius ?? 1 } : {}),
            roundsLeft,
            ownerName,
            abilityName,
            color: colorOf(placed),
            label: labelOf(placed, ownerName, abilityName, roundsLeft, t),
        });
    }
    return out;
}

export function coversTile(view: PlacedView, p: CombatPos): boolean {
    if (view.centre && view.radius !== undefined) {
        return Math.max(Math.abs(view.centre.x - p.x), Math.abs(view.centre.y - p.y)) <= view.radius;
    }
    return view.tiles.some(tile => tile.x === p.x && tile.y === p.y);
}

export function placedLabelAt(views: readonly PlacedView[], p: CombatPos | null | undefined): string | null {
    if (!p) return null;
    const labels = views.filter(v => coversTile(v, p)).map(v => v.label);
    return labels.length > 0 ? labels.join(' · ') : null;
}
