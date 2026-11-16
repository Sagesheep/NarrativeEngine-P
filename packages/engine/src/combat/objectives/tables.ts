import type { CombatTier, LoseKind, ReinforcementLevel, SideKind, WinKind } from '../types';

export const WIN_KINDS: readonly WinKind[] = ['rout', 'defeat_leader', 'survive', 'escape', 'protect', 'seize'];

export const LOSE_KINDS: readonly LoseKind[] = ['pc_falls', 'ward_falls', 'round_limit', 'leader_escapes'];

export const SIDE_KINDS: readonly SideKind[] = ['within_rounds', 'no_one_falls', 'save_bystander', 'reach_tile'];

export const REINFORCEMENT_LEVELS: readonly ReinforcementLevel[] = ['none', 'some', 'many'];

export const OBJECTIVE_EVENT_TYPES: readonly string[] = [
    'objective_progress', 'objective_met', 'objective_failed', 'reinforcements_warning', 'reinforcements_arrive',
];

export type Bounds = { min: number; max: number; fallback: number };

export const OBJECTIVE_LIMITS = {
    survive: { min: 2, max: 8, fallback: 5 } as Bounds,
    protect: { min: 2, max: 8, fallback: 4 } as Bounds,
    roundLimit: { min: 3, max: 15, fallback: 8 } as Bounds,
    withinRounds: { min: 2, max: 12, fallback: 6 } as Bounds,
    markShare: 0.5,
    reachShare: 0.3,
    leaderExitShare: 0.45,
    leaderLead: 5,
    exitWidth: 1,
    escapeMargin: 2,
    breakPenalty: 5,
    triggerRadius: 3,
    arrivalGap: 4,
    triggeredDelay: 2,
    maxWaveUnits: 4,
} as const;

export const OBJECTIVE_WEIGHTS = {
    goal: 1,
    leaderRun: 2.5,
    guardTile: 1.5,
    guardRadius: 1,
    screen: 0.5,
    runner: 2,
    runnerRadius: 5,
    ward: 1,
    leaderFocus: 3,
    wardGuard: 0.6,
    pressFloor: 0.25,
    pressDamage: 0.3,
    pressProgress: 1,
    bystanderDanger: 1,
    bystanderRadius: 4,
    wardStay: 0.5,
} as const;

export const REINFORCEMENT_THREAT: Readonly<Record<CombatTier, number>> = {
    minion: 1, grunt: 2, elite: 6, boss: 12, legendary: 24,
};

export const REINFORCEMENT_BUDGET: Readonly<Record<ReinforcementLevel, number>> = { none: 0, some: 0.5, many: 1 };

export const REINFORCEMENT_WAVES: Readonly<Record<ReinforcementLevel, number>> = { none: 0, some: 1, many: 2 };

export const REINFORCEMENT_KIND_SCALE: Readonly<Record<WinKind, number>> = {
    rout: 0, survive: 1, seize: 1, defeat_leader: 0.5, escape: 0.5, protect: 0.5,
};

export const REINFORCEMENT_MIN_BUDGET = 2;
