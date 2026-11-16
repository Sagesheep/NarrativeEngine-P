import { objectiveClock, objectiveMarks } from '@narrative/engine';
import type { TranslateKey, TranslateVars } from '../../i18n';
import type { CombatObjective, CombatPos, CombatState, Combatant, LoseKind } from '../../types';
import { hasObjectiveStakes } from '../../services/combat/objectiveStory';
import { posKey } from './combatVisuals';

type T = (key: TranslateKey, vars?: TranslateVars) => string;

function nameOf(state: CombatState, id: string | undefined): string {
    return (id && state.combatants[id]?.name) || '';
}

export function winText(state: CombatState, win: CombatObjective['win'], t: T): string {
    switch (win.kind) {
        case 'rout':
            return t('combat.objective.win.rout');
        case 'defeat_leader':
            return t('combat.objective.win.defeat_leader', { leader: nameOf(state, win.leaderId) });
        case 'survive':
            return t('combat.objective.win.survive', { rounds: win.rounds });
        case 'escape':
            return t(win.everyone ? 'combat.objective.win.escapeAll' : 'combat.objective.win.escape');
        case 'seize':
            return t('combat.objective.win.seize');
        case 'protect': {
            const ward = nameOf(state, win.wardId);
            if (win.with) return t('combat.objective.win.protectWith', { win: winText(state, win.with, t), ward });
            return t('combat.objective.win.protectAlone', { ward, rounds: win.rounds ?? 0 });
        }
    }
}

function loseText(state: CombatState, o: CombatObjective, kind: LoseKind, t: T): string {
    const found = o.lose?.find(l => l.kind === kind);
    switch (kind) {
        case 'pc_falls':
            return t('combat.objective.lose.pc_falls');
        case 'ward_falls':
            return t('combat.objective.lose.ward_falls', { ward: found?.kind === 'ward_falls' ? nameOf(state, found.wardId) : '' });
        case 'round_limit':
            return t('combat.objective.lose.round_limit', { limit: o.roundLimit ?? 0 });
        case 'leader_escapes':
            return t('combat.objective.lose.leader_escapes', { leader: found?.kind === 'leader_escapes' ? nameOf(state, found.leaderId) : '' });
    }
}

function sideText(state: CombatState, o: CombatObjective, t: T): string | null {
    const side = o.side;
    if (!side) return null;
    switch (side.kind) {
        case 'within_rounds':
            return t('combat.objective.side.within_rounds', { rounds: side.rounds });
        case 'no_one_falls':
            return t('combat.objective.side.no_one_falls');
        case 'save_bystander':
            return t('combat.objective.side.save_bystander', { name: nameOf(state, side.bystanderId) });
        case 'reach_tile':
            return t('combat.objective.side.reach_tile');
    }
}

export type ObjectiveView = {
    win: string;
    lose: string[];
    side: string | null;
    sideResult: 'met' | 'missed' | null;
    clock: { text: string; last: boolean } | null;
    incoming: string[];
    out: string[];
    holding: string | null;
    result: { status: 'won' | 'lost' | 'ended'; text: string } | null;
};

export function objectiveView(state: CombatState, t: T): ObjectiveView | null {
    const o = state.objective;
    if (!hasObjectiveStakes(o)) return null;
    const clock = objectiveClock(state);
    const marks = objectiveMarks(state);
    const outIds = o.progress?.escaped ?? [];
    const holder = o.progress?.holderId ? nameOf(state, o.progress.holderId) : '';
    const result = o.result;
    return {
        win: winText(state, o.win, t),
        lose: (o.lose ?? []).map(l => loseText(state, o, l.kind, t)),
        side: sideText(state, o, t),
        sideResult: result?.side ? (result.side.met ? 'met' : 'missed') : null,
        clock: clock && !result ? { text: clock.left <= 1 ? t('combat.objective.clock.last') : t('combat.objective.clock.left', { left: clock.left }), last: clock.left <= 1 } : null,
        incoming: marks.incoming.map(w => t('combat.objective.incoming', { round: w.round })),
        out: outIds.map(id => nameOf(state, id)).filter(Boolean),
        holding: holder && !result ? t('combat.objective.holding', { name: holder }) : null,
        result: result ? { status: result.status, text: t(`combat.objective.result.${result.status}`) } : null,
    };
}

export type MarkRole = NonNullable<Combatant['mark']>;

export function roleLabel(role: MarkRole, t: T): string {
    return t(`combat.objective.role.${role}`);
}

export type TileMark = { kind: 'exit' | 'leaderExit' | 'seize' | 'reach' | 'incoming'; pos: CombatPos; label: string };

export function tileMarks(state: CombatState, t: T): TileMark[] {
    if (!state.objective && !state.reinforcements) return [];
    const marks = objectiveMarks(state);
    const out: TileMark[] = [];
    for (const pos of marks.exits) out.push({ kind: 'exit', pos, label: t('combat.objective.mark.exit') });
    for (const pos of marks.leaderExits) out.push({ kind: 'leaderExit', pos, label: t('combat.objective.mark.leaderExit') });
    if (marks.seize) out.push({ kind: 'seize', pos: marks.seize, label: t('combat.objective.mark.seize') });
    if (marks.reach) out.push({ kind: 'reach', pos: marks.reach, label: t('combat.objective.mark.reach') });
    for (const wave of marks.incoming) {
        for (const pos of wave.tiles) out.push({ kind: 'incoming', pos, label: t('combat.objective.mark.incoming', { round: wave.round }) });
    }
    return out;
}

export function markAt(marks: readonly TileMark[], pos: CombatPos | null | undefined): TileMark | undefined {
    return pos ? marks.find(m => posKey(m.pos) === posKey(pos)) : undefined;
}
