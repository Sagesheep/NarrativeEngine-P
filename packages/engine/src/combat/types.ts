export type AbilityKey = 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA';

export type AbilityScores = Record<AbilityKey, number>;

export type CombatTier = 'minion' | 'grunt' | 'elite' | 'boss' | 'legendary';

export type Archetype = 'bulwark' | 'assassin' | 'caster' | 'skirmisher' | 'brute';

export type PointBudget = 'NORMAL' | 'OP';

export type CombatSheet = {
    abilities: AbilityScores;
    budget: PointBudget;
    archetype?: Archetype;
    castingAbility?: AbilityKey;
    level: number;
    needsAllocation: boolean;
};

export type DerivedSheet = {
    maxHp: number;
    ac: number;
    proficiency: number;
    initiativeMod: number;
};

export type Rng = {
    readonly seed: number;
    readonly cursor: number;
    next(): number;
    int(min: number, max: number): number;
    roll(sides: number): number;
};

export type Side = 'player' | 'ally' | 'enemy' | 'neutral';

export type Controller = 'player' | 'engine';

export type CombatantStatus = 'up' | 'down' | 'fled' | 'surrendered' | 'gone' | 'escaped';

export type DamageSpec = { count: number; sides: number; bonus: number; type: string };

export type AttackRange = 'close' | 'reach' | 'ranged';

export type Tile = 'floor' | 'wall' | 'cover' | 'difficult' | 'hazard';

export type AreaType = 'open' | 'scattered' | 'room' | 'rows' | 'corridors'
    | 'cavern' | 'street' | 'ledge' | 'ruins' | 'wetland';

export type MapDensity = 'sparse' | 'normal' | 'dense';

export type HazardKind = 'none' | 'fire' | 'deep_water' | 'electric' | 'toxic' | 'pit';

export type TerrainLabels = { wall?: string; cover?: string; difficult?: string; hazard?: string };

export type Grid = {
    width: number;
    height: number;
    tiles: Tile[];
    theme?: string;
    hazardType?: string;
    area?: AreaType;
    labels?: TerrainLabels;
};

export type Pos = { x: number; y: number };

export type MapSize = 'small' | 'medium' | 'large';

export type MapSpec = {
    area?: AreaType;
    density?: MapDensity;
    hazard?: HazardKind;
    labels?: TerrainLabels;
    size?: MapSize;
    place?: string;
};

export type ResolvedMapSpec = {
    area: AreaType;
    density: MapDensity;
    hazard: HazardKind;
    labels: Required<TerrainLabels>;
    size: MapSize;
    place?: string;
};

export type TurnState = { actorId: string; moveLeft: number; actionUsed: boolean; bonusUsed?: boolean; extraActions?: number; dashed?: boolean };

export type FormId = 'touch' | 'projectile' | 'self' | 'line' | 'cone' | 'burst' | 'dash';

export type EffectId = 'damage' | 'heal' | 'shield' | 'push' | 'pull' | 'stun' | 'slow'
    | 'haste' | 'blink' | 'swap' | 'barrier' | 'drain' | 'summon' | 'weapon' | 'guard' | 'sprint' | 'leap' | 'rally' | 'hurl';

export type AugmentId = 'amplify' | 'widen' | 'extend' | 'pierce' | 'split' | 'quicken';

export type BuiltinKind = 'attack' | 'defend' | 'dash' | 'shove' | 'jump' | 'throw' | 'help' | 'stunt';

export type StuntCheckProfile = { ability: AbilityKey; dc: number };

export type BuiltinProfile = {
    kind: BuiltinKind;
    events?: 'compact';
    range?: AttackRange;
    slot?: 'action' | 'bonus';
    check?: StuntCheckProfile;
};

export type StuntOutcome = 'hurt' | 'push' | 'pull' | 'slow' | 'stun' | 'move' | 'cover' | 'hurt_area';

export type StuntDifficulty = 'easy' | 'moderate' | 'hard' | 'very_hard' | 'impossible';

export type StuntPart = {
    outcome: StuntOutcome;
    difficulty: StuntDifficulty;
    targetId?: string;
    at?: Pos;
    tiles?: Pos[];
    damageType?: string;
};

export type StuntSpec = { ability: AbilityKey; parts: StuntPart[] };

export type GlyphAbility = {
    id: string;
    name: string;
    description?: string;
    damageType?: string;
    form: { id: FormId; augments: AugmentId[] };
    effects: { id: EffectId; augments: AugmentId[] }[];
    source: 'player' | 'ai' | 'preset';
    builtin?: BuiltinProfile;
};

export type CombatCondition = {
    id: string;
    rounds?: number;
    turns?: number;
    appliedTurn?: number;
    sourceId?: string;
};

export type Barrier = { pos: Pos; expiresRound: number; sourceId: string };

export type TerrainEdit = { pos: Pos; tile: Tile };

export type CarriedItem = { id: string; name: string; count: number; sides: number; damageType?: string; equipped?: boolean };

export type WeaponFields = { damage: DamageSpec; weaponName?: string; range?: AttackRange };

export type FieldItem = CarriedItem & { pos: Pos; ownerId: string; armed?: WeaponFields };

export type ThrowPayload =
    | { kind: 'creature'; id: string }
    | { kind: 'cover'; at: Pos }
    | { kind: 'item'; itemId: string }
    | { kind: 'hand' };

export type Speech = 'speaks' | 'sounds' | 'silent';

export type Tactic = 'aggressive' | 'skirmisher' | 'guard' | 'hunter' | 'coward' | 'berserker' | 'support';

export type PlanIntentKind = 'attack' | 'support' | 'reposition' | 'retreat' | 'guard' | 'control';

export type PlanIntent = { kind: PlanIntentKind; targetId?: string; destination?: Pos };

export type TurnPlan = { actorId: string; tactic: Tactic; steps: CombatAction[]; intent: PlanIntent };

export type OrderKind = 'focus' | 'protect' | 'hold' | 'fall_back' | 'press' | 'signature' | 'switch_tactic';

export type CombatOrder = { kind: OrderKind; targetId?: string; tactic?: Tactic; round: number };

export type Signature = { abilityId: string; usesLeft: number };

export type SignatureEffectSpec = { id: EffectId; augments?: AugmentId[] };

export type SignatureSpec = {
    name: string;
    damageType?: string;
    form: FormId;
    augments?: AugmentId[];
    effects: SignatureEffectSpec[];
};

export type SignatureRepairCode =
    | 'no_budget' | 'unknown_glyph' | 'unusable_effect' | 'trimmed' | 'invalid_dropped' | 'over_budget_dropped' | 'name_defaulted';

export type SignatureRepair = { unitId: string; unitName: string; code: SignatureRepairCode; text: string; from?: unknown; to?: unknown };

export type DirectorOrder = { unitId: string; kind: string; targetId?: string; tactic?: string; line?: string };

export type OrderRejectReason =
    | 'fight_over' | 'unknown_unit' | 'not_standing' | 'not_directed' | 'unknown_kind' | 'missing_target' | 'unknown_target'
    | 'target_not_standing' | 'target_not_opponent' | 'target_not_ally' | 'target_is_self' | 'no_signature' | 'no_uses_left'
    | 'unknown_tactic' | 'duplicate' | 'already_acted';

export type OrderRejection = { unitId: string; kind: string; reason: OrderRejectReason; text: string };

export type Combatant = {
    id: string;
    name: string;
    side: Side;
    controller: Controller;
    tier: CombatTier;
    archetype?: Archetype;
    npcId?: string;
    species?: string;
    look?: string;
    manner?: string;
    speech?: Speech;
    tactic?: Tactic;
    weaponName?: string;
    abilities: AbilityScores;
    maxHp: number;
    hp: number;
    ac: number;
    attackBonus: number;
    damage: DamageSpec;
    initiative: number;
    status: CombatantStatus;
    conditions: CombatCondition[];
    position?: Pos;
    range?: AttackRange;
    speed?: number;
    weaknesses?: string[];
    resistances?: string[];
    kit?: GlyphAbility[];
    mp?: number;
    maxMp?: number;
    tempHp?: number;
    cooldowns?: Record<string, number>;
    proficiency?: number;
    castingAbility?: AbilityKey;
    abilityDamage?: Omit<DamageSpec, 'type'>;
    carried?: CarriedItem[];
    summonerId?: string;
    summonSeq?: number;
    expiresRound?: number;
    stunGuard?: boolean;
    startHp?: number;
    moraleRolled?: boolean;
    routed?: boolean;
    mark?: ObjectiveMark;
    directed?: boolean;
    order?: CombatOrder;
    signature?: Signature;
};

export type ObjectiveMark = 'leader' | 'ward' | 'bystander';

export type WinKind = 'rout' | 'defeat_leader' | 'survive' | 'escape' | 'protect' | 'seize';

export type LoseKind = 'pc_falls' | 'ward_falls' | 'round_limit' | 'leader_escapes';

export type SideKind = 'within_rounds' | 'no_one_falls' | 'save_bystander' | 'reach_tile';

export type PairedWin =
    | { kind: 'rout' }
    | { kind: 'defeat_leader'; leaderId: string }
    | { kind: 'survive'; rounds: number }
    | { kind: 'escape'; exits: Pos[]; everyone: boolean }
    | { kind: 'seize'; tile: Pos };

export type WinCondition = PairedWin | { kind: 'protect'; wardId: string; rounds?: number; with?: PairedWin };

export type LoseCondition =
    | { kind: 'pc_falls' }
    | { kind: 'ward_falls'; wardId: string }
    | { kind: 'round_limit' }
    | { kind: 'leader_escapes'; leaderId: string; exits: Pos[] };

export type SideObjective =
    | { kind: 'within_rounds'; rounds: number }
    | { kind: 'no_one_falls' }
    | { kind: 'save_bystander'; bystanderId: string }
    | { kind: 'reach_tile'; tile: Pos };

export type ObjectiveProgress = {
    escaped?: string[];
    holderId?: string;
    reachedBy?: string;
    someoneFell?: boolean;
};

export type ObjectiveEndReason = WinKind | LoseKind | 'defeat' | 'fled' | 'parley' | 'conceded' | 'abandoned';

export type ObjectiveResult = {
    status: 'won' | 'lost' | 'ended';
    by: ObjectiveEndReason;
    round: number;
    outcome: CombatOutcome;
    parleyIntent?: ParleyIntent;
    side?: { kind: SideKind; met: boolean };
};

export type CombatObjective = {
    win: WinCondition;
    lose?: LoseCondition[];
    side?: SideObjective;
    roundLimit?: number;
    progress?: ObjectiveProgress;
    result?: ObjectiveResult;
};

export type ObjectiveRequest = {
    win: string;
    with?: string;
    leader?: string;
    ward?: string;
    bystander?: string;
    rounds?: number;
    everyone?: boolean;
    lose?: string[];
    side?: string;
    sideRounds?: number;
    roundLimit?: number;
    exits?: Pos[];
    seize?: Pos;
    reach?: Pos;
    leaderExits?: Pos[];
};

export type RepairCode =
    | 'unknown_kind' | 'missing_unit' | 'wrong_side' | 'picked_leader' | 'tile_moved' | 'no_tile' | 'clamped'
    | 'round_limit_raised' | 'round_limit_added' | 'lose_dropped' | 'lose_added' | 'side_dropped' | 'fallback_rout'
    | 'reinforcements_trimmed' | 'reinforcements_dropped' | 'trigger_changed';

export type ObjectiveRepair = { field: string; code: RepairCode; text: string; from?: unknown; to?: unknown };

export type ReinforcementEdge = 'far' | 'near' | 'flank';

export type ReinforcementLevel = 'none' | 'some' | 'many';

export type ReinforcementTrigger =
    | { kind: 'round'; round: number }
    | { kind: 'leader_half'; leaderId: string }
    | { kind: 'tile'; tiles: Pos[] };

export type ReinforcementWaveRequest = {
    round?: number;
    trigger?: 'leader_half' | 'tile';
    edge?: ReinforcementEdge;
    combatants: CombatantSpec[];
};

export type ReinforcementRequest = ReinforcementLevel | { waves: ReinforcementWaveRequest[] };

export type ReinforcementWave = {
    id: string;
    trigger: ReinforcementTrigger;
    edge: ReinforcementEdge;
    units: Combatant[];
    arriveRound?: number;
    tiles?: Pos[];
    arrived?: string[];
    done?: boolean;
};

export type ReinforcementBook = { budget: number; waves: ReinforcementWave[] };

export type ObjectiveReport = {
    objective: CombatObjective;
    reinforcements?: ReinforcementBook;
    repairs: ObjectiveRepair[];
};

export type CombatOutcome = 'victory' | 'defeat' | 'fled' | 'truce' | 'aborted';

export type PartyControl = 'solo' | 'engine' | 'player';

export type DefeatMode = 'knockout' | 'hardcore' | 'ironman';

export type Team = 'party' | 'enemy';

export type ParleyIntent = 'ceasefire' | 'let_go' | 'surrender_demand' | 'bargain' | 'taunt' | 'other';

export type ParleyRating = 'hopeless' | 'hard' | 'even' | 'easy';

export type ParleyEffect = 'none' | 'failed' | 'truce' | 'let_go' | 'surrender';

export type ParleyRecord = {
    attemptId?: string;
    round: number;
    turn: number;
    actorId: string;
    speakerId?: string;
    intent: ParleyIntent;
    rating: ParleyRating;
    dc?: number;
    natural?: number;
    total?: number;
    success: boolean;
    effect: ParleyEffect;
};

export type FateRecord = {
    pcId: string;
    mode: Exclude<DefeatMode, 'knockout'>;
    natural?: number;
    dies: boolean;
};

export type MoraleBook = {
    startHp: Record<Team, number>;
    leaders: Partial<Record<Team, string>>;
};

export type CombatEnding = {
    conceded?: boolean;
    abandoned?: boolean;
    carried?: boolean;
    parleyIntent?: ParleyIntent;
};

export type CombatState = {
    id: string;
    round: number;
    order: string[];
    turnIndex: number;
    combatants: Record<string, Combatant>;
    rngSeed: number;
    rngCursor: number;
    eventSeq: number;
    outcome: null | CombatOutcome;
    grid?: Grid;
    mapSeed?: number;
    mapVersion?: number;
    turn?: TurnState;
    turnCount?: number;
    barriers?: Barrier[];
    terrainEdits?: TerrainEdit[];
    fieldItems?: FieldItem[];
    nextSummon?: number;
    maxSummons?: number;
    partyControl?: PartyControl;
    defeatMode?: DefeatMode;
    morale?: MoraleBook;
    turnStart?: { actorId: string; pos: Pos };
    parleys?: ParleyRecord[];
    fate?: FateRecord;
    ending?: CombatEnding;
    objective?: CombatObjective;
    reinforcements?: ReinforcementBook;
};

export type CombatAction =
    | { type: 'attack'; actorId: string; targetId: string }
    | { type: 'defend'; actorId: string }
    | { type: 'move'; actorId: string; to: Pos }
    | { type: 'end_turn'; actorId: string }
    | { type: 'use_ability'; actorId: string; abilityId: string; aim?: Pos | null; payload?: ThrowPayload }
    | { type: 'flee'; actorId: string }
    | { type: 'abandon'; actorId: string }
    | { type: 'parley'; actorId: string; intent: ParleyIntent; rating: ParleyRating; speakerId?: string; attemptId?: string }
    | { type: 'stunt'; actorId: string; spec: StuntSpec };

export type CombatEvent = {
    seq: number;
    round: number;
    turn?: number;
    type: string;
    actorId?: string;
    targetId?: string;
    data: Record<string, unknown>;
    text: string;
};

export type TierBlock = {
    abilities: AbilityScores;
    maxHp: number;
    ac: number;
    attackBonus: number;
    damage: DamageSpec;
};

export type CombatantSpec = {
    id?: string;
    name: string;
    side: Exclude<Side, 'player'>;
    tier: CombatTier;
    archetype?: Archetype;
    npcId?: string;
    species?: string;
    look?: string;
    manner?: string;
    speech?: Speech;
    tactic?: Tactic;
    range?: AttackRange;
    template?: TemplateOverlay;
    directed?: boolean;
    signature?: SignatureSpec;
};

export type TemplateOverlay = {
    mode: 'replace' | 'floor';
    maxHp?: number;
    ac?: number;
    attackBonus?: number;
    damage?: Omit<DamageSpec, 'type'>;
    weaknesses?: string[];
    resistances?: string[];
};

export type CombatSpec = {
    id: string;
    combatants: CombatantSpec[];
    jitterRange?: number;
    map?: MapSpec;
    mapSeed?: number;
    mapVersion?: number;
    maxSummons?: number;
    partyControl?: PartyControl;
    defeatMode?: DefeatMode;
    objective?: ObjectiveRequest;
    reinforcements?: ReinforcementRequest;
};

export type WeaponQuality = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export type PcWeapon = {
    name?: string;
    quality?: WeaponQuality;
    scalingStat?: AbilityKey;
    damageType?: string;
    range?: AttackRange;
};

export type PcCombatantInput = {
    id?: string;
    name: string;
    sheet: CombatSheet;
    hpCurrent?: number;
    weapon?: PcWeapon | null;
    defaultWeaponDie?: number;
    look?: string;
    kit?: GlyphAbility[];
    mpCurrent?: number;
    items?: PcCarriedInput[];
};

export type PcCarriedInput = {
    id: string;
    name: string;
    quality?: WeaponQuality;
    damageType?: string;
    equipped?: boolean;
    throwable?: boolean;
};
