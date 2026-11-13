import { canTarget, checkAttack } from '@narrative/engine';
import { hpBandLabel } from '../../services/combat/combatEvents';
import type { CombatGrid, CombatPos, CombatState, CombatTile, Combatant } from '../../types';

export const TILE_SIZE = 10;

export const TILE_FILL: Record<CombatTile, string> = {
    floor: 'var(--combat-floor)',
    wall: 'var(--combat-wall)',
    cover: 'var(--combat-cover)',
    difficult: 'var(--combat-difficult)',
    hazard: 'var(--combat-floor)',
};

export const LEGEND_TILES: readonly Exclude<CombatTile, 'floor'>[] = ['wall', 'cover', 'difficult', 'hazard'];

export const BAND_KEY = {
    unhurt: 'combat.band.unhurt',
    hurt: 'combat.band.hurt',
    'badly hurt': 'combat.band.badlyHurt',
    down: 'combat.band.down',
    fled: 'combat.band.fled',
    yielded: 'combat.band.yielded',
} as const;

export function sideColor(side: Combatant['side']): string {
    if (side === 'enemy') return 'var(--combat-enemy)';
    if (side === 'neutral') return 'var(--combat-neutral)';
    return 'var(--combat-party)';
}

export function hpColor(c: Pick<Combatant, 'hp' | 'maxHp' | 'status'>): string {
    const band = hpBandLabel(c);
    if (band === 'unhurt') return 'var(--combat-hp-good)';
    if (band === 'hurt') return 'var(--combat-hp-warn)';
    return 'var(--combat-hp-bad)';
}

export function isParty(c: Pick<Combatant, 'side'>): boolean {
    return c.side === 'player' || c.side === 'ally';
}

export function posKey(p: CombatPos): string {
    return `${p.x},${p.y}`;
}

export function tileCenter(p: CombatPos): CombatPos {
    return { x: p.x * TILE_SIZE + TILE_SIZE / 2, y: p.y * TILE_SIZE + TILE_SIZE / 2 };
}

export function tokenAt(state: CombatState, p: CombatPos): Combatant | undefined {
    const all = Object.values(state.combatants).filter(c => c.status !== 'gone' && c.status !== 'fled');
    return all.find(c => c.status === 'up' && c.position?.x === p.x && c.position?.y === p.y)
        ?? all.find(c => c.position?.x === p.x && c.position?.y === p.y);
}

export function playerCharacter(state: CombatState): Combatant | undefined {
    return Object.values(state.combatants).find(c => c.side === 'player');
}

export function attackableTargets(state: CombatState, actor: Combatant | undefined, actionLeft: boolean): Combatant[] {
    if (!actor || !actionLeft) return [];
    return state.order
        .map(id => state.combatants[id])
        .filter(c => c && c.position && canTarget(actor, c) && checkAttack(state, actor.id, c.id).ok);
}

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export function inspectCorner(pos: CombatPos | undefined, width: number, height: number): Corner {
    if (!pos) return 'top-right';
    const vertical = pos.y < height / 2 ? 'bottom' : 'top';
    const horizontal = pos.x < width / 2 ? 'right' : 'left';
    return `${vertical}-${horizontal}`;
}

export function isOnBoard(c: Pick<Combatant, 'status'>): boolean {
    return c.status !== 'gone' && c.status !== 'fled';
}

export function turnOrderForStrip(state: CombatState): Combatant[] {
    const all = state.order.map(id => state.combatants[id]).filter((c): c is Combatant => !!c && c.status !== 'gone');
    return [...all.filter(c => c.status === 'up'), ...all.filter(c => c.status !== 'up')];
}

const LEGEND_STORAGE_KEY = 'nn_combat_legend';

export function initialLegendOpen(): boolean {
    try {
        return window.localStorage.getItem(LEGEND_STORAGE_KEY) !== 'collapsed';
    } catch {
        return true;
    }
}

export function rememberLegendDismissed(): void {
    try {
        window.localStorage.setItem(LEGEND_STORAGE_KEY, 'collapsed');
    } catch {
        return;
    }
}

export function terrainLabel(grid: CombatGrid | undefined, tile: CombatTile): string | null {
    if (!grid || tile === 'floor') return null;
    const label = grid.labels?.[tile];
    return typeof label === 'string' && label.trim() ? label.trim() : null;
}
