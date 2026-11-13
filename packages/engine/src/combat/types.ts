export type AbilityKey = 'STR' | 'DEX' | 'CON' | 'INT' | 'WIS' | 'CHA';

export type AbilityScores = Record<AbilityKey, number>;

export type CombatTier = 'minion' | 'grunt' | 'elite' | 'boss' | 'legendary';

export type Archetype = 'bulwark' | 'assassin' | 'caster' | 'skirmisher' | 'brute';

export type PointBudget = 'NORMAL' | 'OP';

export type CombatSheet = {
    abilities: AbilityScores;
    budget: PointBudget;
    archetype?: Archetype;
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

export type CombatantStatus = 'up' | 'down' | 'fled' | 'surrendered';

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

export type TurnState = { actorId: string; moveLeft: number; actionUsed: boolean };

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
    abilities: AbilityScores;
    maxHp: number;
    hp: number;
    ac: number;
    attackBonus: number;
    damage: DamageSpec;
    initiative: number;
    status: CombatantStatus;
    conditions: { id: string; rounds: number }[];
    position?: Pos;
    range?: AttackRange;
    speed?: number;
    weaknesses?: string[];
    resistances?: string[];
};

export type CombatOutcome = 'victory' | 'defeat' | 'fled' | 'truce' | 'aborted';

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
};

export type CombatAction =
    | { type: 'attack'; actorId: string; targetId: string }
    | { type: 'defend'; actorId: string }
    | { type: 'move'; actorId: string; to: Pos }
    | { type: 'end_turn'; actorId: string };

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
};
