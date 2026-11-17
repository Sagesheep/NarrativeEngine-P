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

export type GlyphAiEntry = { glyph: { kind: 'form' | 'effect' | 'augment'; id: string }; plan: boolean; reason: string };

export const GLYPH_AI: readonly GlyphAiEntry[] = [
    { glyph: { kind: 'form', id: 'sigil' }, plan: false, reason: 'A trap pays only if a foe walks onto it later; choosing the square needs a guess at foe paths over several turns, which the one-turn planner does not make.' },
    { glyph: { kind: 'form', id: 'mantle' }, plan: true, reason: 'Valued as one application of its effects to the units now within its radius of the square the caster ends on; not recast while one is active.' },
    { glyph: { kind: 'form', id: 'chain' }, plan: true, reason: 'Targets come from the resolver; each target is valued at its share of the strength.' },
    { glyph: { kind: 'form', id: 'wall' }, plan: false, reason: 'Where a wall helps (cutting a path, shielding a shooter) depends on later movement; the planner has no term for blocking routes.' },
    { glyph: { kind: 'effect', id: 'snare' }, plan: true, reason: 'Control value: the target cannot close in; worth little against a shooter.' },
    { glyph: { kind: 'effect', id: 'dispel' }, plan: true, reason: 'Support value for harmful conditions on a friend, control value for helpful ones on a foe.' },
    { glyph: { kind: 'effect', id: 'leap' }, plan: false, reason: 'A movement glyph: valuing it needs a second tile search from every landing square, the same reason blink is left to players.' },
    { glyph: { kind: 'effect', id: 'gravity' }, plan: true, reason: 'Valued like a pull toward the centre: hazards crossed, plus a small control value.' },
    { glyph: { kind: 'effect', id: 'fear' }, plan: true, reason: 'Control value scaled by the target\'s threat.' },
    { glyph: { kind: 'effect', id: 'decay' }, plan: true, reason: 'Valued as damage that cannot be healed.' },
    { glyph: { kind: 'effect', id: 'vanish' }, plan: true, reason: 'Support value when foes can reach the caster.' },
    { glyph: { kind: 'effect', id: 'rewind' }, plan: true, reason: 'Support value equal to the HP it would give back.' },
    { glyph: { kind: 'augment', id: 'dampen' }, plan: true, reason: 'Changes the numbers only.' },
    { glyph: { kind: 'augment', id: 'sustain' }, plan: true, reason: 'Changes the numbers only.' },
    { glyph: { kind: 'augment', id: 'delay' }, plan: true, reason: 'Valued with the stronger payload, times the chance the target is still there (certain if it cannot move).' },
    { glyph: { kind: 'effect', id: 'blink' }, plan: false, reason: 'A movement glyph (unchanged from before).' },
    { glyph: { kind: 'effect', id: 'barrier' }, plan: false, reason: 'Blocks squares; the planner has no term for routes (unchanged from before).' },
    { glyph: { kind: 'effect', id: 'swap' }, plan: false, reason: 'Moves two units; valuing it needs a position search for both (unchanged from before).' },
];

export const AI_SKIP_EFFECTS: ReadonlySet<string> = new Set(GLYPH_AI.filter(g => !g.plan && g.glyph.kind === 'effect').map(g => g.glyph.id));

export const AI_SKIP_FORMS: ReadonlySet<string> = new Set(GLYPH_AI.filter(g => !g.plan && g.glyph.kind === 'form').map(g => g.glyph.id));

export const GLYPH_AI_VALUES = {
    snare: 0.5,
    snareShooter: 0.15,
    fear: 0.6,
    gravity: 0.2,
    delayStay: 0.5,
    vanish: 0.8,
    dispelStun: 4,
    dispelOther: 1,
    dispelHaste: 3,
    zoneShare: 0.6,
    fearPull: 2,
} as const;
