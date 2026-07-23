import type { EndpointConfig, ProviderConfig, ChatMessage, NPCEntry, PlayerCharacter } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { sendMessage } from '../llm/llmService';
import { extractJson } from '../infrastructure/jsonExtract';
import { sanitizeSignatureKit } from '../npc/signatureKit';

const RETRY_SUFFIX = '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY valid JSON. No markdown fences, no comments, no trailing commas, no extra text before or after the JSON.';

// ── §3.2 divergences from the NPC original ──────────────────────────────────────
//
// 1. It is not an NPC. The block is labeled `[PLAYER CHARACTER: …]` and the
//    `Feeling toward PC:` line is dropped entirely (the PC's feeling toward
//    themselves is meaningless). `relations` and `pcRelation` are NOT in the
//    payload and NOT in the allowed-changes whitelist.
//
// 2. Narrower allowed-changes whitelist. The NPC updater lists
//    `personalityHex` and `traits` as updatable (update.ts:114). For the PC
//    that breaks §0 of WO-A2 — those fields are written ONLY by the quiz or
//    the user's own hand. The whitelist below is STRUCTURAL: there is no code
//    path here that writes a blocked field, so it cannot regress into one.
//
//   Allowed: signatureKit (merged via sanitizeSignatureKit), appearance, status,
//            faction, wants.
//   Blocked: personalityHex, traits, relations, pcRelation, drives, affinity,
//            behavioralTriggers, hardBoundaries, softBoundaries, visualProfile.
//
// 3. Cadence. Not wired here — the caller (postTurnPipeline) gates this on
//    the same `autoBookkeepingInterval` used by the bookkeeping scan, since
//    kit changes are rare and a per-turn call is a wasted call most turns.

async function sendAndParseJson(
    provider: EndpointConfig | ProviderConfig,
    messages: OpenAIMessage[],
    contextLabel: string,
    trackingLabel?: string,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ parsed: any; rawStr: string }> {
    let fullJsonStr = '';
    await sendMessage(
        provider,
        messages,
        (chunk) => { fullJsonStr = chunk; },
        () => { },
        (err) => console.error(`[${contextLabel}] Stream error:`, err),
        undefined,
        undefined,
        undefined,
        undefined,
        trackingLabel,
    );
    if (!fullJsonStr) throw new Error(`[${contextLabel}] Empty response from LLM`);
    const cleanStr = extractJson(fullJsonStr);
    try {
        return { parsed: JSON.parse(cleanStr), rawStr: cleanStr };
    } catch (firstErr) {
        console.warn(`[${contextLabel}] First parse failed, retrying with stricter prompt...`, firstErr);
        const retryMessages: OpenAIMessage[] = [
            ...messages,
            { role: 'assistant', content: fullJsonStr },
            { role: 'user', content: RETRY_SUFFIX },
        ];
        let retryStr = '';
        await sendMessage(
            provider,
            retryMessages,
            (chunk) => { retryStr = chunk; },
            () => { },
            (err) => console.error(`[${contextLabel}] Retry stream error:`, err),
            undefined,
            undefined,
            undefined,
            undefined,
            trackingLabel,
        );
        if (!retryStr) throw new Error(`[${contextLabel}] Empty retry response`);
        const retryClean = extractJson(retryStr);
        try {
            return { parsed: JSON.parse(retryClean), rawStr: retryClean };
        } catch (retryErr) {
            console.error(`[${contextLabel}] Retry parse also failed:`, retryErr);
            throw retryErr;
        }
    }
}

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
 * @param provider    Cheap-first endpoint resolved by the caller (§2.2 chain).
 * @param history     Full chat history — the recent-context window is sliced
 *                    here, exactly like the NPC updater.
 * @param pc          The current `context.playerCharacter` record.
 * @param applyPatch  Callback that writes the merged patch via
 *                    `updatePlayerCharacter(patch)` (store action).
 */
export async function checkCharacterDrift(
    provider: EndpointConfig | ProviderConfig,
    history: ChatMessage[],
    pc: PlayerCharacter,
    applyPatch: (patch: Partial<PlayerCharacter>) => void,
): Promise<void> {
    console.log(`[PC Updater] Checking for drift on player character "${pc.name}"...`);

    const recentContext = history.slice(-5).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    let data = `[PLAYER CHARACTER: ${pc.name}]\n` +
        `Status: ${pc.status || 'Alive'}\n` +
        `Appearance: ${pc.appearance || 'Unknown'}\n` +
        `Disposition: ${pc.disposition || 'Unknown'}\n` +
        `Personality: ${pc.personality || pc.disposition || 'Unknown'}\n` +
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

    const prompt = `You are a background game state analyzer. Your job is to read the RECENT CONTEXT of an RPG session and determine if the PLAYER CHARACTER has undergone a shift in their status, appearance, faction, or signature gear/powers.

OUTPUT FORMAT — a single JSON object:
{"changes": { ...only the fields that changed... }}

Allowed "changes" keys (send ONLY fields that fundamentally changed):
  status, appearance, faction, wants (medium/long text only — NEVER include "short"),
  signatureKit.
DO NOT include attributes that stayed the same. If nothing fundamental changed, "changes" is {}.

**FORBIDDEN keys** in "changes" (data-model errors — the engine owns these for the PC):
  - "personalityHex" / "traits" — written only by the player via the character sheet or quiz. NEVER send.
  - "drives" — superseded by "wants". Never send.
  - "affinity" / "pcRelation" / "relations" — relationship standing is engine-owned and meaningless for the PC. NEVER send.
  - "disposition", "voice", "personality", "storyRelevance", "behavioralTriggers", "hardBoundaries", "softBoundaries", "visualProfile" — out of scope for this updater.

SIGNATURE KIT RULES:
  - "signatureKit" is the player character's durable loadout: {"equipment": string[], "abilities": string[], "element": string}. It keeps gear and powers CONSISTENT across the campaign.
  - Only send it when the scene NARRATES a real change: the PC gains/loses/breaks a signature item, learns or loses a power, or is transformed. The PC merely *using* gear they already have is NOT a change — send nothing.
  - Send ONLY the channel that changed. To update gear, send just "equipment" (the full new signature list, max 8); to update powers, send just "abilities". Never re-emit an unchanged channel.
  - Default is NO change. Most turns have no signatureKit update.

WANTS UPDATE RULES:
  - "wants" is an object with "short" (string[]), "medium" (string[]), and "long" (string).
  - You may ONLY revise "medium" and "long". NEVER include "short" — it is engine-managed and always preserved. If you include "short", it will be discarded.
  - "long" is a single overarching life goal — update only if a transformative event reshaped it.
  - "medium" is arc-level goal templates — update if the story moved to a new arc.

GENERAL RULES:
- Valid statuses: Alive, Deceased, Missing, Unknown, In Custody.

EXAMPLES:

GOOD — PC's signature weapon was sundered on-screen (only the gear channel; powers untouched):
{"changes": {"signatureKit": {"equipment": ["backup dagger"]}}}

GOOD — PC joined a new faction after a major story beat:
{"changes": {"faction": "Ironspire Knights"}}

GOOD — ordinary scene, nothing fundamental changed:
{"changes": {}}

BAD — sending a FORBIDDEN/engine-owned key:
{"changes": {"personalityHex": {"boldness": +1}, "traits": ["brave"], "pcRelation": +1}}
Corrected: drop the forbidden keys entirely. The engine owns them.

BAD — re-emitting unchanged attributes (status/faction all unchanged here):
{"changes": {"status": "Alive", "faction": "Ironspire Knights", "appearance": "tall, dark hair"}}
Corrected: include ONLY the field that changed —
{"changes": {"appearance": "now bears a scar across the left eye"}}

[RECENT CONTEXT]
${recentContext}
[END CONTEXT]

[CURRENT PLAYER CHARACTER STATE]
${data}
[END STATE]

RESPOND ONLY WITH VALID JSON. NO MARKDOWN FORMATTING. NO EXPLANATIONS.`;

    const messages: OpenAIMessage[] = [{ role: 'user', content: prompt }];

    try {
        const { parsed } = await sendAndParseJson(provider, messages, 'PC Updater', 'pc-update');

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