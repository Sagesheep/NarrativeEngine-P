import type { NPCSignatureKit } from '../../types';

// Pure, dependency-light home for the signature-kit bounds + sanitizer. Kept out of
// npc-generation/shared.ts (which value-imports the LLM service) so zero-LLM consumers
// — notably the deterministic lore parser (services/lore/loreNPCParser.ts) — can reuse
// the exact same bounds without pulling the llm module graph into their import chain.
// shared.ts re-exports sanitizeSignatureKit for backward compatibility.

export const KIT_MAX_ENTRIES = 8;
export const KIT_ENTRY_MAXLEN = 48;
export const KIT_ELEMENT_MAXLEN = 20;

function cleanEntries(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map(x => String(x).replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .map(s => s.length > KIT_ENTRY_MAXLEN ? s.slice(0, KIT_ENTRY_MAXLEN).trim() : s)
        .slice(0, KIT_MAX_ENTRIES);
}

/**
 * Sanitize a raw signatureKit into a bounded, safe kit.
 * - `mergeInto` (optional): shallow-merge onto an existing kit so a partial update
 *   ("gained a new sword") does not wipe the other channel. Arrays REPLACE per-channel
 *   when present (supersession); absent channels keep the existing value.
 * Returns undefined if the result is empty (nothing to store).
 */
export function sanitizeSignatureKit(
    raw: unknown,
    mergeInto?: NPCSignatureKit,
): NPCSignatureKit | undefined {
    if (!raw || typeof raw !== 'object') return mergeInto;
    const r = raw as Record<string, unknown>;
    const base: NPCSignatureKit = mergeInto
        ? { equipment: [...mergeInto.equipment], abilities: [...mergeInto.abilities], element: mergeInto.element }
        : { equipment: [], abilities: [] };

    if ('equipment' in r) base.equipment = cleanEntries(r.equipment);
    if ('abilities' in r) base.abilities = cleanEntries(r.abilities);
    if ('element' in r) {
        const el = String(r.element ?? '').replace(/\s+/g, ' ').trim();
        base.element = el ? el.slice(0, KIT_ELEMENT_MAXLEN) : undefined;
    }

    if (base.equipment.length === 0 && base.abilities.length === 0 && !base.element) return undefined;
    return base;
}
