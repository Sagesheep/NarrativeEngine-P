import type { Archetype, CombatTier, Tactic } from '../types';

export const TACTICS: readonly Tactic[] = ['aggressive', 'skirmisher', 'guard', 'hunter', 'coward', 'berserker', 'support'];

export const TARGET_TERMS = ['damage', 'kill', 'threat', 'finish', 'focus', 'defended', 'proximity', 'hunt', 'protect', 'steal'] as const;

export const POSITION_TERMS = [
    'hazard', 'hazardEdge', 'cover', 'exposure', 'swarm', 'kite', 'clump', 'lane', 'escape', 'surround', 'post', 'behind', 'progress',
] as const;

export const ACTION_TERMS = [
    'friendlyFire', 'economy', 'support', 'control', 'defend', 'dash', 'shove', 'throw', 'help', 'jump', 'reposition',
] as const;

export type TargetTerm = typeof TARGET_TERMS[number];
export type PositionTerm = typeof POSITION_TERMS[number];
export type ActionTerm = typeof ACTION_TERMS[number];
export type TermId = TargetTerm | PositionTerm | ActionTerm;

export const ALL_TERMS: readonly TermId[] = [...TARGET_TERMS, ...POSITION_TERMS, ...ACTION_TERMS];

export const AI_WEIGHTS: Readonly<Record<TermId, number>> = {
    damage: 1,
    kill: 1.5,
    threat: 0.5,
    finish: 0.5,
    focus: 0.3,
    defended: 0.5,
    proximity: 0.6,
    hunt: 3,
    protect: 0.6,
    steal: 0.05,
    hazard: 2.5,
    hazardEdge: 0.4,
    cover: 0.6,
    exposure: 0.35,
    swarm: 1.5,
    kite: 0.8,
    clump: 0.6,
    lane: 0.5,
    escape: 0.4,
    surround: 0.4,
    post: 1.2,
    behind: 0.8,
    progress: 0.3,
    friendlyFire: 1.5,
    economy: 0.25,
    support: 1,
    control: 0.8,
    defend: 0.35,
    dash: 1,
    shove: 1,
    throw: 1,
    help: 1,
    jump: 1,
    reposition: 0.5,
};

const MINION_TERMS: readonly TermId[] = ['damage', 'kill', 'proximity', 'hazard', 'progress', 'friendlyFire', 'support', 'defend'];

const GRUNT_TERMS: readonly TermId[] = [...MINION_TERMS, 'focus', 'cover', 'finish', 'defended', 'swarm', 'dash', 'economy', 'control'];

export const TACTIC_ONLY_TERMS: readonly TermId[] = ['proximity', 'kite', 'post', 'behind', 'hunt', 'protect'];

const DEEP_TERMS: readonly TermId[] = ALL_TERMS.filter(t => !TACTIC_ONLY_TERMS.includes(t));

export const TIER_DEPTH: Readonly<Record<CombatTier, readonly TermId[]>> = {
    minion: MINION_TERMS,
    grunt: GRUNT_TERMS,
    elite: DEEP_TERMS,
    boss: DEEP_TERMS,
    legendary: DEEP_TERMS,
};

export const AUTOPILOT_DEPTH: CombatTier = 'minion';

export type TacticProfile = {
    on: readonly TermId[];
    off: readonly TermId[];
    scale: Readonly<Partial<Record<TermId, number>>>;
    retreatBelow?: number;
    throwsAllies?: boolean;
};

export const TACTIC_PROFILES: Readonly<Record<Tactic, TacticProfile>> = {
    aggressive: { on: [], off: ['exposure'], scale: { damage: 1.1, progress: 1.2 } },
    skirmisher: { on: ['kite', 'reposition', 'cover'], off: [], scale: { swarm: 1.5, cover: 1.5, progress: 0.6 } },
    guard: { on: ['post', 'protect', 'defend', 'shove'], off: [], scale: { progress: 0.5 } },
    hunter: { on: ['hunt'], off: ['proximity'], scale: { progress: 1.2 } },
    coward: { on: ['behind', 'escape'], off: [], scale: { exposure: 1.5, swarm: 1.5 }, retreatBelow: 0.5 },
    berserker: {
        on: ['throw'],
        off: ['cover', 'exposure', 'swarm', 'escape', 'kite', 'behind', 'hazardEdge', 'defend', 'economy'],
        scale: { damage: 1.25, kill: 1.25, progress: 1.3 },
        throwsAllies: true,
    },
    support: { on: ['support', 'help'], off: [], scale: { support: 2, help: 1.5, damage: 0.8 } },
};

export type TacticRule = { when: 'heals' | 'ranged'; tactic: Tactic } | { archetype: Archetype; tactic: Tactic };

export const TACTIC_DERIVATION: readonly TacticRule[] = [
    { when: 'heals', tactic: 'support' },
    { when: 'ranged', tactic: 'skirmisher' },
    { archetype: 'assassin', tactic: 'hunter' },
    { archetype: 'bulwark', tactic: 'guard' },
    { archetype: 'skirmisher', tactic: 'skirmisher' },
];

export const DEFAULT_TACTIC: Tactic = 'aggressive';

export const AI_LIMITS = {
    shoveMin: 0.5,
    typicalAc: 12,
    hazardHit: 3.5,
    guardRadius: 2,
    kiteCap: 3,
    summonValue: 4,
    weakAt: 0.5,
    winningMargin: 0.25,
    shootingRange: 8,
} as const;
