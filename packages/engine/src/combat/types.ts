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

export type CombatantStatus = 'up' | 'down' | 'fled' | 'surrendered' | 'gone';

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

export type TurnState = { actorId: string; moveLeft: number; actionUsed: boolean; bonusUsed?: boolean; extraActions?: number };

export type FormId = 'touch' | 'projectile' | 'self' | 'line' | 'cone' | 'burst' | 'dash';

export type EffectId = 'damage' | 'heal' | 'shield' | 'push' | 'pull' | 'stun' | 'slow'
    | 'haste' | 'blink' | 'swap' | 'barrier' | 'drain' | 'summon';

export type AugmentId = 'amplify' | 'widen' | 'extend' | 'pierce' | 'split' | 'quicken';

export type GlyphAbility = {
    id: string;
    name: string;
    description?: string;
    damageType?: string;
    form: { id: FormId; augments: AugmentId[] };
    effects: { id: EffectId; augments: AugmentId[] }[];
    source: 'player' | 'ai' | 'preset';
};

export type CombatCondition = {
    id: string;
    rounds?: number;
    turns?: number;
    appliedTurn?: number;
    sourceId?: string;
};

export type Barrier = { pos: Pos; expiresRound: number; sourceId: string };

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
    summonerId?: string;
    summonSeq?: number;
    expiresRound?: number;
    stunGuard?: boolean;
    startHp?: number;
    moraleRolled?: boolean;
    routed?: boolean;
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
    turn?: TurnState;
    turnCount?: number;
    barriers?: Barrier[];
    nextSummon?: number;
    maxSummons?: number;
    partyControl?: PartyControl;
    defeatMode?: DefeatMode;
    morale?: MoraleBook;
    turnStart?: { actorId: string; pos: Pos };
    parleys?: ParleyRecord[];
    fate?: FateRecord;
    ending?: CombatEnding;
};

export type CombatAction =
    | { type: 'attack'; actorId: string; targetId: string }
    | { type: 'defend'; actorId: string }
    | { type: 'move'; actorId: string; to: Pos }
    | { type: 'end_turn'; actorId: string }
    | { type: 'use_ability'; actorId: string; abilityId: string; aim?: Pos | null }
    | { type: 'flee'; actorId: string }
    | { type: 'abandon'; actorId: string }
    | { type: 'parley'; actorId: string; intent: ParleyIntent; rating: ParleyRating; speakerId?: string; attemptId?: string };

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
    range?: AttackRange;
    template?: TemplateOverlay;
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
    maxSummons?: number;
    partyControl?: PartyControl;
    defeatMode?: DefeatMode;
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
};
