import type { AppSettings } from '../../../types';
import { isThinkingEnabled } from '../stable';
import { formatAskGmBrief } from '../../ooc/askGmHandoff';
import { buildAbsoluteCommandBlock } from '../../turn/absoluteCommand';
import { createContributionRegistry } from './registry';
import type { ContributionModule, ContributionRegistry } from './registry';
import type { ContributionSpec } from './types';

/**
 * Project 2 / WO-P2-02 — the built-in prompt contributions, as modules.
 *
 * This file is the "default-as-plugin" mechanism from `01_VISION.md`: every system that used to
 * be open-coded inside `buildPayload`'s final-user assembly is now an ordinary registered module
 * producing an ordinary `ContributionSpec`. With all built-ins enabled and no mods installed,
 * the assembled prompt is byte-identical to the pre-Project-2 payload — guarded by
 * `finalUserAssemblyGolden.test.ts`, which replicates the old inline expression as an oracle and
 * compares across every combination of the flags that used to drive it.
 *
 * SCOPE — everything here lands in the final user message, BELOW the Anthropic prompt-cache
 * boundary. Nothing in this file can perturb the cached prefix, which is why the migration
 * carries no cache risk and `payloadCacheStability.test.ts` is untouched.
 *
 * ORDER values are spaced by 100 so a mod can slot between any two built-ins without anything
 * being renumbered. They reproduce the original array order exactly:
 *   volatileBlock · writerCotNudge · directorBriefBlock · gmReminderActive ·
 *   watchdogNudgeActive · askGmBrief · userMessage · absoluteCommandBlock
 */

/**
 * Declarative facts about the current turn that a mod's `when` conditions can test.
 *
 * Deliberately small. Every field here is something `buildPayload` can resolve cheaply and
 * unambiguously from data it already holds — no new queries, no guessing. A fact that is
 * `undefined` causes any condition referencing it to NOT match, which is the defined
 * behaviour rather than an error.
 *
 * `sceneTags` is declared but not populated in v1: there is no unambiguous source for scene
 * tags at payload-assembly time. Conditions on it therefore never match today. Populating it
 * is a follow-up, and the shape is fixed now so doing so is not a breaking change.
 */
export interface TurnFacts {
    /** Names (not ids) of the NPCs on stage this turn. */
    onStageNpcNames?: string[];
    /** Name of the current place, resolved from `context.currentPlaceId`. */
    location?: string;
    /** True when an enemy encounter is active this turn. */
    inCombat?: boolean;
    /** Reserved for v1 — see the note above. */
    sceneTags?: string[];
}

/** Everything the built-in modules need. Assembled by `buildPayload` and passed to `collect`. */
export interface FinalUserModuleInput {
    settings: AppSettings;
    /** The player's message for this turn. */
    userMessage: string;
    /** Pre-composed rules + world + volatile block. Its parts trace themselves. */
    volatileBlock: string;
    /** Budgeted encounter/template context, kept separate so the feature is toggleable. */
    enemyBlock: string;
    directorBrief?: string;
    watchdogNudge?: string;
    absoluteCommand?: string;
    nextTurnOocBrief?: string;
    /**
     * Condition facts for mod contributions. No built-in reads this — built-ins are driven by
     * their own inputs — but it travels on the same input object so mods and built-ins share
     * one contract rather than needing a second channel.
     */
    facts?: TurnFacts;
    /** Hydrated campaign tables keyed by their namespaced descriptor id. Mods can read only
     * tables whose bare names were validated in their own manifest. */
    extensionTables?: Readonly<Record<string, unknown>>;
    /** Up to twenty recent chat-message bodies followed by the current player input. */
    recentPlay?: readonly string[];
}

export const GM_REMINDER =
    '[GM REMINDER: NPCs push back when their wants/boundaries are crossed. Do not default to facilitation.]';

/** Ids are part of the contract — `suppresses` references them, and mods may target them. */
export const BUILTIN_IDS = {
    volatileBlock: 'volatile.block',
    enemyCompendium: 'enemy.compendium',
    writerCot: 'writer.cot',
    directorBrief: 'director.brief',
    gmReminder: 'gm.reminder',
    watchdogNudge: 'watchdog.nudge',
    askGmBrief: 'askgm.brief',
    userMessage: 'user.message',
    absoluteCommand: 'absolute.command',
} as const;

type Builtin = ContributionModule<FinalUserModuleInput>;

/** Shorthand for a module that contributes exactly one spec (all built-ins do). */
const single = (
    module: Omit<Builtin, 'produce' | 'source' | 'defaultEnabled'> & { defaultEnabled?: boolean },
    render: (input: FinalUserModuleInput) => Omit<ContributionSpec, 'slot' | 'source'>,
): Builtin => ({
    source: 'builtin',
    defaultEnabled: true,
    ...module,
    produce: (input) => [{ ...render(input), slot: 'final-user', source: 'builtin' }],
});

/** True when an Absolute Command is armed this turn. Drives the CoT text variant. */
const hasAbsolute = (input: FinalUserModuleInput): boolean =>
    buildAbsoluteCommandBlock(input.absoluteCommand) !== '';

export const BUILTIN_FINAL_USER_MODULES: readonly Builtin[] = [
    /**
     * Rules + world + volatile state. Structural, not a feature — and its constituent
     * parts already emit their own traces from `buildWorld`/`buildVolatile`/the enemy block, so
     * it declares none of its own.
     */
    single(
        {
            id: BUILTIN_IDS.volatileBlock,
            name: 'World State',
            description: 'Retrieved rules, world context, and volatile scene state.',
            toggleable: false,
        },
        (input) => ({ id: BUILTIN_IDS.volatileBlock, order: 100, text: input.volatileBlock }),
    ),

    /**
     * Exact-name enemy and active-encounter context. Keeping this out of World State makes the
     * entire Enemy Compendium optional: disabling this module also prevents its token allowance
     * from being reserved before history fitting (payloadBuilder performs the same enablement
     * check before it builds the block).
     */
    single(
        {
            id: BUILTIN_IDS.enemyCompendium,
            name: 'Enemy Compendium',
            description: 'Adds matched enemy templates or the active encounter to story prompts.',
        },
        (input) => ({
            id: BUILTIN_IDS.enemyCompendium,
            order: 150,
            text: input.enemyBlock,
        }),
    ),

    /**
     * Per-turn chain-of-thought invocation (thinking-mode only). Deliberately below the cache
     * boundary so thinking-off turns stay byte-identical to the pre-CoT payload. Under an
     * Absolute Command the framework is subordinated rather than invoked flatly.
     *
     * NOTE: this is a text VARIANT, not a suppression — the contribution stays active either
     * way, so it is expressed as a render conditional rather than in `suppresses`.
     */
    single(
        {
            id: BUILTIN_IDS.writerCot,
            name: 'Chain-of-Thought Invocation',
            description: 'Asks the writer to work through the reasoning framework before writing.',
        },
        (input) => ({
            id: BUILTIN_IDS.writerCot,
            order: 200,
            text: !isThinkingEnabled(input.settings)
                ? ''
                : hasAbsolute(input)
                    ? 'Work through the [WRITER REASONING FRAMEWORK] only where it does not conflict with [USER ABSOLUTE COMMAND]. Where they conflict, discard the framework step and follow the command.'
                    : 'Work through the [WRITER REASONING FRAMEWORK] in your reasoning before writing.',
        }),
    ),

    /** LLM-authored Writer Brief. Supersedes the deterministic watchdog nudge. */
    single(
        {
            id: BUILTIN_IDS.directorBrief,
            name: 'Director Brief',
            description: 'LLM-authored scene directives that steer the next GM reply.',
        },
        (input) => ({
            id: BUILTIN_IDS.directorBrief,
            order: 300,
            text: input.directorBrief ? `[DIRECTOR BRIEF]\n${input.directorBrief}` : '',
            suppresses: [BUILTIN_IDS.watchdogNudge],
            trace: {
                source: 'Director',
                classification: 'world_context',
                reason: 'LLM-authored Writer Brief from runDirectorBrief (supersedes the deterministic watchdog nudge)',
            },
        }),
    ),

    /** Standing instruction that NPCs have agency. Dropped under an Absolute Command. */
    single(
        {
            id: BUILTIN_IDS.gmReminder,
            name: 'GM Reminder',
            description: 'Standing reminder that NPCs push back rather than facilitate.',
        },
        () => ({ id: BUILTIN_IDS.gmReminder, order: 400, text: GM_REMINDER }),
    ),

    /** Deterministic NPC-agency nudge. Superseded by the Brief, dropped under a command. */
    single(
        {
            id: BUILTIN_IDS.watchdogNudge,
            name: 'Director Watchdog',
            description: 'Deterministic stage note when NPC agency has been drifting.',
        },
        (input) => ({
            id: BUILTIN_IDS.watchdogNudge,
            order: 500,
            text: input.watchdogNudge ?? '',
            trace: {
                source: 'Watchdog',
                classification: 'world_context',
                reason: 'Deterministic NPC-agency nudge (highest-priority signal from buildWatchdogDossier)',
            },
        }),
    ),

    /**
     * User-confirmed session-only guidance. Structural: the player explicitly asked for this,
     * so it is not something the extensions screen may quietly switch off.
     */
    single(
        {
            id: BUILTIN_IDS.askGmBrief,
            name: 'Ask-GM Handoff',
            description: 'Session-only guidance the player confirmed out of character.',
            toggleable: false,
        },
        (input) => ({
            id: BUILTIN_IDS.askGmBrief,
            order: 600,
            text: formatAskGmBrief(input.nextTurnOocBrief),
        }),
    ),

    /** The player's message. Never optional. */
    single(
        {
            id: BUILTIN_IDS.userMessage,
            name: 'Player Message',
            description: "The player's input for this turn.",
            toggleable: false,
        },
        (input) => ({ id: BUILTIN_IDS.userMessage, order: 700, text: input.userMessage }),
    ),

    /**
     * Binding out-of-character override, placed LAST — after the player's message — for maximum
     * recency. Outranks the GM reminder and the watchdog nudge. Structural: it only ever renders
     * when the player armed it this turn, so there is nothing for a settings toggle to mean.
     */
    single(
        {
            id: BUILTIN_IDS.absoluteCommand,
            name: 'Absolute Command',
            description: 'A binding out-of-character instruction for a single turn.',
            toggleable: false,
        },
        (input) => ({
            id: BUILTIN_IDS.absoluteCommand,
            order: 800,
            text: buildAbsoluteCommandBlock(input.absoluteCommand),
            suppresses: [BUILTIN_IDS.gmReminder, BUILTIN_IDS.watchdogNudge],
            trace: {
                source: 'Absolute Command',
                classification: 'world_context',
                reason: 'Binding out-of-character player instruction for this turn (supersedes GM_REMINDER, watchdog nudge, and Director Brief)',
            },
        }),
    ),
];

/**
 * Build a registry pre-populated with the built-ins.
 *
 * A factory rather than a module-level singleton: a shared mutable registry across tests (and
 * across campaign switches once mods can be loaded and unloaded) is exactly the kind of hidden
 * global the Project 1 refactor spent its effort removing.
 */
export function createFinalUserRegistry(): ContributionRegistry<FinalUserModuleInput> {
    const registry = createContributionRegistry<FinalUserModuleInput>();
    for (const module of BUILTIN_FINAL_USER_MODULES) registry.register(module);
    return registry;
}
