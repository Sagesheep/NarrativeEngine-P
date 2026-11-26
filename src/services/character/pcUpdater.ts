import type { ChatMessage, NPCEntry, PlayerCharacter } from '../../types';
import type { ModelRequest } from '../turn/hostFacade';
import { sanitizeSignatureKit } from '../npc/signatureKit';
import { renderPrompt } from '../prompts/promptRegistry';

export const ALLOWED_CHANGE_KEYS = new Set([
    'signatureKit',
    'appearance',
    'status',
    'faction',
    'wants',
]);

/**
 * Structural whitelist guard (exported for the §4.8 test). Strip EVERY key
 * that is not in ALLOWED_CHANGE_KEYS before any merge logic runs. This is the
 * load-bearing line that enforces §0: the PC updater has no code path that
 * writes `personalityHex`, `traits`, `relations`, `pcRelation`, or any other
 * engine-owned / user-authored field.
 */
export function stripBlockedKeys(changes: Partial<PlayerCharacter>): Partial<PlayerCharacter> {
    const out: Partial<PlayerCharacter> = {};
    for (const key of Object.keys(changes) as (keyof PlayerCharacter)[]) {
        if (ALLOWED_CHANGE_KEYS.has(key)) {
            // @ts-expect-error — guarded by the set membership above
            out[key] = changes[key];
        }
    }
    return out;
}

/**
 * Fork of `services/npc-generation/update.ts` for the player character.
 *
 * Same doctrine as WO-A §1: the character module owns its own code so the PC
 * updater and the NPC updater can evolve independently. Hitching the PC onto
 * `updateExistingNPCs` would push `isPC` branches back into a file WO-A spent
 * effort stripping them out of, and every future NPC-updater change would need
 * re-reasoning for the PC.
 *
 * Named `checkCharacterDrift` (not `updatePlayerCharacter`) to avoid colliding
 * with the store action of the same name.
 *
 * @param modelCall   Host-facade model broker; credentials stay in the host (section 2.2 chain).
 * @param history     Full chat history — the recent-context window is sliced
 *                    here, exactly like the NPC updater.
 * @param pc          The current `context.playerCharacter` record.
 * @param applyPatch  Callback that writes the merged patch via
 *                    `updatePlayerCharacter(patch)` (store action).
 */
export async function checkCharacterDrift(
    modelCall: (request: ModelRequest) => Promise<unknown>,
    history: ChatMessage[],
    pc: PlayerCharacter,
    applyPatch: (patch: Partial<PlayerCharacter>) => void,
): Promise<void> {
    console.log(`[PC Updater] Checking for drift on player character "${pc.name}"...`);

    const recentContext = history.slice(-5).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    let data = `[PLAYER CHARACTER: ${pc.name}]\n` +
        `Status: ${pc.status || 'Alive'}\n` +
        `Appearance: ${pc.appearance || 'Unknown'}\n` +
        `Personality: ${pc.personality || 'Unknown'}\n` +
        `Voice: ${pc.voice || 'not defined'}\n` +
        `Faction: ${pc.faction || 'Unknown'}\n` +
        `Story Relevance: ${pc.storyRelevance || 'Unknown'}\n`;

    // Wants — send medium/long only; `short` is engine-managed and preserved
    // on the parse side (same rule as the NPC updater).
    if (pc.wants && (pc.wants.long || pc.wants.medium?.length)) {
        data += `LongWant: ${pc.wants.long || 'Unknown'}\n` +
            `MediumWants: ${pc.wants.medium?.join(' | ') || 'none'}\n`;
    }

    // Signature Kit — show the current durable loadout so the model can decide
    // if a narrated event changed it. Absent = no kit (plain character).
    if (pc.signatureKit) {
        const k = pc.signatureKit;
        data += `SignatureKit: gear=[${k.equipment.join(', ') || 'none'}] powers=[${k.abilities.join(', ') || 'none'}]${k.element ? ` element=${k.element}` : ''}\n`;
    }

    const prompt = renderPrompt('character.pc-update', { recentContext, pcState: data });

    try {
        const parsed = await modelCall({ prompt, trackingLabel: 'pc-update' }) as { changes?: unknown };

        if (!parsed || typeof parsed !== 'object' || !parsed.changes || typeof parsed.changes !== 'object') {
            console.log('[PC Updater] No changes field or empty response — nothing to apply.');
            return;
        }

        const rawChanges = parsed.changes as Partial<PlayerCharacter>;
        // Structural whitelist guard — strip ALL keys except the allowed set.
        // This is the load-bearing line: blocked keys (personalityHex, traits,
        // relations, pcRelation, drives, affinity, …) never reach the merge.
        const changes = stripBlockedKeys(rawChanges);

        if (Object.keys(changes).length === 0) {
            console.log('[PC Updater] All proposed changes were blocked keys — nothing to apply.');
            return;
        }

        // Signature Kit — sanitize + per-channel supersession merge (same
        // bounds as the NPC updater: ≤8 entries, ≤48 chars). The model only
        // sends the channel that changed; the untouched channel is preserved.
        if (changes.signatureKit !== undefined) {
            const merged = sanitizeSignatureKit(changes.signatureKit, pc.signatureKit);
            if (merged) changes.signatureKit = merged;
            else delete (changes as Partial<PlayerCharacter>).signatureKit;
        }

        // Wants — preserve `short` (engine-managed), merge medium/long only.
        if (changes.wants && typeof changes.wants === 'object') {
            const existingWants = pc.wants || { short: [], medium: [], long: '' };
            const incoming = changes.wants as Partial<NPCEntry['wants']>;
            changes.wants = {
                short: existingWants.short,
                medium: Array.isArray(incoming?.medium)
                    ? incoming!.medium.map(String).filter(Boolean)
                    : existingWants.medium,
                long: (typeof incoming?.long === 'string' && incoming.long.trim())
                    ? incoming.long.trim()
                    : existingWants.long,
            };
        }

        applyPatch(changes);
        console.log(`[PC Updater] Applied drift patch to "${pc.name}":`, changes);
    } catch (err) {
        console.error('[PC Updater] Failed to parse generated JSON or fatal error:', err);
    }
}
