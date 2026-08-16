/**
 * locationEnrich.ts
 * -----------------
 * Background AI fill for freshly created location entries. Manual "Add Place"
 * and suggestion-accept both create empty shells (name only); on PRO/MAX tier
 * this enriches the shell from recent chat — description, broadLocation,
 * aliases, features, and connections to KNOWN places only.
 *
 * Doctrine: the LLM proposes, the sanitizer clamps, the engine writes. The
 * entry works fine unenriched (lite tier / no provider / failed call → shell
 * stays, player edits by hand). Enrichment only ever FILLS — it never
 * overwrites a non-empty field the player may have typed meanwhile.
 */

import type { ChatMessage, ProviderConfig, EndpointConfig, LocationEntry } from '../types';
import { llmCall } from '../utils/llmCall';
import { AI_CALL_TIMEOUT_MS } from './llm/timeouts';
import { connectionBand, resolvePlace } from './locationParser';
import { useAppStore } from '../store/useAppStore';
import { tierAllows } from './turn/aiTier';
import { toast } from '../components/Toast';

const MAX_FEATURES = 20;
const MAX_CONNECTIONS = 8;
const MAX_DESCRIPTION = 400;

type RawEnrich = {
    description?: unknown;
    broadLocation?: unknown;
    aliases?: unknown;
    features?: unknown;
    connections?: unknown;
};

function asTrimmedString(v: unknown, cap: number): string {
    if (typeof v !== 'string') return '';
    return v.trim().slice(0, cap);
}

/**
 * Clamp a raw model response into a safe patch for `entry`. Pure — unit-tested.
 * - fills only fields that are currently empty on the entry
 * - features merge-deduped (case-insensitive) into the existing list, capped
 * - connections resolved against the ledger (known places only, no self,
 *   no duplicates, capped); returned as full LocationConnection[]
 */
export function sanitizeEnrichPatch(
    raw: RawEnrich,
    entry: LocationEntry,
    ledger: LocationEntry[],
): Partial<LocationEntry> {
    const patch: Partial<LocationEntry> = {};

    const description = asTrimmedString(raw.description, MAX_DESCRIPTION);
    if (description && !entry.description) patch.description = description;

    const broadLocation = asTrimmedString(raw.broadLocation, 60);
    if (broadLocation && !entry.broadLocation) patch.broadLocation = broadLocation;

    const aliasesRaw = Array.isArray(raw.aliases) ? raw.aliases.filter(a => typeof a === 'string').join(', ') : raw.aliases;
    const aliases = asTrimmedString(aliasesRaw, 120);
    if (aliases && !entry.aliases && aliases.toLowerCase() !== entry.name.toLowerCase()) patch.aliases = aliases;

    if (Array.isArray(raw.features)) {
        const merged = [...entry.features];
        const seen = new Set(merged.map(f => f.toLowerCase()));
        for (const f of raw.features) {
            if (typeof f !== 'string') continue;
            const trimmed = f.trim();
            if (!trimmed || trimmed.length > 60) continue;
            const key = trimmed.toLowerCase();
            if (seen.has(key) || key === entry.name.toLowerCase()) continue;
            if (merged.length >= MAX_FEATURES) break;
            seen.add(key);
            merged.push(trimmed);
        }
        if (merged.length > entry.features.length) patch.features = merged;
    }

    if (Array.isArray(raw.connections)) {
        const conns = entry.connections.map(c => ({ ...c }));
        for (const name of raw.connections) {
            if (typeof name !== 'string') continue;
            const other = resolvePlace(name, ledger);
            if (!other || other.id === entry.id) continue;
            if (conns.some(c => c.toId === other.id)) continue;
            if (conns.length >= MAX_CONNECTIONS) break;
            conns.push({ toId: other.id, band: 'local' });
        }
        if (conns.length > entry.connections.length) patch.connections = conns;
    }

    return patch;
}

async function fetchEnrichment(
    provider: ProviderConfig | EndpointConfig,
    messages: ChatMessage[],
    entry: LocationEntry,
    ledger: LocationEntry[],
): Promise<RawEnrich | null> {
    const recent = messages.slice(-10)
        .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');
    const knownNames = ledger
        .filter(l => l.id !== entry.id)
        .map(l => l.name)
        .join(', ') || '(none)';

    const prompt = `You are filling in a location ledger entry for a text RPG. Based on the recent chat, write structured data for the place "${entry.name}".

=== OTHER KNOWN PLACES ===
${knownNames}

=== RECENT CHAT ===
${recent}

=== INSTRUCTIONS ===
Return ONLY a JSON object, no prose, no markdown:
{
  "description": "1-2 concrete sentences about this place, grounded in the chat (plausible genre-fitting texture if the chat says little)",
  "broadLocation": "parent region/city/district, or empty string if unknown",
  "aliases": "comma-separated alternative names actually used in the chat, or empty string",
  "features": ["rooms or sub-areas of this place mentioned or clearly implied"],
  "connections": ["names from OTHER KNOWN PLACES this place directly connects to"]
}

Rules:
- Only state what the chat supports or strongly implies. Empty string / empty array when unsure.
- connections: ONLY names from the OTHER KNOWN PLACES list. Never invent places here.
- Keep description under 2 sentences.`;

    try {
        const result = await llmCall(provider, prompt, {
            priority: 'low',
            trackingLabel: 'location-enrich',
            timeoutMs: AI_CALL_TIMEOUT_MS,
        });
        let text = result;
        const md = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (md) text = md[1];
        const objMatch = text.match(/\{[\s\S]*\}/);
        if (!objMatch) return null;
        const parsed = JSON.parse(objMatch[0]);
        return (parsed && typeof parsed === 'object') ? parsed as RawEnrich : null;
    } catch (e) {
        console.warn('[LocationEnrich] Call failed (non-fatal):', e);
        return null;
    }
}

export type EnrichInput = {
    raw: RawEnrich;
    entry: LocationEntry;
    ledger: LocationEntry[];
};

/** Pure location-enrichment logic: plain model data in, a clamped patch out. */
export function computeEnrichment(input: EnrichInput): Partial<LocationEntry> {
    return sanitizeEnrichPatch(input.raw, input.entry, input.ledger);
}

/**
 * Fire-and-forget enrichment for a just-created entry. Reads everything it
 * needs from the live store; silently no-ops when the tier gate is closed
 * (lite) or no provider is configured. Campaign-switch guarded: the patch is
 * dropped if the active campaign changed while the call was in flight.
 */
export function queueLocationEnrichment(entryId: string): void {
    const s = useAppStore.getState();
    const campaignId = s.activeCampaignId;
    if (!campaignId) return;
    if (!tierAllows(s.settings.aiTier, 'locationEnrich')) return;
    const provider = s.getActiveSummarizerEndpoint() ?? s.getActiveUtilityEndpoint() ?? s.getActiveStoryEndpoint();
    if (!provider) return;
    const entry = s.locationLedger.find(l => l.id === entryId);
    if (!entry) return;

    void (async () => {
        const raw = await fetchEnrichment(provider, s.messages, entry, s.locationLedger);
        if (!raw) return;
        const now = useAppStore.getState();
        if (now.activeCampaignId !== campaignId) {
            console.warn('[LocationEnrich] Dropping patch — campaign switched');
            return;
        }
        // Re-read the entry: the player may have edited it while we were in flight.
        const fresh = now.locationLedger.find(l => l.id === entryId);
        if (!fresh) return;
        const patch = computeEnrichment({ raw, entry: fresh, ledger: now.locationLedger });
        if (Object.keys(patch).length === 0) return;
        now.updateLocation(entryId, patch);
        // Bidirectional default for any connections we added.
        if (patch.connections) {
            const after = useAppStore.getState();
            for (const conn of patch.connections) {
                const other = after.locationLedger.find(l => l.id === conn.toId);
                if (other && !other.connections.some(c => c.toId === entryId)) {
                    after.updateLocation(other.id, {
                        connections: [...other.connections, { toId: entryId, band: connectionBand(conn) }],
                    });
                }
            }
        }
        toast.success(`Filled in "${fresh.name}".`);
    })();
}
