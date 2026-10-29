import type { NPCEntry, GameContext, PlayerCharacter } from '../../types';

/**
 * WO-A rewrite 2 §2 — one-time, idempotent migration of a legacy `isPC: true`
 * row from `npcLedger` to `context.playerCharacter`.
 *
 * Old saves (pre-rewrite-2) stored the PC as a row inside `npcLedger` flagged
 * with `isPC: true`. The rewrite moves the PC out of the ledger entirely so
 * the NPC ledger, agency engine, updater, detector, review, and post-turn
 * pipeline never see it. This function folds any legacy `isPC` row into
 * `context.playerCharacter` and strips it from the ledger.
 *
 * Contract:
 *  - Idempotent: a second call on already-migrated state is a no-op.
 *  - First-write-wins on `playerCharacter`: if a PC already exists at
 *    `context.playerCharacter`, any stray `isPC` row in the ledger is just
 *    dropped (it's a duplicate from a buggy save path). The existing PC record
 *    is preserved untouched.
 *  - Pure: returns a new `{ context, npcLedger }` object; does not mutate input.
 *  - The migrated record keeps its `id`, `name`, `signatureKit`, `personalityHex`,
 *    `wants`, `voice`, `personality`, `visualProfile`, `portrait`, `pcMeta`,
 *    `traits`, and every other NPCEntry field. `isPC: true` is left in place on
 *    the migrated record — it is vestigial but harmless, and removing it would
 *    change the byte shape of the record mid-migration (and risk confusing any
 *    code that still defensively checks `isPC`).
 */
export function migratePCIntoContext(
    context: GameContext,
    npcLedger: NPCEntry[],
): { context: GameContext; npcLedger: NPCEntry[]; migrated: boolean } {
    const existingPc = context.playerCharacter ?? null;

    const pcRow = npcLedger.find(n => n.isPC);
    if (!pcRow) {
        return { context, npcLedger, migrated: false };
    }

    // Strip the PC row from the ledger. If multiple `isPC` rows exist (buggy
    // state), strip them all — only one PC is valid.
    const strippedLedger = npcLedger.filter(n => !n.isPC);

    if (existingPc) {
        // Already migrated. Drop the stray duplicate row but keep the existing
        // playerCharacter record untouched.
        return { context, npcLedger: strippedLedger, migrated: false };
    }

    const newContext: GameContext = { ...context, playerCharacter: pcRow as PlayerCharacter };
    return { context: newContext, npcLedger: strippedLedger, migrated: true };
}