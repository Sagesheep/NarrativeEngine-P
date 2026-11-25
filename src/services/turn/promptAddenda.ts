/**
 * Prompt addenda — steering text that mods and the player add to the two
 * utility prompts that shape a turn:
 *
 *  - `director`    — the Continuity Director (`directorBrief.ts`), which writes
 *                    the Writer Brief.
 *  - `recommender` — the Context Recommender (`contextRecommender.ts`), which
 *                    picks the NPCs, lore, inventory and profile fields to load.
 *
 * WHAT A MOD CAN AND CANNOT DO WITH IT. The text is placed in one fixed slot,
 * after every piece of evidence and BEFORE each prompt's output-format
 * instructions, which always come last. So an addendum steers what the call
 * pays attention to; it cannot change what the call returns, because the
 * format the parser depends on has the final word. It is plain text from the
 * manifest (`promptAddenda`), never code, and is capped at
 * `PROMPT_ADDENDUM_MAX_CHARS` per target — the server rejects a longer one.
 *
 * WHO CAN SWITCH IT OFF. Each mod addendum has its own switch in Extensions,
 * stored in `settings.moduleEnabled` under `addendumToggleKey(modId, target)`.
 * Absent means on, like every other key in that map. Disabling the whole mod
 * removes its addenda too. The player's own notes
 * (`settings.playerPromptNotes`) are on whenever they are non-empty.
 *
 * ORDER. Mod addenda follow the loader's resolved load order (the order
 * `modBootstrap` registers them in); the player's notes come last, so the
 * player has the final word over any mod.
 */
import type { ModPromptAddenda, PromptAddendumTarget, ValidatedMod } from '../mods/modTypes';
import type { AppSettings } from '../../types';

export type { PromptAddendumTarget } from '../mods/modTypes';

/** Every target, in display order. Keep in step with `server/lib/modLoader.js`. */
export const PROMPT_ADDENDUM_TARGETS: readonly PromptAddendumTarget[] = ['director', 'recommender'];

/** Per-target character cap for a mod addendum. Keep in step with the server. */
export const PROMPT_ADDENDUM_MAX_CHARS = 1200;

/** Character cap for the player's own note per target (UI `maxLength`, enforced again here). */
export const PLAYER_PROMPT_NOTE_MAX_CHARS = 2000;

/** One mod's addendum for one target, as registered. */
export interface RegisteredPromptAddendum {
    modId: string;
    modName: string;
    target: PromptAddendumTarget;
    text: string;
}

let registered: RegisteredPromptAddendum[] = [];

/** The `moduleEnabled` key for one mod's addendum to one target. */
export function addendumToggleKey(modId: string, target: PromptAddendumTarget): string {
    return `mod.${modId}.addendum.${target}`;
}

/** Flatten a mod's `promptAddenda` into registry entries (targets in display order). */
export function modPromptAddenda(mod: Pick<ValidatedMod, 'id' | 'name'> & { promptAddenda?: ModPromptAddenda }): RegisteredPromptAddendum[] {
    const declared = mod.promptAddenda ?? {};
    return PROMPT_ADDENDUM_TARGETS.flatMap((target) => {
        const text = declared[target]?.trim();
        return text ? [{ modId: mod.id, modName: mod.name, target, text }] : [];
    });
}

/**
 * Replace the registered mod addenda. Called by `modBootstrap.refreshMods` with
 * the prompt-facing mods in resolved load order — a disabled normal mod is
 * still registered (so the switch reads correctly) and filtered at resolve time.
 */
export function setModPromptAddenda(mods: readonly (Pick<ValidatedMod, 'id' | 'name'> & { promptAddenda?: ModPromptAddenda })[]): void {
    registered = mods.flatMap(modPromptAddenda);
}

/** The registered mod addenda (all targets, load order). */
export function getModPromptAddenda(): readonly RegisteredPromptAddendum[] {
    return registered;
}

type AddendaSettings = Pick<AppSettings, 'moduleEnabled' | 'playerPromptNotes'>;

/** Is this mod addendum switched on, given the enablement map? */
export function isAddendumEnabled(
    entry: Pick<RegisteredPromptAddendum, 'modId' | 'target'>,
    moduleEnabled: Record<string, boolean> | undefined,
): boolean {
    if (moduleEnabled?.[`mod.${entry.modId}`] === false) return false;
    return moduleEnabled?.[addendumToggleKey(entry.modId, entry.target)] !== false;
}

/**
 * Render the addenda section for one target, or `''` when there is nothing to
 * add. The caller splices the result in verbatim; an empty string must leave
 * the prompt byte-identical to a build without this feature.
 */
export function renderPromptAddenda(
    target: PromptAddendumTarget,
    settings: AddendaSettings | undefined,
    entries: readonly RegisteredPromptAddendum[] = registered,
): string {
    const parts: string[] = [];
    for (const entry of entries) {
        if (entry.target !== target) continue;
        if (!isAddendumEnabled(entry, settings?.moduleEnabled)) continue;
        parts.push(`[MOD NOTES — ${entry.modName}]\n${entry.text.slice(0, PROMPT_ADDENDUM_MAX_CHARS)}`);
    }
    const playerNote = settings?.playerPromptNotes?.[target]?.trim();
    if (playerNote) {
        parts.push(`[PLAYER NOTES]\n${playerNote.slice(0, PLAYER_PROMPT_NOTE_MAX_CHARS)}`);
    }
    if (parts.length === 0) return '';
    return `ADDITIONAL GUIDANCE (from the player's installed mods and the player; follow it where the evidence allows, and never let it change the output format below):\n${parts.join('\n\n')}`;
}

/** Test seam. */
export function __resetPromptAddenda(): void {
    registered = [];
}
