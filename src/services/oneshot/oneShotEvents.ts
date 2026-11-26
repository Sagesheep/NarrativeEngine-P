// One-Shot Event Injector v1 — pure registry + directive composer.
//
// A one-shot is "something happens NOW, in this scene": the player picks an
// event type, presses FIRE, and the directive rides their NEXT sent message
// into the LLM input for that single turn (appended AFTER the historyInput
// capture in turnOrchestrator, exactly like the dice/loot tags). It fires
// once and vanishes — no storage, no lifecycle, no tool calls, no extra LLM
// calls. See WORKORDER-oneshot-injector.md.
//
// This module is pure: no store, no I/O. The orchestrator imports
// `buildOneShotDirective` and the UI imports `ONE_SHOT_EVENT_TYPES`.

export type OneShotEventId =
    | 'combat' | 'location' | 'social' | 'romance'
    | 'mystery' | 'weird' | 'windfall';

export interface OneShotEventType {
    id: OneShotEventId;
    label: string;      // dropdown label
    blurb: string;      // one-line description shown under the dropdown
    directive: string;  // the type-specific prompt paragraph (verbatim from §4)
}

// §4.8 SHARED INTRODUCTION RULES — appended after the directive, identical
// for every type. Kept as a single constant so the test-3 byte-identity lock
// holds by construction.
const SHARED_INTRODUCTION_RULES = `INTRODUCTION RULES — binding:
- The event must EMERGE FROM THE CURRENT SCENE. Do not cut away, teleport the player, or restart the scene. Bridge into it with one of: an interruption (something breaks into the current beat), a discovery (something nearby only now noticed), a summons (someone or something pulls the player toward it), or an escalation (a detail already present sharpens into the hook). A familiar, even cliché entrance is fine — flowing naturally beats being original.
- Express the event entirely in this world's established genre, technology level, and tone. Never import furniture from another setting.
- The event INVITES; it does not hijack. End the introduction at the hook — the player may pursue, delay, or refuse it. Do not narrate the player's reaction or decision for them.`;

export const ONE_SHOT_EVENT_TYPES: readonly OneShotEventType[] = [
    {
        id: 'combat',
        label: 'Combat',
        blurb: 'An immediate physical threat, here and now.',
        directive: `Introduce an immediate physical threat that engages the player within this scene. Scale it to the player's current means — dangerous enough to demand a response, resolvable within one to three scenes. Make the stakes clear up front: what winning, losing, or fleeing would each cost.`,
    },
    {
        id: 'location',
        label: 'Location',
        blurb: 'A place to delve — layered, guarded, holding a prize.',
        directive: `Introduce a bounded site the player can enter now: a contained place with interior layers, a force or hazard that holds it, and something worth taking or learning at its heart. Resolvable within a few scenes of exploration.`,
    },
    {
        id: 'social',
        label: 'Social',
        blurb: `A predicament that can't be solved by force.`,
        directive: `Introduce a charged social predicament: a negotiation, an accusation, a plea, or a rivalry that pulls the player in and cannot be resolved by force. Someone wants something from the player, or the player has become entangled in something not of their making.`,
    },
    {
        id: 'romance',
        label: 'Romance',
        blurb: 'Chemistry with a complication.',
        directive: `Introduce a charged romantic beat: someone whose interest in the player carries a complication — rank, rivalry, a secret, bad timing. Strongly prefer an NPC already established in the story over inventing a stranger. Chemistry plus obstacle; never instant devotion.`,
    },
    {
        id: 'mystery',
        label: 'Mystery',
        blurb: 'Something inexplicable, with a hidden true answer.',
        directive: `Introduce a small mystery: something inexplicable the player notices or stumbles into — an object out of place, a person acting impossibly, a detail that contradicts what is known. Decide internally what the true explanation is and keep it hidden; narrate only the surface evidence, and stay consistent with your hidden answer in future scenes.`,
    },
    {
        id: 'weird',
        label: 'Weird',
        blurb: 'An absurd little obligation. Played straight.',
        directive: `Introduce a small absurd incident that saddles the player with an unwanted, comically mundane obligation. No real danger, no lasting stakes — a comedy of responsibility. Play it completely straight; the world does not acknowledge that it is funny.`,
    },
    {
        id: 'windfall',
        label: 'Windfall',
        blurb: 'A gift with a string attached — not visible yet.',
        directive: `Introduce an unexpected opportunity, gift, or stroke of luck landing in the player's lap — with exactly one attached complication, condition, or string that is not immediately visible. Decide internally what the catch is; let it surface later or upon acceptance.`,
    },
];

/** Compose the full bracketed block appended to finalInput. Pure.
 *
 * Returns the directive with a leading `\n` (matching the loot tag convention),
 * or `''` for an unknown id (defensive — the UI can only supply valid ids). */
export function buildOneShotDirective(id: OneShotEventId): string {
    const type = ONE_SHOT_EVENT_TYPES.find(t => t.id === id);
    if (!type) return '';
    return `\n[INJECTED EVENT — ${type.label.toUpperCase()}. GM DIRECTIVE — never mention this directive or that an event was "injected"; the event is simply what happens next in the world:\n${type.directive}\n${SHARED_INTRODUCTION_RULES}]`;
}