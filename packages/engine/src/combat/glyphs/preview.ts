import { distance, sameTeam } from '../grid';
import { buildPcCombatant } from '../pc';
import type { CombatSheet, CombatState, Combatant, GlyphAbility, Grid, Pos, Side } from '../types';
import { EFFECTS } from './registry';
import { abilityTargets, legalAims } from './targeting';
import type { AimResult } from './targeting';

export const PREVIEW_SIZE = 10;

export const PREVIEW_USER_ID = 'preview-user';

export type PreviewUnit = { id: string; side: Side; position: Pos };

export type AbilityPreview = {
    width: number;
    height: number;
    units: PreviewUnit[];
    aim: Pos | null;
    result: AimResult;
};

const PREVIEW_SHEET: CombatSheet = {
    abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 10 },
    budget: 'NORMAL',
    level: 3,
    needsAllocation: false,
};

const LAYOUT: ReadonlyArray<{ id: string; side: Side; position: Pos }> = [
    { id: PREVIEW_USER_ID, side: 'player', position: { x: 2, y: 5 } },
    { id: 'preview-enemy-1', side: 'enemy', position: { x: 3, y: 5 } },
    { id: 'preview-enemy-2', side: 'enemy', position: { x: 5, y: 5 } },
    { id: 'preview-ally', side: 'ally', position: { x: 2, y: 6 } },
];

function unit(id: string, side: Side, position: Pos): Combatant {
    return {
        id, name: id, side, controller: 'engine', tier: 'grunt',
        abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
        maxHp: 30, hp: 30, ac: 10, attackBonus: 3, damage: { count: 1, sides: 6, bonus: 0, type: 'slashing' },
        initiative: 0, status: 'up', conditions: [], position, range: 'close',
    };
}

export function previewState(): CombatState {
    const grid: Grid = { width: PREVIEW_SIZE, height: PREVIEW_SIZE, tiles: new Array(PREVIEW_SIZE * PREVIEW_SIZE).fill('floor') };
    const combatants: Record<string, Combatant> = {};
    for (const entry of LAYOUT) {
        combatants[entry.id] = entry.id === PREVIEW_USER_ID
            ? { ...buildPcCombatant({ id: PREVIEW_USER_ID, name: 'You', sheet: PREVIEW_SHEET }), position: { ...entry.position } }
            : unit(entry.id, entry.side, { ...entry.position });
    }
    return {
        id: 'preview', round: 1, order: LAYOUT.map(e => e.id), turnIndex: 0, combatants,
        rngSeed: 1, rngCursor: 0, eventSeq: 0, outcome: null, grid, turnCount: 1,
    };
}

function helpfulOnly(ability: GlyphAbility): boolean {
    return ability.effects.length > 0 && ability.effects.every(e => EFFECTS[e.id]?.helpful === true);
}

function usesTile(ability: GlyphAbility): boolean {
    return ability.effects.some(e => EFFECTS[e.id]?.tile === true || e.id === 'blink');
}

function score(state: CombatState, ability: GlyphAbility, aim: Pos | null, result: AimResult): number {
    const user = state.combatants[PREVIEW_USER_ID];
    const hits = result.targetIds.map(id => state.combatants[id]).filter((c): c is Combatant => !!c);
    const friendly = hits.filter(c => c.id === user.id || sameTeam(user.side, c.side)).length;
    const hostile = hits.length - friendly;
    if (usesTile(ability) && aim) {
        const nearest = Math.min(...Object.values(state.combatants).filter(c => c.side === 'enemy').map(c => distance(c.position as Pos, aim)));
        return -nearest;
    }
    return helpfulOnly(ability) ? friendly * 100 - hostile * 10 : hostile * 100 - friendly * 10;
}

export function previewAbility(ability: GlyphAbility): AbilityPreview {
    const state = previewState();
    const units = LAYOUT.map(e => ({ id: e.id, side: e.side, position: { ...e.position } }));
    const aims: Array<Pos | null> = ability.form.id === 'self' && !ability.effects.some(e => e.id === 'blink')
        ? [null]
        : legalAims(state, PREVIEW_USER_ID, ability);
    let best: { aim: Pos | null; result: AimResult; score: number } | null = null;
    for (const aim of aims) {
        const result = abilityTargets(state, PREVIEW_USER_ID, ability, aim);
        if (!result.ok) continue;
        const s = score(state, ability, aim, result);
        if (!best || s > best.score) best = { aim, result, score: s };
    }
    const fallback = abilityTargets(state, PREVIEW_USER_ID, ability, null);
    return {
        width: PREVIEW_SIZE,
        height: PREVIEW_SIZE,
        units,
        aim: best?.aim ?? null,
        result: best?.result ?? { ...fallback, ok: false, reason: fallback.reason ?? 'no legal aim', tiles: [], targetIds: [] },
    };
}
