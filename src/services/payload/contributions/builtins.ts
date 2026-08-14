import type { AppSettings, RelationshipStance } from '../../../types';
import { isThinkingEnabled } from '../stable';
import { formatAskGmBrief } from '../../ooc/askGmHandoff';
import { buildAbsoluteCommandBlock } from '../../turn/absoluteCommand';
import { createContributionRegistry } from './registry';
import type { ContributionModule, ContributionRegistry } from './registry';
import type { ContributionSpec } from './types';
import { renderRelationshipStanceBlock } from '../../npc/relationshipStance';

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
    /** True when a combat encounter is running this turn. Established by a segment or a mod (7.5 / 5.4). */
    inCombat?: boolean;
    /** Reserved for v1 — see the note above. */
    sceneTags?: string[];
}

/** Everything the built-in modules need. Assembled by `buildPayload` and passed to `collect`. */
export interface FinalUserModuleInput {
    settings: AppSettings;
    /** The player's message for this turn. */
    userMessage: string;
    /** Pre-composed rules + world + segments + volatile state. Its parts trace themselves. */
    volatileBlock: string;
    /**
     * WO-4 §4 — the on-stage NPC↔NPC relations block, split out of the structural
     * `volatile.block` into its own toggleable contribution. Rendered by `buildWorld`
     * (routed through the canonical relation-key resolver) and passed here so a mod
     * can suppress it — the prerequisite for v3 to replace the flat scalar with the
     * stance without the two contradicting each other in the same prompt.
     *
     * Empty string when no on-stage NPC↔NPC edges resolve. With no mods the assembled
     * payload is byte-identical to the pre-split form (the golden test's no-relations
     * fixture passes untouched).
     */
    relationsBlock: string;
    /** WO-5: scene-specific NPC readings; numbers and flat relationship arrows never enter v3. */
    relationshipStances?: readonly RelationshipStance[];
    relationshipStanceBudget?: number;
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
}

export const GM_REMINDER =
    '[GM REMINDER: NPCs push back when their wants/boundaries are crossed. Do not default to facilitation.]';

/** Ids are part of the contract — `suppresses` references them, and mods may target them. */
export const BUILTIN_IDS = {
    volatileBlock: 'volatile.block',
    relations: 'npc.relations',
    stance: 'npcStance',
    writerCot: 'writer.cot',
    directorBrief: 'director.brief',
    gmReminder: 'gm.reminder',
    watchdogNudge: 'watchdog.nudge',
    askGmBrief: 'askgm.brief',
    userMessage: 'user.message',
    absoluteCommand: 'absolute.command',
} as const;

type BuiltinDetails = {
    trigger: string;
    prompt?: string;
    tokenImpact: string;
    quietWhen: string;
};

type Builtin = ContributionModule<FinalUserModuleInput> & {
    explain?: string;
    example?: string;
    details?: BuiltinDetails;
};

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
     * Rules + world + any registered volatile segments + volatile state. Structural, not a
     * feature — and its constituent parts already emit their own traces from
     * `buildWorld` / `buildVolatile` / each segment, so it declares none of its own.
     */
    single(
        {
            id: BUILTIN_IDS.volatileBlock,
            name: 'World State',
            description: 'Retrieved rules, world context, subsystem context, and volatile scene state.',
            toggleable: false,
        },
        (input) => ({ id: BUILTIN_IDS.volatileBlock, order: 100, text: input.volatileBlock }),
    ),

    /**
     * WO-4 §4 — on-stage NPC↔NPC relations, split out of the structural `volatile.block`
     * into its own toggleable contribution. The relation lines used to ride inside the
     * `[ACTIVE NPC CONTEXT]` block, which is structural (`toggleable: false`) and listed
     * in `PROTECTED_SUPPRESSION_IDS` — so nothing could switch them off. v3 needs to
     * replace the flat scalar with the stance; without a suppressible seam the two would
     * sit in the same prompt contradicting each other.
     *
     * Rendered by `buildWorld` (routed through the canonical relation-key resolver,
     * `relationResolve.ts`) and passed on `FinalUserModuleInput.relationsBlock`. Empty
     * string when no on-stage NPC↔NPC edges resolve. With no mods the assembled payload
     * is byte-identical to the pre-split form — the golden test's no-relations fixture
     * passes untouched (an empty contribution is dropped before assembly, so the
     * `\n\n` join never fires).
     *
     * `volatile.block` stays protected; only the relationship lines moved out.
     */
    single(
        {
            id: BUILTIN_IDS.relations,
            name: 'On-Stage Relations',
            description: 'Directed NPC↔NPC relationship arrows for on-stage characters.',
            details: {
                "trigger": "Automatic when two or more on-stage NPCs have a non-zero relationship with each other.",
                "prompt": "[ON-STAGE RELATIONS]\nBram→Alden: +2\nAlden→Bram: +1",
                "tokenImpact": "No separate feature cap. One line is sent for each non-zero directed pair; the lines count toward the total prompt context.",
                "quietWhen": "No on-stage NPC pair has a non-zero relationship. NPC Stances also replaces this block when stance text is present."
            },
            explain: 'Tells the writer how the characters in a scene feel about **each other** — not about you. Without it, everyone in a group scene behaves as though they just met.',
            example: `Bram and Alden are both at the table when the innkeeper asks who broke the door.

**On** — Alden covers for Bram without being asked.

**Off** — Alden answers honestly. He has no idea they are friends.`,
        },
        (input) => ({ id: BUILTIN_IDS.relations, order: 150, text: input.relationsBlock ?? '' }),
    ),

    /** WO-5 — the writer-facing replacement for scalar affinity and relation meters. */
    single(
        {
            id: BUILTIN_IDS.stance,
            name: 'NPC Stances',
            description: 'Scene-specific NPC wants, boundaries, and relationship memories.',
            details: {
                "trigger": "Automatic for on-stage NPCs when relationship readings are available.",
                "prompt": "[NPC STANCES]\nSTANCE — Alden · scene 123 · deep\nstatus: guarded\nwon’t: never betray Bram\nwants now: keep the door closed\nhiding: he is afraid\nmanner: clipped\n[END NPC STANCES]",
                "tokenImpact": "The final prompt reserves 20 tokens for each cheap stance and 80 for each deep stance. Deep readings are limited to 0 on Lite, 2 on Pro, and 3 on Max; up to 5 memories can feed each reading.",
                "quietWhen": "No NPCs are on stage, relationship readings fail, or there is no stance text to inject. When present, it suppresses On-Stage Relations."
            },
            explain: 'The deep version, pointed at you. For every character on stage it works out what they want in this exact moment, what they are hiding, what they will refuse, and which memories of you are pulling at them right now. When it has something to say it takes over from On-Stage Relations.',
            example: `She lost a battle to you last week. A year before that, you put a hand on her head at the academy.

**On** — she will not look at you, answers in three words, refuses the food you brought, and eats it after you leave.

**Off** — the writer knows only that she is hostile, and plays her as flatly hostile.`,
        },
        (input) => ({
            id: BUILTIN_IDS.stance,
            order: 150,
            text: renderRelationshipStanceBlock(input.relationshipStances ?? []),
            budget: input.relationshipStanceBudget,
            suppresses: [BUILTIN_IDS.relations],
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
            details: {
                "trigger": "Automatic when the active story provider has Thinking Effort set to Low, Medium, High, or Max.",
                "prompt": "[WRITER REASONING FRAMEWORK]\nWork through these steps in your internal reasoning before writing the narrative. Never show the steps in the narrative output. Always produce the full narrative response after your reasoning ends.\nStep 1 — Deconstruct: break the player's input into discrete intents. Judge each against the rules and MC boundaries. Impossible or implausible demands are narrated as attempts with consequences, not successes.\nStep 2 - Director Brief: if a [DIRECTOR BRIEF] block is present, honor its MANDATORY world-law or fair-adjudication corrections and any compatible SUGGESTION. It does not schedule drama or dictate every character's reaction.\nStep 3 — On-stage minds: first state the player's visible action and result without moral interpretation. For each character in [ACTIVE NPC CONTEXT], consider their current goal and emotional state, what they know and do not know (check [FACTS KNOWN TO ON-STAGE CHARACTERS]), their disposition and competence, and their relationship to the player. Then choose a proportionate response: speech, action, observation, help, challenge, humour, silence, withdrawal, or a shared crowd response. Characters may converge when the same event gives them the same reason to react; they may differ when their perspectives differ. Do not force either. A boundary produces push-back only when the concrete action actually crosses it; never infer a larger injury, hostile intent, or moral failing merely to make drama.\nStep 4 — Engine truth: honor [DICE OUTCOMES] exactly as resolved — never soften failures or upgrade successes. Check each on-stage character against their signature kit. Check [LOCATION] logistics: travel time, weather, era-appropriate technology.\nStep 5 - Beat map: draft 5-8 beats. Include every MANDATORY directive from Step 2 and the reactions that actually follow from Step 3. Give the player a playable opening - a response, consequence, piece of information, offer, challenge, or changed situation - rather than forcing a twist, argument, or lesson.\nStep 6 — Final audit: the player's action drives the scene; reactions are grounded in what each character observed and values; no unearned NPC chorus or retroactive moralisation; no cliches or purple prose. Then write the scene.\n\nFinal-turn invocation:\nWork through the [WRITER REASONING FRAMEWORK] in your reasoning before writing.",
                "tokenImpact": "The six-step framework is 467 input tokens in the stable prompt. The normal final-turn invocation is 18 more input tokens. There is no separate COT output-token cap; the provider/model controls hidden reasoning and answer limits.",
                "quietWhen": "Thinking Effort is Off. An Absolute Command swaps the normal invocation for a 38-token instruction that tells the model to follow the command where they conflict."
            },
            explain: 'Asks the writer to think through the scene before writing it, instead of answering straight away. Only does anything when thinking is switched on for your model — with thinking off it adds nothing at all.',
            example: "Same request: you lie to a character who already knows the truth.\n\n**Without COT** — \"I believe you.\" She reacts to the words and lets the scene move on.\n\n**With COT** — she notices that the lie is known, decides whether to expose it, and lets that choice shape the reply.\n\nThe wording still varies by model; the difference is what the writer considers before answering.",
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
            details: {
                "trigger": "Automatic on Pro and Max tiers, before the main writer answers; the result is cached for repeated swipes of the same turn.",
                "prompt": "WRITER BRIEF\n- [MANDATORY] <directive> (0–2 lines)\n- [SUGGESTION] <directive> (0–3 lines)",
                "tokenImpact": "A separate utility-AI call has a 180-second timeout. Its input NPC summary is capped at 120 tokens and it reads the last 5 timeline events. No explicit output-token cap is set; the line limits above are the output contract.",
                "quietWhen": "Lite tier, no provider, timeout, parse failure, or no correction worth making. A successful Brief suppresses the Watchdog nudge."
            },
            explain: 'Before each reply, a second AI reads the scene and writes short directions for the writer — what this beat needs, and what to leave alone. It is the difference between a scene that goes somewhere and one that answers you politely.',
            example: `Direction written for the writer: *"The confession landed. Do not resolve it this turn — let her leave the room."*

**On** — she leaves. It sits with you for three scenes.

**Off** — she talks it through and the tension is spent immediately.`,
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
            details: {
                "trigger": "Automatic on every turn while enabled.",
                "prompt": "[GM REMINDER: NPCs push back when their wants/boundaries are crossed. Do not default to facilitation.]",
                "tokenImpact": "24 input tokens when present. It has no output call and no separate cap.",
                "quietWhen": "An Absolute Command suppresses it for that turn. Otherwise it is deliberately always present, even in a quiet scene."
            },
            explain: 'A single standing line reminding the writer that characters push back when you cross what they want, instead of going along with it. It is the cheapest guard against everyone becoming agreeable.',
            example: `You tell the gate guard to let you through.

**On** — he asks who you are, and refuses.

**Off** — he steps aside.`,
        },
        () => ({ id: BUILTIN_IDS.gmReminder, order: 400, text: GM_REMINDER }),
    ),

    /** Deterministic NPC-agency nudge. Superseded by the Brief, dropped under a command. */
    single(
        {
            id: BUILTIN_IDS.watchdogNudge,
            name: 'Director Watchdog',
            description: 'Deterministic stage note when NPC agency has been drifting.',
            details: {
                "trigger": "Automatic deterministic check on every turn while enabled; it makes no AI call.",
                "prompt": "[STAGE NOTE: Alden has not initiated toward the PC recently — give Alden a beat to reach out this scene.]",
                "tokenImpact": "No separate token cap. It emits only the highest-priority one-line correction from its signals.",
                "quietWhen": "No signal is found, or a Director Brief is present. It scans 3 recent assistant replies for silence, 5 assistant replies for initiation, and 5 recent messages for stalled goals."
            },
            explain: 'Watches across several turns for characters quietly turning into pushovers, and drops in a correction when it sees the drift. It stays silent the rest of the time, and stands down whenever the Director Brief is already speaking.',
            example: `Four turns in a row where everyone agreed with you.

**On** — *"The room has stopped resisting. Someone objects to this."*

**Off** — the drift continues until you notice it yourself.`,
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
 * Phase 5.3 — the suppressible built-in ids, derived from the module list rather
 * than hand-kept. A built-in is suppressible iff it is NOT structural
 * (`toggleable !== false`), which is the same marker the contribution registry
 * uses to keep structural modules out of the extensions screen.
 *
 * This is the authoritative published list. `modContext.ts` exposes it on
 * `ctx.api.suppressibleIds`, the loader's `PROTECTED_SUPPRESSION_IDS` is its
 * complement, and `phase53Subtraction.test.ts` pins both sides together so a
 * new built-in that forgets to set `toggleable: false` is caught at test time
 * rather than at "a mod just deleted the player's message" time.
 *
 * Derived, not declared: the moment a second list is hand-kept it drifts from
 * the module array, and the drift is silent. The filter runs once at module
 * load and the result is frozen.
 */
export const SUPPRESSIBLE_BUILTIN_IDS: readonly string[] = Object.freeze(
    BUILTIN_FINAL_USER_MODULES
        .filter((m) => m.toggleable !== false)
        .map((m) => m.id),
);

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
