// ─── PC Creation Script (desktop port) ──────────────────────────────────────
// Point-buy math + archetype presets + creation questionnaire. Adapted from the
// mobile app's services/engine/pcCreationScript.ts. Combat-engine dependencies
// (combatEngine.ts) are inlined here so this module is self-contained on desktop;
// the combat-stat block (VIT/PWR/RES/FOC/SPD/WIL) lives in CharacterProfile.stats,
// NOT on NPCEntry (combat integration is Phase 7's domain).

export type CombatTier = 'minion' | 'grunt' | 'elite' | 'boss' | 'legendary';
export type Archetype = 'bulwark' | 'assassin' | 'caster' | 'skirmisher' | 'brute';
export type StatBlock = {
    VIT: number;
    PWR: number;
    RES: number;
    FOC: number;
    SPD: number;
    WIL: number;
};

// ─── Point-buy budget tables ──────────────────────────────────────────────────

export const PC_POINT_BUY: {
    NORMAL: { totalPoints: number; min: number; max: number; tier: CombatTier };
    OP: { totalPoints: number; min: number; max: number; tier: CombatTier };
} = {
    NORMAL: { totalPoints: 27, min: 8, max: 15, tier: 'grunt' },
    OP: { totalPoints: 37, min: 8, max: 20, tier: 'elite' },
};

export const STAT_KEYS = ['VIT', 'PWR', 'RES', 'FOC', 'SPD', 'WIL'] as const;
export type StatKey = typeof STAT_KEYS[number];

// ─── Point-buy cost table (D&D 5e standard) ───────────────────────────────────

const POINT_BUY_COST: Record<number, number> = {
    8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9,
};

const OP_POINT_BUY_COST: Record<number, number> = {
    8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9, 16: 11, 17: 13, 18: 15, 19: 17, 20: 19,
};

export function getPointCost(value: number, budget: 'NORMAL' | 'OP'): number {
    if (budget === 'OP') return OP_POINT_BUY_COST[value] ?? 99;
    return POINT_BUY_COST[value] ?? 99;
}

// ─── Derived stat preview (inlined from combatEngine so this module is standalone) ──

const COMBAT_TIER_LEVEL_BANDS: Record<CombatTier, number> = {
    minion: 1, grunt: 3, elite: 6, boss: 10, legendary: 15,
};

function proficiencyBonusForTier(tier: CombatTier): number {
    const level = COMBAT_TIER_LEVEL_BANDS[tier];
    if (level <= 4) return 2;
    if (level <= 8) return 3;
    if (level <= 12) return 4;
    if (level <= 16) return 5;
    return 6;
}

function abilityMod(score: number): number {
    return Math.floor((score - 10) / 2);
}

function computeAC(resScore: number): number {
    return 10 + abilityMod(resScore);
}

function computeMaxHP(tier: CombatTier, vitScore: number): number {
    const level = COMBAT_TIER_LEVEL_BANDS[tier];
    const vitMod = abilityMod(vitScore);
    return 6 + vitMod * 4 + level * 2;
}

function computeMaxFOC(tier: CombatTier, wilScore: number): number {
    const level = COMBAT_TIER_LEVEL_BANDS[tier];
    const wilMod = abilityMod(wilScore);
    return 2 + wilMod + 2 * level;
}

export type DerivedPreview = {
    hp: number;
    foc: number;
    ac: number;
    proficiency: number;
};

export function computePCDerived(stats: StatBlock, budget: 'NORMAL' | 'OP'): DerivedPreview {
    const tier = PC_POINT_BUY[budget].tier;
    return {
        hp: computeMaxHP(tier, stats.VIT),
        foc: computeMaxFOC(tier, stats.WIL),
        ac: computeAC(stats.RES),
        proficiency: proficiencyBonusForTier(tier),
    };
}

// ─── Point-buy allocation logic ───────────────────────────────────────────────

export type PointBuyAllocation = {
    stats: StatBlock;
    budget: 'NORMAL' | 'OP';
    pointsSpent: number;
    pointsRemaining: number;
    isValid: boolean;
};

export const DEFAULT_STATS: StatBlock = { VIT: 8, PWR: 8, RES: 8, FOC: 8, SPD: 8, WIL: 8 };

export function validateAllocation(stats: StatBlock, budget: 'NORMAL' | 'OP'): PointBuyAllocation {
    const cfg = PC_POINT_BUY[budget];
    let pointsSpent = 0;
    let isValid = true;

    for (const key of STAT_KEYS) {
        const val = stats[key];
        if (val < cfg.min || val > cfg.max) {
            isValid = false;
        }
        pointsSpent += getPointCost(val, budget);
    }

    if (pointsSpent > cfg.totalPoints) isValid = false;

    return {
        stats,
        budget,
        pointsSpent,
        pointsRemaining: cfg.totalPoints - pointsSpent,
        isValid,
    };
}

export function allocateStat(
    current: StatBlock,
    key: StatKey,
    value: number,
    budget: 'NORMAL' | 'OP',
): StatBlock {
    const cfg = PC_POINT_BUY[budget];
    const clamped = Math.max(cfg.min, Math.min(cfg.max, value));
    return { ...current, [key]: clamped };
}

// ─── Quick-allocate presets ────────────────────────────────────────────────────

export const ARCHETYPE_PRESETS: Record<Archetype, StatBlock> = {
    bulwark:   { VIT: 15, PWR: 10, RES: 14, FOC:  8, SPD:  8, WIL: 10 },
    assassin:  { VIT: 10, PWR: 13, RES: 10, FOC: 10, SPD: 15, WIL: 11 },
    caster:    { VIT:  8, PWR:  8, RES: 10, FOC: 15, SPD: 10, WIL: 14 },
    skirmisher:{ VIT: 12, PWR: 11, RES: 10, FOC: 10, SPD: 14, WIL: 10 },
    brute:     { VIT: 14, PWR: 15, RES: 10, FOC:  8, SPD: 10, WIL:  8 },
};

// ─── Creation question script (engine-static, no LLM) ──────────────────────────

export type CreationQuestion = {
    id: string;
    prompt: string;
    field: string;
    type: 'text' | 'textarea' | 'select';
    options?: string[];
    required: boolean;
};

export const CREATION_QUESTIONS: CreationQuestion[] = [
    { id: 'name', prompt: 'What is your character\'s name?', field: 'name', type: 'text', required: true },
    { id: 'concept', prompt: 'Describe your character\'s concept or background in a sentence or two.', field: 'concept', type: 'textarea', required: true },
    { id: 'playstyle', prompt: 'How do you prefer to approach challenges?', field: 'playstyle', type: 'select', options: ['Stand firm and protect allies (Bulwark)', 'Strike from shadows with precision (Assassin)', 'Wield arcane power from range (Caster)', 'Move fast and adapt (Skirmisher)', 'Overwhelm with raw force (Brute)'], required: true },
    { id: 'voice', prompt: 'How does your character speak? (Accent, vocabulary, verbal quirks)', field: 'voice', type: 'textarea', required: false },
    { id: 'drives', prompt: 'What drives your character? What do they want most?', field: 'drives', type: 'textarea', required: false },
    { id: 'archetype', prompt: 'Choose your combat archetype:', field: 'archetype', type: 'select', options: ['bulwark', 'assassin', 'caster', 'skirmisher', 'brute'], required: true },
];

// ─── OP toggle ────────────────────────────────────────────────────────────────

export function getPCTier(isOP: boolean): CombatTier {
    return PC_POINT_BUY[isOP ? 'OP' : 'NORMAL'].tier;
}

export function getPCBudget(isOP: boolean): 'NORMAL' | 'OP' {
    return isOP ? 'OP' : 'NORMAL';
}

// ─── Build character profile text for [CHARACTER PROFILE] block ─────────────────

export function buildCharacterProfileText(entry: {
    name: string;
    concept?: string;
    playstyle?: string;
    voice?: string;
    drives?: string;
    stats: StatBlock;
    archetype: Archetype;
    isOP: boolean;
}): string {
    const tier = getPCTier(entry.isOP);
    const preview = computePCDerived(entry.stats, entry.isOP ? 'OP' : 'NORMAL');
    const lines: string[] = [
        `**${entry.name}**`,
        `Archetype: ${entry.archetype} | Tier: ${tier}`,
        `HP: ${preview.hp} | FOC: ${preview.foc} | AC: ${preview.ac} | Proficiency: +${preview.proficiency}`,
        `VIT ${entry.stats.VIT} | PWR ${entry.stats.PWR} | RES ${entry.stats.RES} | FOC ${entry.stats.FOC} | SPD ${entry.stats.SPD} | WIL ${entry.stats.WIL}`,
    ];
    if (entry.concept) lines.push(`Concept: ${entry.concept}`);
    if (entry.playstyle) lines.push(`Playstyle: ${entry.playstyle}`);
    if (entry.voice) lines.push(`Voice: ${entry.voice}`);
    if (entry.drives) lines.push(`Drives: ${entry.drives}`);
    return lines.join('\n');
}

/** Build a desktop CharacterProfile-shaped object from the wizard's answers + stats. */
export function buildCharacterProfileData(entry: {
    name: string;
    stats: StatBlock;
    archetype: Archetype;
    isOP: boolean;
    concept?: string;
}): import('../../types').CharacterProfile {
    const preview = computePCDerived(entry.stats, entry.isOP ? 'OP' : 'NORMAL');
    return {
        name: entry.name,
        race: '',
        class: entry.archetype,
        level: 1,
        hp: { current: preview.hp, max: preview.hp },
        stats: {
            VIT: entry.stats.VIT,
            PWR: entry.stats.PWR,
            RES: entry.stats.RES,
            FOC: entry.stats.FOC,
            SPD: entry.stats.SPD,
            WIL: entry.stats.WIL,
            AC: preview.ac,
            Proficiency: preview.proficiency,
        },
        skills: [],
        abilities: [],
        traits: entry.concept ? [entry.concept] : [],
        notes: '',
    };
}