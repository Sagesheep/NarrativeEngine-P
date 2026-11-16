import type { GameContext, LoreChunk, DiceSystemConfig, DieType, InventoryProposal, NPCEntry } from '../../types';
import { parseCombatArgs, type ParsedCombatArgs } from '../combat/combatProposal';
import { objectiveToolNotes } from '../combat/combatObjective';
import { ABILITY_ONE_AT_A_TIME, PROPOSE_ABILITY_TOOL_RESULT, parseAbilityArgs, rejectionText } from '../combat/abilityProposalArgs';
import { AUGMENT_IDS, EFFECT_IDS, FORM_IDS } from '@narrative/engine';
import type { AbilityLimits, GlyphAbility } from '@narrative/engine';
import { searchLoreByQuery } from '../lore/loreRetriever';
import { uid } from '../../utils/uid';
import { mapTier } from '../engine/diceTier';

// ── Constants ─────────────────────────────────────────────────────────
const MAX_NOTEBOOK_OPS = 5;
const MAX_NOTEBOOK_NOTES = 50;

// ── Types ─────────────────────────────────────────────────────────────

export type ToolContext = {
    loreChunks: LoreChunk[];
    notebook: GameContext['notebook'];
};

export type LoreHandlerResult = {
    toolResult: string;
};

export type NotebookHandlerResult = {
    toolResult: string;
    updatedNotebook: GameContext['notebook'];
};

export type DiceHandlerResult = {
    toolResult: string;
};

export type ProposeInventoryHandlerResult = {
    toolResult: string;
    proposal: InventoryProposal;
};

// ── Tool Definitions (JSON schemas for LLM tools array) ───────────────

const BASE_TOOLS = [
    {
        type: 'function' as const,
        function: {
            name: 'query_campaign_lore',
            description: 'Search the Game Master notes for specific lore, rules, characters, or locations. Do NOT call this sequentially or spam it. If no relevant lore is found, immediately proceed with the narrative response. IMPORTANT: You MUST use the standard JSON tool call format. NEVER output raw XML <|DSML|> tags in your response text.',
            parameters: {
                type: 'object' as const,
                properties: { query: { type: 'string' as const, description: 'The specific search query' } },
                required: ['query'],
            },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'update_scene_notebook',
            description: 'Update the scene notebook for tracking temporary state — timers, NPC positions, environmental conditions, combat state. Actions: add (create note), remove (delete by text match), clear (wipe all). Max 50 notes, max 5 actions per call. Use sparingly — only for volatile scene state that changes within a scene.',
            parameters: {
                type: 'object' as const,
                properties: {
                    actions: {
                        type: 'array' as const,
                        items: {
                            type: 'object' as const,
                            properties: {
                                op: { type: 'string' as const, enum: ['add', 'remove', 'clear'] },
                                text: { type: 'string' as const, description: 'Note text (ignored for clear op)' },
                            },
                            required: ['op'],
                        },
                        description: 'Array of notebook actions to perform (max 5)',
                        maxItems: 5,
                    },
                },
                required: ['actions'],
            },
        },
    },
] as const;

const ROLL_DICE_TOOL = {
    type: 'function' as const,
    function: {
        name: 'roll_dice',
        description:
            "Roll dice when the player attempts an action with an uncertain outcome — combat hits, ability/skill checks, saves, contested actions. Do NOT call for descriptive moments, dialogue, or trivial actions. Mundane actions resolve as plain success without a roll.\n\n" +
            "Call roll_dice BEFORE narrating the outcome, then use the returned `tier` to shape the narrative.\n\n" +
            "Trigger: Player attempts an action with an uncertain outcome — combat hits, skill checks, saves, contested actions.\n" +
            "1. Identify core intent of the player's action.\n" +
            "2. If the outcome depends on chance, CALL `roll_dice` BEFORE narrating. Do NOT narrate the outcome first.\n" +
            "   - `dice`: use the die type appropriate to the category (e.g. Combat→d20, Social→d6, Perception→d6). Use `NdM` form (e.g. 2d6, 1d100). Optionally add `+N` or `-N` modifier.\n" +
            "   - `reason`: short label (e.g. \"Stealth check vs guard\", \"Longsword attack\")\n" +
            "   - `category`: one of Combat / Stealth / Social / Perception / Movement / Knowledge / Mundane (used for d20 tier mapping only)\n" +
            "3. Use the returned `tier` (outcome band label, e.g. Catastrophe / Failure / Success / Triumph / Narrative Boon) to shape the narrative. If no tier is returned (non-d20 rolls without configured bands), interpret the raw `result` per the campaign's Action Resolution rules.\n" +
            "4. Do NOT call `roll_dice` for descriptive moments, dialogue, or trivial actions.\n\n" +
            "Advantage: if the player explicitly leverages a known weakness or superior tool, call `roll_dice` twice and use the higher result. If explicitly impaired (blinded, wounded, overwhelmed), call twice and use the lower. Otherwise, single roll.\n\n" +
            "Outcome band semantics (when tier is returned):\n" +
            "- Catastrophe: severe unexpected failure, consequences beyond simple loss.\n" +
            "- Failure: fails. Damage, setback, or resource loss.\n" +
            "- Success: succeeds exactly as intended.\n" +
            "- Triumph: succeeds with an unexpected additional benefit.\n" +
            "- Narrative Boon: flawless. Massive strategic or narrative advantage.\n" +
            "Other custom bands: interpret per the campaign's Action Resolution rules.",
        parameters: {
            type: 'object' as const,
            properties: {
                dice:     { type: 'string' as const, description: "Dice expression: '1d20', '2d6', '1d100', '1d4', optionally with '+N' or '-N' modifier. Use the die type matching the action's category." },
                reason:   { type: 'string' as const, description: "Short label, e.g. 'Stealth check vs guard' or 'Longsword attack'" },
                category: { type: 'string' as const, enum: ['Combat','Perception','Stealth','Social','Movement','Knowledge','Mundane'], description: 'Skill category for tier mapping (used for d20 only)' }
            },
            required: ['dice', 'reason']
        }
    }
} as const;

// The stock wording above names fixed dice (Combat→d20, Social→d6) and a fixed
// category list. A campaign's dice system assigns each of its own categories a
// die, and pool mode already rolls by that assignment; these are the three
// passages the tool swaps so tool mode follows the same setup.
const STOCK_DICE_LINE = "   - `dice`: use the die type appropriate to the category (e.g. Combat→d20, Social→d6, Perception→d6). Use `NdM` form (e.g. 2d6, 1d100). Optionally add `+N` or `-N` modifier.\n";
const STOCK_CATEGORY_LINE = "   - `category`: one of Combat / Stealth / Social / Perception / Movement / Knowledge / Mundane (used for d20 tier mapping only)\n";
const STOCK_NO_TIER_NOTE = "(non-d20 rolls without configured bands)";

/** The campaign's categories that point at a real die, in configured order. */
function configuredDiceCategories(sys: DiceSystemConfig | null | undefined): { name: string; die: DieType }[] {
    if (!sys || !Array.isArray(sys.categories) || !Array.isArray(sys.dieTypes)) return [];
    const out: { name: string; die: DieType }[] = [];
    for (const cat of sys.categories) {
        const die = sys.dieTypes.find(d => d.id === cat.dieTypeId);
        const name = typeof cat.name === 'string' ? cat.name.trim() : '';
        if (die && die.faces > 0 && name) out.push({ name, die });
    }
    return out;
}

/**
 * The roll_dice definition for a campaign. Without a dice system (or with one
 * that has no usable category) this is the stock definition, unchanged. With
 * one, the die guidance and the category list come from the campaign's setup.
 */
export function buildRollDiceTool(diceSystem?: DiceSystemConfig | null): unknown {
    const cats = configuredDiceCategories(diceSystem);
    if (cats.length === 0) return ROLL_DICE_TOOL;

    const faces = Array.from(new Set(cats.map(c => c.die.faces)));
    const example = `1d${cats[0].die.faces}`;
    const diceLine = faces.length === 1
        ? `   - \`dice\`: this campaign rolls \`${example}\` for every category. Use \`NdM\` form. Optionally add \`+N\` or \`-N\` modifier.\n`
        : `   - \`dice\`: use the die this campaign assigns to the action's category (${cats.map(c => `${c.name}→d${c.die.faces}`).join(', ')}). Use \`NdM\` form (e.g. ${example}). Optionally add \`+N\` or \`-N\` modifier.\n`;
    const categoryLine = `   - \`category\`: one of ${cats.map(c => c.name).join(' / ')}\n`;

    const description = ROLL_DICE_TOOL.function.description
        .replace(STOCK_DICE_LINE, diceLine)
        .replace(STOCK_CATEGORY_LINE, categoryLine)
        .replace(STOCK_NO_TIER_NOTE, '(a die with no configured bands)');

    return {
        type: 'function' as const,
        function: {
            name: 'roll_dice',
            description,
            parameters: {
                type: 'object' as const,
                properties: {
                    dice:     { type: 'string' as const, description: `Dice expression in NdM form, e.g. '${example}', optionally with '+N' or '-N' modifier. Use the die assigned to the action's category.` },
                    reason:   ROLL_DICE_TOOL.function.parameters.properties.reason,
                    category: { type: 'string' as const, enum: cats.map(c => c.name), description: "Skill category, as configured for this campaign" },
                },
                required: ['dice', 'reason'],
            },
        },
    };
}

/**
 * The die to roll when the model names none: the die of the category it gave,
 * else the campaign's only die, else null (the caller keeps the legacy d20).
 */
function defaultDiceFor(diceSystem: DiceSystemConfig | null | undefined, category: unknown): string | null {
    const cats = configuredDiceCategories(diceSystem);
    if (cats.length === 0) return null;
    const wanted = typeof category === 'string' ? category.trim().toLowerCase() : '';
    const match = wanted ? cats.find(c => c.name.toLowerCase() === wanted) : undefined;
    if (match) return `1d${match.die.faces}`;
    const faces = new Set(cats.map(c => c.die.faces));
    return faces.size === 1 ? `1d${cats[0].die.faces}` : null;
}

import { normalizeLocationTag } from '../../types';

const PROPOSE_INVENTORY_TOOL = {
    type: 'function' as const,
    function: {
        name: 'propose_inventory_change',
        description:
            "Propose adding, removing, equipping, or relocating an item in the player's inventory when the fiction materially changes their gear (loot found, a weapon gifted/bought/broken, gear stashed at base or retrieved). This only *proposes* — the player must confirm before anything changes. Supply bounded labels ONLY; the engine sets all numbers (damage dice, bonus, AC). NEVER output damageDice, bonus, hp, or AC. Default quality to 'common'. Default location tag to 'inventory'.",
        parameters: {
            type: 'object' as const,
            properties: {
                name:            { type: 'string' as const, description: 'Item name.' },
                op:              { type: 'string' as const, enum: ['grant', 'remove', 'equip', 'relocate'], description: "Operation. Default 'grant'." },
                kind:            { type: 'string' as const, enum: ['weapon', 'armor', 'consumable', 'misc'], description: "Item kind. Default 'misc'." },
                quality:         { type: 'string' as const, enum: ['common', 'uncommon', 'rare', 'epic', 'legendary'], description: "Rarity/quality tier. Default 'common'." },
                scalingStat:     { type: 'string' as const, enum: ['STR', 'DEX', 'INT', 'WIS', 'CHA'], description: "Ability a weapon scales with. Default 'STR'." },
                range:           { type: 'string' as const, enum: ['Close', 'Reach', 'Ranged'], description: "Weapon range. Default 'Close'." },
                properties:      { type: 'array' as const, items: { type: 'string' as const }, description: 'Flavor tags, e.g. ["fire","heavy"].' },
                equip:           { type: 'boolean' as const, description: 'Equip on confirm (weapons/armor). Default false.' },
                description:     { type: 'string' as const, description: 'Short flavor text.' },
                fromLocationTag: { type: 'string' as const, description: 'Source location tag for relocate op (e.g. "player base").' },
                locationTag:     { type: 'string' as const, description: 'Destination/target location tag (e.g. "inventory", "player base"). Default "inventory".' },
            },
            required: ['name'],
        },
    },
} as const;

const START_COMBAT_TOOL = {
    type: 'function' as const,
    function: {
        name: 'start_combat',
        description:
            "Hand a fight to the game engine. Call this when hostile action against or by the player's party is about to be resolved by force. " +
            "Do NOT call it for threats, tension, intimidation, arguments, remembered or off-screen fights, or friendly sparring mentioned in passing. " +
            "Never include the player character in combatants. Never supply numbers (HP, damage, AC, bonuses): the engine sets them from the tier. " +
            "Do not use roll_dice to resolve a fight while this tool is available; call start_combat instead. " +
            "After calling, do not narrate any attack, hit, miss, wound or outcome; the player confirms and the engine resolves the fight.",
        parameters: {
            type: 'object' as const,
            properties: {
                combatants: {
                    type: 'array' as const,
                    minItems: 1,
                    maxItems: 12,
                    description: 'Everyone besides the player character who takes part. Repeat a name for identical foes ("Bandit", "Bandit").',
                    items: {
                        type: 'object' as const,
                        properties: {
                            name: { type: 'string' as const, description: 'Short display name.' },
                            side: { type: 'string' as const, enum: ['enemy', 'ally', 'neutral'], description: "Default 'enemy'." },
                            tier: { type: 'string' as const, enum: ['minion', 'grunt', 'elite', 'boss', 'legendary'], description: "Threat level. Default 'grunt'." },
                            archetype: { type: 'string' as const, enum: ['bulwark', 'assassin', 'caster', 'skirmisher', 'brute'], description: 'Optional fighting style.' },
                            species: { type: 'string' as const, description: 'Optional species or kind, e.g. "wolf".' },
                            npcName: { type: 'string' as const, description: 'Exact name of a known NPC this combatant is, if any.' },
                            look: { type: 'string' as const, description: 'Optional short description.' },
                            manner: { type: 'string' as const, description: 'Optional, two or three words: how this one talks and carries itself in a fight, e.g. "sneering, overconfident".' },
                            speech: { type: 'string' as const, enum: ['speaks', 'sounds', 'silent'], description: 'Can this creature speak words? speaks: people and anything that talks. sounds: animals and beasts that only growl, bark or shriek. silent: mindless or mechanical things (constructs, oozes, drones). Default is guessed from the name.' },
                            attack: { type: 'string' as const, enum: ['melee', 'ranged'], description: 'Optional. How it fights: melee or ranged.' },
                            tactic: {
                                type: 'string' as const,
                                enum: ['aggressive', 'skirmisher', 'guard', 'hunter', 'coward', 'berserker', 'support'],
                                description: 'Optional. How it behaves in the fight; default is guessed from its style.\n' +
                                    'aggressive: closes in and hits the most valuable target it can reach.\n' +
                                    'skirmisher: keeps its distance, uses cover, strikes and moves away.\n' +
                                    'guard: stays beside its leader and drives off whoever threatens it.\n' +
                                    'hunter: goes for the weakest or most isolated foe.\n' +
                                    'coward: fights from behind others and runs when hurt.\n' +
                                    'berserker: ignores danger, always the hardest hit, never backs off.\n' +
                                    'support: heals, shields and helps allies first, attacks when nothing needs doing.',
                            },
                        },
                        required: ['name'],
                    },
                },
                map: {
                    type: 'object' as const,
                    description: 'Where the fight happens. Choose the closest area type; the engine builds the map. Name what the obstacles are in labels. Do not describe positions, sizes or layout.',
                    properties: {
                        area: {
                            type: 'string' as const,
                            enum: ['open', 'scattered', 'room', 'rows', 'corridors', 'cavern', 'street', 'ledge', 'ruins', 'wetland'],
                            description:
                                'open: field, plaza, rooftop, arena. scattered: forest, graveyard, junkyard. room: tavern, hall, nightclub, throne room. ' +
                                'rows: warehouse, server room, library, market. corridors: ship, dungeon, sewer, bunker. cavern: cave, mine, grotto. ' +
                                'street: alley, road, canal side. ledge: mountain pass, rampart, bridge, catwalk. ruins: ruined town, collapsed temple, wreck. ' +
                                'wetland: swamp, flooded cave, shoreline, ford.',
                        },
                        density: { type: 'string' as const, enum: ['sparse', 'normal', 'dense'], description: "Optional. How cluttered the place is. Default 'normal'." },
                        hazard: { type: 'string' as const, enum: ['none', 'fire', 'deep_water', 'electric', 'toxic', 'pit'], description: "Optional. Default 'none'." },
                        labels: {
                            type: 'object' as const,
                            description: 'Optional short names, a few words each, e.g. {"cover":"tombstones","difficult":"mud"}.',
                            properties: {
                                wall: { type: 'string' as const },
                                cover: { type: 'string' as const },
                                difficult: { type: 'string' as const },
                                hazard: { type: 'string' as const },
                            },
                        },
                        place: { type: 'string' as const, description: 'Optional, a few words, e.g. "server room", "forest road".' },
                    },
                },
                objective: {
                    type: 'object' as const,
                    description: 'Optional. What the fight is about; default is a plain rout (beat everyone). The engine checks it, sets all positions and numbers, and may adjust it; the tool result says how. Never give coordinates.\n' +
                        'win rout: plain fight to the finish. defeat_leader: a clear leader whose fall breaks the rest (name it in leader). ' +
                        'survive: an ambush or siege the party cannot simply win; hold out for rounds (2 to 8). ' +
                        'escape: the party must get away through an exit (a chase, a collapsing place, hopeless odds); everyone true needs the whole party out. ' +
                        'protect: someone must be kept alive (name them in ward, as an ally); give rounds to hold out, or pair it with another win in with. ' +
                        'seize: take and hold a marked position (a gate, a lever, a bridgehead).',
                    properties: {
                        win: { type: 'string' as const, enum: ['rout', 'defeat_leader', 'survive', 'escape', 'protect', 'seize'] },
                        with: { type: 'string' as const, enum: ['rout', 'defeat_leader', 'survive', 'escape', 'seize'], description: 'protect only: the win that must also be met while the ward lives.' },
                        leader: { type: 'string' as const, description: 'Name of the enemy leader, as in combatants.' },
                        ward: { type: 'string' as const, description: 'Name of the ally to protect. If not in combatants, it is added as a weak ally.' },
                        rounds: { type: 'integer' as const, description: 'survive or protect: rounds to hold out.' },
                        everyone: { type: 'boolean' as const, description: 'escape: every party member must leave.' },
                        lose: {
                            type: 'array' as const,
                            items: { type: 'string' as const, enum: ['pc_falls', 'round_limit', 'leader_escapes'] },
                            description: 'Extra ways to lose. pc_falls: the player character going down ends the fight even if allies stand. round_limit: time runs out (give roundLimit). leader_escapes: the leader gets away (a chase).',
                        },
                        roundLimit: { type: 'integer' as const, description: 'Rounds before time runs out (3 to 15).' },
                        side: { type: 'string' as const, enum: ['within_rounds', 'no_one_falls', 'save_bystander', 'reach_tile'], description: 'Optional bonus aim; it never changes win or lose. save_bystander needs bystander, a neutral unit. reach_tile marks a spot (a chest).' },
                        sideRounds: { type: 'integer' as const, description: 'within_rounds: the round count.' },
                        bystander: { type: 'string' as const, description: 'Name of a neutral to save. If not in combatants, it is added as a neutral.' },
                        reinforcements: { type: 'string' as const, enum: ['none', 'some', 'many'], description: 'More enemies arriving mid-fight, warned a round ahead. Not for rout. Default none.' },
                    },
                    required: ['win'],
                },
                reason: { type: 'string' as const, description: 'One line shown to the player, e.g. "The bandits rush you from the treeline."' },
            },
            required: ['combatants', 'reason'],
        },
    },
} as const;

export const START_COMBAT_TOOL_RESULT =
    'Combat has been proposed to the player and will be resolved by the game engine. Write at most three sentences that bring the scene to the instant violence begins. Do not describe any attack, hit, miss, wound or outcome. Then stop.';

const PROPOSE_ABILITY_TOOL = {
    type: 'function' as const,
    function: {
        name: 'propose_ability',
        description:
            "Offer the player character a new combat ability when the story grants them a power, spell, technique or device. " +
            "The ability is built from glyphs: exactly one form (how it is delivered), one to four effects (what it does, applied in order), and optional augments. " +
            "Never supply numbers (damage, range, cost, duration): the game engine sets all of them. " +
            "The player decides whether the ability enters their spellbook. If the call is refused, the result lists the reasons; fix them and call again, or continue in narration.",
        parameters: {
            type: 'object' as const,
            properties: {
                name: { type: 'string' as const, description: 'Short name, at most 40 characters.' },
                description: { type: 'string' as const, description: 'One or two sentences of flavour. No numbers.' },
                damageType: { type: 'string' as const, description: 'One word such as fire, frost, lightning, psychic, physical. Optional.' },
                form: { type: 'string' as const, enum: [...FORM_IDS], description: 'self only carries heal, shield, haste or blink. barrier and summon must be the only effect.' },
                formAugments: { type: 'array' as const, items: { type: 'string' as const, enum: [...AUGMENT_IDS] } },
                effects: {
                    type: 'array' as const,
                    minItems: 1,
                    maxItems: 4,
                    items: {
                        type: 'object' as const,
                        properties: {
                            effect: { type: 'string' as const, enum: [...EFFECT_IDS] },
                            augments: { type: 'array' as const, items: { type: 'string' as const, enum: [...AUGMENT_IDS] } },
                        },
                        required: ['effect'],
                    },
                },
            },
            required: ['name', 'form', 'effects'],
        },
    },
} as const;

export type ProposeAbilityHandlerResult = {
    toolResult: string;
    ability?: GlyphAbility;
};

export function handleProposeAbilityTool(toolArguments: string, limits: AbilityLimits, alreadyProposed = false): ProposeAbilityHandlerResult {
    if (alreadyProposed) return { toolResult: ABILITY_ONE_AT_A_TIME };
    const parsed = parseAbilityArgs(toolArguments, limits);
    if (!parsed.ok) return { toolResult: rejectionText(parsed.reasons) };
    return { toolResult: PROPOSE_ABILITY_TOOL_RESULT, ability: parsed.ability };
}

export function getToolDefinitions(opts: { allowDiceTool: boolean; allowCombatTool?: boolean; allowAbilityTool?: boolean; diceSystem?: DiceSystemConfig | null }): unknown[] {
    const tools: unknown[] = [...BASE_TOOLS];
    if (opts.allowDiceTool) tools.push(buildRollDiceTool(opts.diceSystem));
    // propose_inventory_change is combat-independent — always offered.
    tools.push(PROPOSE_INVENTORY_TOOL);
    if (opts.allowCombatTool) tools.push(START_COMBAT_TOOL);
    if (opts.allowAbilityTool) tools.push(PROPOSE_ABILITY_TOOL);
    return tools;
}

export const TOOL_DEFINITIONS = BASE_TOOLS;

// ── Handlers ──────────────────────────────────────────────────────────

/**
 * Handles `query_campaign_lore` tool calls.
 * Returns the tool result string only — caller handles payload/message dispatch.
 */
export function handleLoreTool(
    toolArguments: string,
    ctx: ToolContext
): LoreHandlerResult {
    let query = '';
    try { query = JSON.parse(toolArguments).query || ''; } catch { /* Ignore */ }

    let toolResult = 'No relevant lore found.';
    if (query) {
        const found = searchLoreByQuery(ctx.loreChunks, query);
        if (found.length > 0) {
            toolResult = found.map(c => `### ${c.header}\n${c.content}`).join('\n\n');
        }
    }

    return { toolResult };
}

/**
 * Handles `update_scene_notebook` tool calls.
 * Returns the tool result string and mutated notebook — caller handles payload/message dispatch.
 */
export function handleNotebookTool(
    toolArguments: string,
    ctx: ToolContext
): NotebookHandlerResult {
    let notebookActions: { op: string; text?: string }[] = [];
    try { notebookActions = JSON.parse(toolArguments).actions || []; } catch { /* Ignore */ }

    const currentNotebook = [...(ctx.notebook ?? [])];
    let opsCount = 0;

    for (const action of notebookActions) {
        if (opsCount >= MAX_NOTEBOOK_OPS) break;
        if (action.op === 'add' && action.text && currentNotebook.length < MAX_NOTEBOOK_NOTES) {
            currentNotebook.push({ id: uid(), text: action.text.trim(), timestamp: Date.now() });
        } else if (action.op === 'remove' && action.text) {
            const searchLower = action.text.toLowerCase().trim();
            const idx = currentNotebook.findIndex(n => n.text.toLowerCase().includes(searchLower));
            if (idx !== -1) currentNotebook.splice(idx, 1);
        } else if (action.op === 'clear') {
            currentNotebook.length = 0;
        }
        opsCount++;
    }

    const toolResult = `Notebook updated. ${currentNotebook.length} notes active.`;
    console.log(`[Notebook] Updated: ${currentNotebook.length} notes active (${opsCount} ops)`);

    return { toolResult, updatedNotebook: currentNotebook };
}

const VALID_OPS = new Set<string>(['grant', 'remove', 'equip', 'relocate']);
const VALID_KINDS = new Set<string>(['weapon', 'armor', 'consumable', 'misc']);
const VALID_QUALITIES = new Set<string>(['common', 'uncommon', 'rare', 'epic', 'legendary']);
const VALID_SCALING_STATS = new Set<string>(['STR', 'DEX', 'INT', 'WIS', 'CHA']);
const VALID_RANGES = new Set<string>(['Close', 'Reach', 'Ranged']);

/**
 * Handles `propose_inventory_change` tool calls. Pure parsing + clamping — no LLM
 * call, no mutation. Returns a normalized {@link InventoryProposal} for the caller
 * to stage for user confirmation (the player must confirm before the delta applies).
 * Numeric weapon/armor stats (damageDice, bonus, AC) are intentionally NOT parsed —
 * the engine (Phase 7) owns all numbers; the GM only supplies bounded labels.
 */
export function handleProposeInventoryTool(
    toolArguments: string
): ProposeInventoryHandlerResult {
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(toolArguments); } catch { /* ignore */ }

    const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'Unknown Item';

    const rawOp = typeof args.op === 'string' ? args.op : '';
    const op: InventoryProposal['op'] = VALID_OPS.has(rawOp) ? (rawOp as InventoryProposal['op']) : 'grant';

    const rawKind = typeof args.kind === 'string' ? args.kind : '';
    const kind: InventoryProposal['kind'] = VALID_KINDS.has(rawKind) ? (rawKind as InventoryProposal['kind']) : 'misc';

    const rawQuality = typeof args.quality === 'string' ? args.quality : '';
    const quality: InventoryProposal['quality'] = VALID_QUALITIES.has(rawQuality) ? (rawQuality as InventoryProposal['quality']) : 'common';

    const rawScalingStat = typeof args.scalingStat === 'string' ? args.scalingStat : '';
    const scalingStat: InventoryProposal['scalingStat'] = VALID_SCALING_STATS.has(rawScalingStat) ? (rawScalingStat as InventoryProposal['scalingStat']) : 'STR';

    const rawRange = typeof args.range === 'string' ? args.range : '';
    const range: InventoryProposal['range'] = VALID_RANGES.has(rawRange) ? (rawRange as InventoryProposal['range']) : 'Close';

    let properties: string[] = [];
    if (Array.isArray(args.properties)) {
        properties = args.properties.filter((p: unknown): p is string => typeof p === 'string').map(p => p.trim()).filter(Boolean);
    }

    const equip = typeof args.equip === 'boolean' ? args.equip : false;
    const description = typeof args.description === 'string' ? args.description : '';

    const fromLocationTag = typeof args.fromLocationTag === 'string' && args.fromLocationTag.trim()
        ? normalizeLocationTag(args.fromLocationTag)
        : undefined;

    const locationTag = typeof args.locationTag === 'string' && args.locationTag.trim()
        ? normalizeLocationTag(args.locationTag)
        : 'inventory';

    const proposal: InventoryProposal = {
        name, op, kind, quality, scalingStat, range, properties, equip, description,
        fromLocationTag, locationTag
    };

    return {
        toolResult: JSON.stringify({ status: 'staged', name, op, kind, quality, fromLocationTag, locationTag }),
        proposal,
    };
}

export type StartCombatHandlerResult = {
    toolResult: string;
    proposal?: ParsedCombatArgs;
};

export function handleStartCombatTool(toolArguments: string, npcLedger: readonly NPCEntry[] = []): StartCombatHandlerResult {
    const parsed = parseCombatArgs(toolArguments, npcLedger);
    if (!parsed.ok) {
        return { toolResult: `start_combat was not accepted: ${parsed.error}. Fix the arguments and call it again, or continue the scene in narration.` };
    }
    const notes = objectiveToolNotes(parsed.value.combatants, parsed.value.objective, parsed.value.map, parsed.notes);
    const adjusted = notes.length > 0
        ? `\n\nThe fight objective was adjusted; the fight will be played this way, so keep the scene consistent with it: ${notes.join(' ')}`
        : '';
    return { toolResult: `${START_COMBAT_TOOL_RESULT}${adjusted}`, proposal: parsed.value };
}

function parseAndRoll(expr: string): { total: number; breakdown: string; sides: number; count: number } {
    const match = expr.trim().toLowerCase().match(/^(\d+)d(\d+)([+-]\d+)?$/);
    if (!match) {
        // Fallback: d20 single roll (legacy default)
        const single = Math.floor(Math.random() * 20) + 1;
        return { total: single, breakdown: `${single}`, sides: 20, count: 1 };
    }
    const count = Math.min(parseInt(match[1], 10), 100);
    const sides = parseInt(match[2], 10);
    const modifier = match[3] ? parseInt(match[3], 10) : 0;
    const rolls: number[] = [];
    for (let i = 0; i < count; i++) rolls.push(Math.floor(Math.random() * sides) + 1);
    const sum = rolls.reduce((a, b) => a + b, 0);
    const total = sum + modifier;
    const breakdown = modifier !== 0 ? `[${rolls.join('+')}]${modifier > 0 ? '+' : ''}${modifier} = ${total}` : `[${rolls.join('+')}] = ${total}`;
    return { total, breakdown, sides, count };
}

export function handleDiceTool(
    toolArguments: string,
    ctx: { diceSystem?: DiceSystemConfig | null }
): DiceHandlerResult {
    let args: { dice?: string; reason?: string; category?: string } = {};
    try { args = JSON.parse(toolArguments); } catch { /* ignore */ }

    // No die named: roll the one the campaign assigns, and report what was rolled.
    const dice = typeof args.dice === 'string' && args.dice.trim()
        ? args.dice
        : defaultDiceFor(ctx.diceSystem, args.category) ?? '1d20';
    const { total, breakdown, sides } = parseAndRoll(dice);

    // Look up the DieType by face count for tier mapping
    let tier: string | null = null;
    if (ctx.diceSystem) {
        const dieType: DieType | undefined = ctx.diceSystem.dieTypes.find(d => d.faces === sides);
        if (dieType) tier = mapTier(total, dieType);
    }

    const payload: Record<string, unknown> = {
        dice,
        reason: args.reason ?? '',
        result: total,
        breakdown
    };
    if (tier) payload.tier = tier;

    return { toolResult: JSON.stringify(payload) };
}
