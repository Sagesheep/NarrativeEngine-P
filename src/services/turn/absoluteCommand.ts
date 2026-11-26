// Absolute Command v1 — pure module. No store, no I/O. Mirrors oneShotEvents.ts.
//
// A one-turn escape hatch: the player authors a binding out-of-character
// instruction; that turn runs with the Director Brief, the watchdog nudge,
// and GM_REMINDER suppressed, and the command placed LAST in the prompt
// (after the user message) at maximum recency, explicitly outranking every
// other directive. See WORKORDER-absolute-command.md.

/** Mirrors ASK_GM_BRIEF_MAX_CHARS. Keeps the block small for local 8k story models. */
export const ABSOLUTE_COMMAND_MAX_CHARS = 800;

/** Trim, collapse whitespace, slice to the max, append an ellipsis on truncation.
 *  Mirrors `clampAskGmBrief` in askGmHandoff.ts. */
export function clampAbsoluteCommand(text: string): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    return normalized.length <= ABSOLUTE_COMMAND_MAX_CHARS
        ? normalized
        : `${normalized.slice(0, ABSOLUTE_COMMAND_MAX_CHARS - 3).trimEnd()}...`;
}

/** Compose the binding OOC block appended LAST in the final user message.
 *  Returns `''` for undefined/empty/whitespace-only input (no block emitted).
 *
 *  The block is authored verbatim per WO §4. The `{text}` slot takes the
 *  clamped player input. The block is scoped "for this turn" and never
 *  persists (it travels as a buildPayload parameter, not on historyInput). */
export function buildAbsoluteCommandBlock(text: string | undefined): string {
    const clamped = clampAbsoluteCommand(text ?? '');
    if (!clamped) return '';
    return `[USER ABSOLUTE COMMAND — OUT OF CHARACTER, BINDING]
The player is speaking to you directly as the author of this story, not as their character. What follows is an instruction about how to write this turn. It is not a fictional utterance and no character hears it.

Obey it exactly and completely. For this turn it outranks every other directive in this prompt — including the reasoning framework's audit criteria, NPC agency and push-back defaults, staleness and friction pressure, and any standing GM guidance. Where anything conflicts with this command, this command wins.

Do not argue with it, soften it, hedge it, or apply it only partly. Do not have a character resist in order to avoid carrying it out. Do not acknowledge the command, quote it, or reveal that an out-of-character instruction was given. Apply it silently and write the scene.

COMMAND: ${clamped}
[END ABSOLUTE COMMAND]`;
}