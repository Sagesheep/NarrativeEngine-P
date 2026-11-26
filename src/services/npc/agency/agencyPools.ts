import type { HexAxis } from '../../../types';

export type PoolTier = 'default' | 'mature';
// NPC Generation Refit (Phase 1) — `axisMods` carries small per-axis nudges (±1, rarely ±2)
// the engine applies AFTER the base roll and clamps at the hard ±3. This is the escape hatch
// that lets a trait defy the group envelope (e.g. a 'brave'-tagged NPC whose boldness rolled
// low lands "brave at heart, currently cowed"). Existing entries keep text/tier/hook unchanged.
export type TraitEntry  = { text: string; tier: PoolTier; hook: string; axisMods?: Partial<Record<HexAxis, number>> };
export type WantEntry   = { text: string; tier: PoolTier; kind: 'short' | 'medium' };
export type ActionEntry = { text: string; tier: PoolTier; context: 'peaceful' | 'dangerous' };

export const TRAIT_VOCAB: readonly TraitEntry[] = Object.freeze([
    { text: 'faithful', tier: 'default', hook: 'gate: blocks non-spouse romance targeting them', axisMods: { diligence: 1 } },
    { text: 'promiscuous', tier: 'default', hook: 'heat-bias: raises intimacy heat', axisMods: { warmth: 1, composure: -1 } },
    { text: 'ambitious', tier: 'default', hook: 'heat-bias: raises long-goal base_heat; drive_mult up', axisMods: { drive: 2, boldness: 1 } },
    { text: 'vengeful', tier: 'default', hook: 'goal-spawn: relation <= Hostile -> spawn revenge goal', axisMods: { empathy: -1, composure: -1 } },
    { text: 'loyal', tier: 'default', hook: 'gate: won\'t betray Close/Devoted', axisMods: { warmth: 1, empathy: 1, diligence: 1 } },
    { text: 'cowardly', tier: 'default', hook: 'karma-mod: penalty in dangerous context', axisMods: { boldness: -2, composure: -1 } },
    { text: 'honorable', tier: 'default', hook: 'gate: blocks underhanded actions', axisMods: { diligence: 1, empathy: 1 } },
    { text: 'proud', tier: 'default', hook: 'heat-bias: attempts above-tier goals (bigger swings)', axisMods: { boldness: 1, drive: 1 } },
    { text: 'protective', tier: 'default', hook: 'goal-spawn: spawn protect-goals for Close/Devoted', axisMods: { warmth: 1, empathy: 1 } },
    { text: 'jealous', tier: 'default', hook: 'goal-spawn: rival in romance thread -> spawn rivalry goal', axisMods: { empathy: -1, composure: -1 } },
    { text: 'scheming', tier: 'default', hook: 'gate: unlocks manipulation/leverage medium goals', axisMods: { drive: 1, empathy: -1, composure: 1 } },
    { text: 'eccentric', tier: 'default', hook: 'heat-bias: raises novelty color-roll frequency', axisMods: { composure: -1, boldness: 1 } },
    { text: 'impulsive', tier: 'default', hook: 'heat-bias: raises novelty color-roll frequency', axisMods: { composure: -2, boldness: 1 } },
    { text: 'sadistic', tier: 'mature', hook: 'gate: unlocks cruelty actions', axisMods: { empathy: -2, warmth: -1 } },
    { text: 'predatory', tier: 'mature', hook: 'gate: removes restraint on intimacy targeting', axisMods: { boldness: 1, empathy: -1 } },
    { text: 'bloodthirsty', tier: 'mature', hook: 'gate: unlocks gore/violence-for-pleasure', axisMods: { empathy: -2, boldness: 1 } },
    { text: 'ruthless', tier: 'mature', hook: 'gate: unlocks coercion/bodily-exchange leverage', axisMods: { drive: 1, empathy: -2 } },
    { text: 'superstitious', tier: 'default', hook: 'gate: blocks arcane actions without ritual preparation', axisMods: { composure: -1, diligence: 1 } },
    { text: 'mercenary', tier: 'default', hook: 'heat-bias: raises wealth goal priority', axisMods: { drive: 1, empathy: -1 } },
    { text: 'stubborn', tier: 'default', hook: 'gate: won\'t abandon current goal on failure', axisMods: { diligence: 1, drive: 1, composure: 1 } },
    { text: 'curious', tier: 'default', hook: 'goal-spawn: new information spawns investigate goal', axisMods: { drive: 1, boldness: 1 } },
    { text: 'territorial', tier: 'default', hook: 'gate: blocks voluntary retreat from home region', axisMods: { boldness: 1, empathy: -1 } },
    { text: 'paranoid', tier: 'default', hook: 'karma-mod: penalty on trust-dependent rolls', axisMods: { composure: -2, warmth: -1 } },
    { text: 'generous', tier: 'default', hook: 'heat-bias: raises altruistic goal priority', axisMods: { warmth: 1, empathy: 2 } },
    { text: 'secretive', tier: 'default', hook: 'gate: won\'t reveal hidden information voluntarily', axisMods: { warmth: -1, composure: 1 } },
    { text: 'pacifist', tier: 'default', hook: 'gate: blocks initiating violent actions', axisMods: { empathy: 2, boldness: -1 } },
    { text: 'romantic', tier: 'default', hook: 'heat-bias: raises courtship goal priority', axisMods: { warmth: 2, empathy: 1 } },
    { text: 'authoritarian', tier: 'default', hook: 'goal-spawn: power vacuum spawns dominate goal', axisMods: { drive: 1, empathy: -1, diligence: 1 } },
    { text: 'nomadic', tier: 'default', hook: 'heat-bias: raises relocation goal priority', axisMods: { drive: 1, diligence: -1 } },
    { text: 'ascetic', tier: 'default', hook: 'gate: blocks luxury and wealth-pursuit goals', axisMods: { diligence: 1, warmth: -1 } },
    { text: 'obsessive', tier: 'default', hook: 'heat-bias: doubles heat accumulation on current goal', axisMods: { drive: 2, composure: -1 } },
    { text: 'mistrustful', tier: 'default', hook: 'gate: won\'t accept aid from Hostile/Cold relations', axisMods: { warmth: -1, empathy: -1 } },
    { text: 'competitive', tier: 'default', hook: 'goal-spawn: peer success spawns rivalry goal', axisMods: { drive: 1, boldness: 1, empathy: -1 } },
    { text: 'xenophobic', tier: 'default', hook: 'gate: blocks cooperation with out-group factions', axisMods: { warmth: -2, empathy: -1 } },
    { text: 'pragmatic', tier: 'default', hook: 'karma-mod: bonus on partial-success outcome bands', axisMods: { composure: 1, empathy: -1 } },
    { text: 'oath-bound', tier: 'default', hook: 'gate: blocks actions violating sworn commitment', axisMods: { diligence: 2 } },
    { text: 'defiant', tier: 'default', hook: 'gate: blocks compliance with authority demands', axisMods: { boldness: 1, composure: -1 } },
    { text: 'opportunistic', tier: 'default', hook: 'goal-spawn: power shift spawns exploit goal', axisMods: { drive: 1, empathy: -1 } },
    { text: 'ritual-bound', tier: 'default', hook: 'gate: blocks major actions without completed routine', axisMods: { diligence: 2 } },
    { text: 'manipulative', tier: 'mature', hook: 'goal-spawn: detected weakness spawns exploit goal', axisMods: { empathy: -2, composure: 1 } },
    { text: 'possessive', tier: 'mature', hook: 'heat-bias: raises ownership/jealousy heat on Close relations', axisMods: { warmth: 1, empathy: -1, composure: -1 } },
    { text: 'fanatical', tier: 'mature', hook: 'goal-spawn: ideological trigger spawns convert/destroy goal', axisMods: { drive: 2, empathy: -1, composure: -1 } },
    { text: 'addictive', tier: 'mature', hook: 'gate: can\'t refuse vice actions; karma-mod penalty on self-control', axisMods: { drive: -1, composure: -2 } },
    { text: 'depraved', tier: 'mature', hook: 'gate: removes moral constraint gates from action pool', axisMods: { empathy: -2, composure: -1 } },
    { text: 'treacherous', tier: 'mature', hook: 'gate: can betray Close/Devoted without karma penalty', axisMods: { empathy: -2, warmth: -1 } },
    { text: 'extortionist', tier: 'mature', hook: 'goal-spawn: compromising information spawns leverage goal', axisMods: { empathy: -2, drive: 1 } },
    { text: 'corrupt', tier: 'mature', hook: 'heat-bias: raises illicit/underhanded goal priority', axisMods: { diligence: -2, empathy: -1 } }
]);

export const WANT_POOL: readonly WantEntry[] = Object.freeze([
    { text: 'eat', tier: 'default', kind: 'short' },
    { text: 'rest', tier: 'default', kind: 'short' },
    { text: 'groom', tier: 'default', kind: 'short' },
    { text: 'train casually', tier: 'default', kind: 'short' },
    { text: 'read', tier: 'default', kind: 'short' },
    { text: 'drink', tier: 'default', kind: 'short' },
    { text: 'wander', tier: 'default', kind: 'short' },
    { text: 'bathe', tier: 'default', kind: 'short' },
    { text: 'pray', tier: 'default', kind: 'short' },
    { text: 'forage', tier: 'default', kind: 'short' },
    { text: 'socialize casually', tier: 'default', kind: 'short' },
    { text: 'play a game', tier: 'default', kind: 'short' },
    { text: 'sunbathe', tier: 'default', kind: 'short' },
    { text: 'tidy', tier: 'default', kind: 'short' },
    { text: 'reminisce', tier: 'default', kind: 'short' },
    { text: 'daydream', tier: 'default', kind: 'short' },
    { text: 'smoke', tier: 'default', kind: 'short' },
    { text: 'snack', tier: 'default', kind: 'short' },
    { text: 'people-watch', tier: 'default', kind: 'short' },
    { text: 'collect curiosities', tier: 'default', kind: 'short' },
    { text: 'sketch', tier: 'default', kind: 'short' },
    { text: 'meditate', tier: 'default', kind: 'short' },
    { text: 'shop', tier: 'default', kind: 'short' },
    { text: 'master a skill', tier: 'default', kind: 'medium' },
    { text: 'win a contest', tier: 'default', kind: 'medium' },
    { text: 'earn wealth', tier: 'default', kind: 'medium' },
    { text: 'gain a mentor', tier: 'default', kind: 'medium' },
    { text: 'court a partner', tier: 'default', kind: 'medium' },
    { text: 'uncover a secret', tier: 'default', kind: 'medium' },
    { text: 'gain reputation', tier: 'default', kind: 'medium' },
    { text: 'protect someone', tier: 'default', kind: 'medium' },
    { text: 'settle a grudge', tier: 'default', kind: 'medium' },
    { text: 'find a home', tier: 'default', kind: 'medium' },
    { text: 'join a faction', tier: 'default', kind: 'medium' },
    { text: 'heal from trauma', tier: 'default', kind: 'medium' },
    { text: 'clear their name', tier: 'default', kind: 'medium' },
    { text: 'forge an alliance', tier: 'default', kind: 'medium' },
    { text: 'reclaim lost property', tier: 'default', kind: 'medium' },
    { text: 'craft a masterpiece', tier: 'default', kind: 'medium' },
    { text: 'escape a binding', tier: 'default', kind: 'medium' },
    { text: 'prove their worth', tier: 'default', kind: 'medium' },
    { text: 'secure a legacy', tier: 'default', kind: 'medium' },
    { text: 'find a lost person', tier: 'default', kind: 'medium' },
    { text: 'build a refuge', tier: 'default', kind: 'medium' },
    { text: 'win someone\'s trust', tier: 'default', kind: 'medium' },
    { text: 'lead a group', tier: 'default', kind: 'medium' },
    { text: 'cross a threshold', tier: 'default', kind: 'medium' },
    { text: 'restore a ruin', tier: 'default', kind: 'medium' },
    { text: 'blackmail a rival', tier: 'mature', kind: 'medium' },
    { text: 'seduce for leverage', tier: 'mature', kind: 'medium' },
    { text: 'eliminate a rival', tier: 'mature', kind: 'medium' },
    { text: 'corrupt an official', tier: 'mature', kind: 'medium' },
    { text: 'exploit a weakness', tier: 'mature', kind: 'medium' },
    { text: 'frame a rival', tier: 'mature', kind: 'medium' },
    { text: 'usurp a position', tier: 'mature', kind: 'medium' },
    { text: 'claim a consort', tier: 'mature', kind: 'medium' },
    { text: 'force a union', tier: 'mature', kind: 'medium' }
]);

export const ACTION_POOL: readonly ActionEntry[] = Object.freeze([
    { text: 'read', tier: 'default', context: 'peaceful' },
    { text: 'train', tier: 'default', context: 'peaceful' },
    { text: 'socialize', tier: 'default', context: 'peaceful' },
    { text: 'court', tier: 'default', context: 'peaceful' },
    { text: 'study', tier: 'default', context: 'peaceful' },
    { text: 'craft', tier: 'default', context: 'peaceful' },
    { text: 'travel', tier: 'default', context: 'peaceful' },
    { text: 'gossip', tier: 'default', context: 'peaceful' },
    { text: 'lounge', tier: 'default', context: 'peaceful' },
    { text: 'bathe', tier: 'default', context: 'peaceful' },
    { text: 'cook', tier: 'default', context: 'peaceful' },
    { text: 'garden', tier: 'default', context: 'peaceful' },
    { text: 'paint', tier: 'default', context: 'peaceful' },
    { text: 'sing', tier: 'default', context: 'peaceful' },
    { text: 'pray', tier: 'default', context: 'peaceful' },
    { text: 'meditate', tier: 'default', context: 'peaceful' },
    { text: 'shop', tier: 'default', context: 'peaceful' },
    { text: 'gamble', tier: 'default', context: 'peaceful' },
    { text: 'haggle', tier: 'default', context: 'peaceful' },
    { text: 'teach', tier: 'default', context: 'peaceful' },
    { text: 'heal', tier: 'default', context: 'peaceful' },
    { text: 'perform', tier: 'default', context: 'peaceful' },
    { text: 'compose', tier: 'default', context: 'peaceful' },
    { text: 'forage', tier: 'default', context: 'peaceful' },
    { text: 'dine', tier: 'default', context: 'peaceful' },
    { text: 'seduce', tier: 'mature', context: 'peaceful' },
    { text: 'coerce', tier: 'mature', context: 'peaceful' },
    { text: 'intimidate', tier: 'mature', context: 'peaceful' },
    { text: 'blackmail', tier: 'mature', context: 'peaceful' },
    { text: 'manipulate', tier: 'mature', context: 'peaceful' },
    { text: 'exploit trust', tier: 'mature', context: 'peaceful' },
    { text: 'scout', tier: 'default', context: 'dangerous' },
    { text: 'guard', tier: 'default', context: 'dangerous' },
    { text: 'tend-wounded', tier: 'default', context: 'dangerous' },
    { text: 'ration', tier: 'default', context: 'dangerous' },
    { text: 'rally', tier: 'default', context: 'dangerous' },
    { text: 'retreat', tier: 'default', context: 'dangerous' },
    { text: 'scheme', tier: 'default', context: 'dangerous' },
    { text: 'strike-first', tier: 'default', context: 'dangerous' },
    { text: 'betray', tier: 'default', context: 'dangerous' },
    { text: 'ambush', tier: 'default', context: 'dangerous' },
    { text: 'fortify', tier: 'default', context: 'dangerous' },
    { text: 'negotiate', tier: 'default', context: 'dangerous' },
    { text: 'scavenge', tier: 'default', context: 'dangerous' },
    { text: 'sabotage', tier: 'default', context: 'dangerous' },
    { text: 'evacuate', tier: 'default', context: 'dangerous' },
    { text: 'patrol', tier: 'default', context: 'dangerous' },
    { text: 'hold ground', tier: 'default', context: 'dangerous' },
    { text: 'disarm', tier: 'default', context: 'dangerous' },
    { text: 'rescue', tier: 'default', context: 'dangerous' },
    { text: 'torture', tier: 'mature', context: 'dangerous' },
    { text: 'kill-for-pleasure', tier: 'mature', context: 'dangerous' },
    { text: 'maim', tier: 'mature', context: 'dangerous' },
    { text: 'enslave', tier: 'mature', context: 'dangerous' },
    { text: 'terrorize', tier: 'mature', context: 'dangerous' }
]);

export const TRAIT_NAMES: readonly string[] = Object.freeze(TRAIT_VOCAB.map(t => t.text));
export const SHORT_WANTS: readonly WantEntry[] = Object.freeze(WANT_POOL.filter(w => w.kind === 'short'));
export const MEDIUM_WANTS: readonly WantEntry[] = Object.freeze(WANT_POOL.filter(w => w.kind === 'medium'));

// ---- NPC Generation Refit (Phase 2) — engine-built reaction menu (§9.1) ----
// `REACTION_VOCAB` is the authored table of short behavioural *moves* the story AI must pick
// from. GLM ships ~3 stubs so the build is green before FLASH 3.5 authors the full ~24–32
// entries (see 05_PHASE2_BUILD.md §B). Scoring/gating/sampling lives in reactionMenu.ts; the
// directive surfaces the result with a load-bearing enforcement clause
// (npcBehaviorDirective.ts). Gates reuse the trait-hook vocabulary so a loyal NPC can never
// be offered a jealousy/betrayal move (gate + low score = double exclusion).
export type ReactionGate  = {
    requireTraitAny?: string[];        // unconditional: NPC must have ≥1 (e.g. cruelty needs a cruel trait)
    forbidTraitAny?: string[];         // unconditional: NPC must have none (rare — use sparingly)
    forbidTraitWhenClose?: string[];   // RELATIONSHIP-scoped: block if NPC has any AND pcRelation >= RELATION_CLOSE
};
export type ReactionEntry = {
    text: string;                                   // the move, e.g. 'proud, understated approval'
    context: 'peaceful' | 'dangerous';              // reuse the ActionEntry context split
    tier: 'default' | 'mature';
    axisWeights: Partial<Record<HexAxis, number>>;  // PERSONALITY fit — dotted against NPC hex
    relationWeight?: number;                        // RELATIONSHIP fit — multiplied by pcRelation (-3..+3).
                                                    //   negative = surfaces at low/neutral trust, fades when liked
                                                    //   (betrayal/self-interest); positive = needs warmth (loyal support)
    traitKeys?: string[];                           // NPC has any → score bonus (bias, NOT a requirement)
    gate?: ReactionGate;
};

// Phase 2 §9.1 — Authored vocab (29 entries total, split across peaceful/dangerous).
// Covers the full spectrum including relationship-driven and personality-driven moves.
export const REACTION_VOCAB: readonly ReactionEntry[] = Object.freeze([
    // --- peaceful context ---
    { text: 'proud, understated approval', context: 'peaceful', tier: 'default',
      axisWeights: { warmth: 1, composure: 1 }, relationWeight: 1, traitKeys: ['protective', 'loyal'] },

    { text: 'withdraw and go quiet', context: 'peaceful', tier: 'default',
      axisWeights: { warmth: -1, boldness: -1 } },

    // relationship-driven ugly: surfaces for a neutral/new NPC, fades when liked, blocked for a close loyal ally
    { text: 'quietly sell you out', context: 'peaceful', tier: 'default',
      axisWeights: { empathy: -1 }, relationWeight: -2,
      traitKeys: ['scheming', 'mercenary', 'ambitious'], gate: { forbidTraitWhenClose: ['loyal'] } },

    // personality-driven ugly: trait-gated, relationship-independent
    { text: 'cruel taunt / twist the knife', context: 'peaceful', tier: 'mature',
      axisWeights: { empathy: -2, warmth: -1 }, gate: { requireTraitAny: ['sadistic'] } },

    { text: 'warm, encouraging praise', context: 'peaceful', tier: 'default',
      axisWeights: { warmth: 2, empathy: 1 }, relationWeight: 1, traitKeys: ['generous', 'romantic', 'loyal'] },

    { text: 'share a closely guarded secret', context: 'peaceful', tier: 'default',
      axisWeights: { warmth: 1, composure: -1 }, relationWeight: 2, traitKeys: ['secretive', 'loyal'],
      gate: { forbidTraitAny: ['mistrustful'] } },

    { text: 'demand immediate compensation / haggle', context: 'peaceful', tier: 'default',
      axisWeights: { drive: 1, empathy: -1 }, relationWeight: -1,
      traitKeys: ['mercenary', 'opportunistic'], gate: { forbidTraitWhenClose: ['loyal'] } },

    { text: 'suspicious interrogation / question motives', context: 'peaceful', tier: 'default',
      axisWeights: { composure: -1, warmth: -1 }, relationWeight: -1, traitKeys: ['paranoid', 'mistrustful'] },

    { text: 'mocking laughter / sarcastic remark', context: 'peaceful', tier: 'default',
      axisWeights: { warmth: -1, empathy: -1 }, traitKeys: ['jealous', 'competitive'] },

    { text: 'defiantly reject advice / double down', context: 'peaceful', tier: 'default',
      axisWeights: { boldness: 1, composure: -1 }, traitKeys: ['defiant', 'stubborn'] },

    { text: 'manipulative guilt-trip', context: 'peaceful', tier: 'mature',
      axisWeights: { empathy: -2, composure: 1 }, relationWeight: -2,
      traitKeys: ['manipulative', 'scheming', 'corrupt'], gate: { forbidTraitWhenClose: ['loyal'] } },

    { text: 'sadistic mockery / enjoy their discomfort', context: 'peaceful', tier: 'mature',
      axisWeights: { empathy: -2, composure: 1 }, gate: { requireTraitAny: ['sadistic', 'depraved'] } },

    { text: 'offer a generous gift / share resources', context: 'peaceful', tier: 'default',
      axisWeights: { warmth: 2, empathy: 2 }, relationWeight: 2, traitKeys: ['generous'] },

    { text: 'obsessive study / lose themselves in detail', context: 'peaceful', tier: 'default',
      axisWeights: { drive: 1, diligence: 2 }, traitKeys: ['obsessive', 'curious'] },

    { text: 'jealous sabotage', context: 'peaceful', tier: 'default',
      axisWeights: { empathy: -1, warmth: -1, diligence: -1 },
      traitKeys: ['jealous', 'vengeful'], gate: { forbidTraitAny: ['honorable'], forbidTraitWhenClose: ['loyal'] } },

    // --- dangerous context ---
    { text: 'reckless charge', context: 'dangerous', tier: 'default',
      axisWeights: { boldness: 2, composure: -1 }, traitKeys: ['impulsive', 'proud'] },

    { text: 'freeze / panic', context: 'dangerous', tier: 'default',
      axisWeights: { boldness: -2, composure: -2 }, traitKeys: ['cowardly'] },

    { text: 'quietly slip away / save own skin', context: 'dangerous', tier: 'default',
      axisWeights: { boldness: -2, empathy: -1 }, relationWeight: -2,
      traitKeys: ['cowardly', 'mercenary'], gate: { forbidTraitWhenClose: ['loyal'] } },

    { text: 'hold the line / stand firm', context: 'dangerous', tier: 'default',
      axisWeights: { composure: 2, boldness: 1 }, relationWeight: 1, traitKeys: ['stubborn', 'oath-bound'] },

    { text: 'shield the player / take the hit', context: 'dangerous', tier: 'default',
      axisWeights: { warmth: 1, empathy: 2, boldness: 1 }, relationWeight: 2, traitKeys: ['protective', 'loyal'] },

    { text: 'ruthless strike / eliminate the threat instantly', context: 'dangerous', tier: 'mature',
      axisWeights: { empathy: -2, diligence: 1 }, gate: { requireTraitAny: ['ruthless', 'bloodthirsty'] } },

    { text: 'sadistic mutilation / lingering strike', context: 'dangerous', tier: 'mature',
      axisWeights: { empathy: -2, composure: -1 }, gate: { requireTraitAny: ['sadistic', 'bloodthirsty'] } },

    { text: 'hysterical laughter / blood-crazed frenzy', context: 'dangerous', tier: 'mature',
      axisWeights: { composure: -2, empathy: -2 }, gate: { requireTraitAny: ['bloodthirsty', 'fanatical'] } },

    { text: 'blame-shift / point fingers at player', context: 'dangerous', tier: 'default',
      axisWeights: { composure: -1, empathy: -1 }, relationWeight: -2,
      traitKeys: ['paranoid', 'jealous', 'cowardly'], gate: { forbidTraitWhenClose: ['loyal', 'honorable'] } },

    { text: 'devoted sacrifice / fight to the death', context: 'dangerous', tier: 'default',
      axisWeights: { boldness: 2, diligence: 1 }, relationWeight: 3, traitKeys: ['loyal', 'fanatical'] },

    { text: 'opportunistic side-switch / surrender', context: 'dangerous', tier: 'default',
      axisWeights: { boldness: -1, empathy: -1 }, relationWeight: -3,
      traitKeys: ['opportunistic', 'mercenary', 'treacherous'], gate: { forbidTraitWhenClose: ['loyal'] } },

    { text: 'paranoid accusation / prepare for double-cross', context: 'dangerous', tier: 'default',
      axisWeights: { composure: -2, warmth: -1 }, relationWeight: -1, traitKeys: ['paranoid', 'mistrustful'] },

    { text: 'pragmatic retreat / call for tactical fallback', context: 'dangerous', tier: 'default',
      axisWeights: { composure: 2, boldness: -1 }, traitKeys: ['pragmatic', 'nomadic'] },

    { text: 'extortionist leverage / demand help or perish', context: 'dangerous', tier: 'mature',
      axisWeights: { empathy: -2, drive: 1 }, relationWeight: -2,
      traitKeys: ['extortionist', 'ruthless', 'scheming'], gate: { forbidTraitWhenClose: ['loyal'] } }
]);
