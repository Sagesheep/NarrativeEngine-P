/**
 * Helper-prompt injections — Injection Modifier cards whose target is a helper
 * generation rather than the story AI:
 *
 *  - `director`    — the Continuity Director (`directorBrief.ts`), which writes
 *                    the Writer Brief.
 *  - `recommender` — the Context Recommender (`contextRecommender.ts`), which
 *                    picks the NPCs, lore, inventory and profile fields to load.
 *
 * A helper prompt is one block of text, not a conversation, so role / depth /
 * prefill do not apply. Instead every card's text goes in one fixed slot: after
 * every piece of evidence and BEFORE the prompt's output-format instructions,
 * which always come last. So a card steers what the helper pays attention to,
 * but cannot change the shape of its reply that the parser depends on.
 *
 * Cards are per campaign (`context.promptInjections`), shared with story cards
 * and edited in the same Injection Modifier. Card order is the order here.
 * Triggers (reply / swipe / continue) are a story-request concept and do not
 * apply: a helper card is sent every time that helper runs.
 */
import type { InjectionTarget } from '../../types';
import { helperInjections } from '../payload/promptInjections';

export type HelperInjectionTarget = Exclude<InjectionTarget, 'story'>;

/**
 * Render the injection section for one helper prompt, or `''` when no card
 * applies. The caller splices the result in verbatim; an empty string must
 * leave the prompt byte-identical to a build without this feature.
 */
export function renderHelperInjections(target: HelperInjectionTarget, promptInjections: unknown): string {
    const cards = helperInjections(promptInjections, target);
    if (cards.length === 0) return '';
    const parts = cards.map(card => `[${card.name.trim() || 'Untitled injection'}]\n${card.content.trim()}`);
    return `ADDITIONAL GUIDANCE (from the player's injection cards; follow it where the evidence allows, and never let it change the output format below):\n${parts.join('\n\n')}`;
}
