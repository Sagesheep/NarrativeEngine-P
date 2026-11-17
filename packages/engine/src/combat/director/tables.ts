import type { TermId } from '../ai/tables';
import type { CombatTier, EffectId, OrderKind } from '../types';

export const ORDER_KINDS: readonly OrderKind[] = ['focus', 'protect', 'hold', 'fall_back', 'press', 'signature', 'switch_tactic'];

export const ORDER_EVENT_TYPE = 'order_given';

export const DIRECTED_TIERS: ReadonlySet<CombatTier> = new Set<CombatTier>(['elite', 'boss', 'legendary']);

export type OrderProfile = {
    on: readonly TermId[];
    off: readonly TermId[];
    scale: Readonly<Partial<Record<TermId, number>>>;
    focusBonus?: number;
    holdPenalty?: number;
    awayPull?: number;
    allyPull?: number;
    signatureBonus?: number;
    guarding?: boolean;
    overridesRetreat?: boolean;
};

export const ORDER_PROFILES: Readonly<Record<OrderKind, OrderProfile>> = {
    focus: { on: [], off: [], scale: { progress: 1.5 }, focusBonus: 6 },
    protect: { on: ['post', 'protect', 'defend', 'shove'], off: [], scale: { progress: 0.5 }, guarding: true },
    hold: { on: [], off: ['progress', 'proximity', 'hunt'], scale: {}, holdPenalty: 4 },
    fall_back: {
        on: ['kite', 'escape', 'cover', 'behind'],
        off: ['progress', 'proximity', 'hunt'],
        scale: { damage: 0.5, kill: 0.5 },
        awayPull: 1.2,
        allyPull: 0.4,
    },
    press: {
        on: [],
        off: ['exposure', 'swarm', 'cover', 'hazardEdge', 'escape', 'kite', 'behind', 'defend', 'economy'],
        scale: { damage: 1.2, kill: 1.2, progress: 1.5 },
        overridesRetreat: true,
    },
    signature: { on: [], off: [], scale: {}, signatureBonus: 40 },
    switch_tactic: { on: [], off: [], scale: {} },
};

export const ORDER_LIMITS = {
    lineMax: 140,
    awayCap: 4,
    allyCap: 6,
    lowHp: 0.25,
    nearDeathBand: 0.25,
    bloodiedBand: 0.5,
} as const;

export type SignatureBudget = {
    cost: number;
    glyphs: number;
    uses: number;
};

export const SIGNATURE_BUDGET: Readonly<Partial<Record<CombatTier, SignatureBudget>>> = {
    grunt: { cost: 1, glyphs: 2, uses: 1 },
    elite: { cost: 2, glyphs: 3, uses: 1 },
    boss: { cost: 3, glyphs: 4, uses: 2 },
    legendary: { cost: 4, glyphs: 5, uses: 2 },
};

export const SIGNATURE_SURCHARGE: Readonly<Partial<Record<EffectId, number>>> = {
    heal: 2,
    shield: 2,
    drain: 1,
    rewind: 2,
    vanish: 1,
    decay: 1,
};

export const SIGNATURE_UNUSABLE_EFFECTS: ReadonlySet<EffectId> = new Set<EffectId>(['blink', 'barrier', 'swap', 'leap']);

export const SIGNATURE_UNUSABLE_FORMS: ReadonlySet<string> = new Set<string>(['sigil', 'wall']);

export const SIGNATURE_NAME_FALLBACK = 'Signature move';

export const SIGNATURE_ID_PREFIX = 'sig-';

export const BRIEF_BANDS = ['full', 'hurt', 'bloodied', 'near_death'] as const;
