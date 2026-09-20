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
import { LOCATION_BIOMES, requestPlacementContext, sanitizePlacement } from './location/placement';
import { DISTANCE_BANDS } from './location/distance';

const MAX_FEATURES = 20;
const MAX_CONNECTIONS = 8;
const MAX_DESCRIPTION = 400;

type RawEnrich = {
    knowledge?: unknown;
    knowledgeNote?: unknown;
    placement?: unknown;
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
    if (!entry.knowledge && !entry.coordinates && (raw.knowledge === 'known' || raw.knowledge === 'rumoured')) {
        patch.knowledge = raw.knowledge === 'known' ? 'known' : 'rumoured';
        patch.knowledgeNote = asTrimmedString(raw.knowledgeNote, 240);
    }
    const placement = sanitizePlacement(raw.placement, entry, ledger);
    if (placement) patch.placement = placement;

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
        for (const connection of raw.connections) {
            const name = typeof connection === 'string' ? connection : connection?.place;
            if (typeof name !== 'string') continue;
            const other = ledger.find(place => place.id === name) ?? resolvePlace(name, ledger);
            if (!other || other.id === entry.id) continue;
            if (conns.some(c => c.toId === other.id)) continue;
            if (conns.length >= MAX_CONNECTIONS) break;
            const band = typeof connection === 'object' ? DISTANCE_BANDS.find(band => band.id === connection?.band)?.id : undefined;
            conns.push({ toId: other.id, band: band ?? 'local' });
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
    mapContext: string | null,
): Promise<RawEnrich | null> {
    const recent = messages.slice(-10)
        .map(m => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');
    const knownNames = ledger
        .filter(l => l.id !== entry.id)
        .map(l => JSON.stringify({ id: l.id, name: l.name, coordinates: l.coordinates }))
        .join(', ') || '(none)';

    const prompt = `You are filling in a location ledger entry for a text RPG. Based on the recent chat, write structured data for the place "${entry.name}".

=== EXISTING PLACE DETAILS (preserve established facts) ===
${JSON.stringify({ name: entry.name, description: entry.description, broadLocation: entry.broadLocation, features: entry.features })}

=== OTHER KNOWN PLACES ===
${knownNames}

=== MAP CONTEXT ===
${mapContext ?? 'Map unavailable. Do not invent player coordinates or explored terrain.'}

=== RECENT CHAT ===
${recent}

=== INSTRUCTIONS ===
Return ONLY a JSON object, no prose, no markdown:
{
  "knowledge": "rumoured",
  "knowledgeNote": "what the character actually learned about its whereabouts, or empty string",
  "description": "1-2 concrete sentences about this place, grounded in the chat (plausible genre-fitting texture if the chat says little)",
  "broadLocation": "parent region/city/district, or empty string if unknown",
  "aliases": "comma-separated alternative names actually used in the chat, or empty string",
  "features": ["rooms or sub-areas of this place mentioned or clearly implied"],
  "connections": [{"place":"known place id", "band":"local"}],
  "placement": {"referencePlaceId":null, "distanceBand":null, "direction":null, "preferredBiomes":[], "biomePolicy":"required", "biomeRadius":8, "coordinates":null, "reason":"brief geographic justification"}
}

Rules:
- knowledge is known only if the character has reliable directions, an exact map, or direct observation; otherwise rumoured. Merely hearing a destination name does not establish its exact whereabouts. Never mark visited or secret through enrichment. knowledgeNote must contain only information actually learned, not hidden world facts.
- Only state what the chat supports or strongly implies. Empty string / empty array when unsure.
- connections: ONLY ids or names from OTHER KNOWN PLACES. Supply the supported distance band; never infer a direct road merely because a destination was mentioned.
- placement describes this destination, NEVER movement or arrival. Use player XY and biome plus the explored extents, terrain samples and known places in MAP CONTEXT.
- Distance bands (map cells): ${DISTANCE_BANDS.map(band => band.id + '=' + band.minGrids + '..' + band.maxGrids).join(', ')}. Directions n/ne/e/se/s/sw/w/nw use north = decreasing y and east = increasing x.
- First choose compatible known terrain at a narratively appropriate distance. Otherwise propose uncharted space where the engine can generate the needed biome around the point of interest. Use established description and explicit geographic facts before genre assumptions. A name alone is not terrain evidence: a tavern called The Frozen Heart may be in a desert.
- biomePolicy: required for explicit terrain requirements; preferred for optional associations (a hunting lodge near woodland); exception only for an explicitly established unusual setting (a magically frozen castle in a desert). Do not invent magical exceptions to resolve conflicts.
- For an exception, preferredBiomes describes the SURROUNDING terrain stated in the story, not the building material or interior. A frozen castle surrounded by desert uses desert; an explicitly icy enclave uses snow. Keep the exception in description and reason.
- biomeRadius is the outer transition radius in cells, 3..24: small enclaves 3..5, ordinary surroundings 8, broad explicitly established regions up to 24. Never expand a place into a regional biome without evidence. Preferred terrain never requires reshaping geography.
- preferredBiomes must use these exact ids: ${LOCATION_BIOMES.join(', ')}. Choose a short list of suitable alternatives, or [] if no special requirement.
- Explored directional extents are bounding limits, NOT proof that the enclosed rectangle is explored. Terrain samples are illustrative, NOT exhaustive. The engine checks exact explored cells.
- If fully explored, use suitable existing terrain; never request terrain replacement. If nothing fits, retain the biome requirement so the engine can report a conflict.
- coordinates is optional {"x":integer,"y":integer} within 0..999. Only supply an evidence-backed coordinate or a candidate supported by map context; the engine validates distance, occupancy and terrain. Otherwise null and let the engine choose.
- Existing saved coordinates are immutable. Omit placement for an already placed location. Return only the structured decision and a brief reason.
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
    const release = () => {
        const live = useAppStore.getState();
        if (live.activeCampaignId !== campaignId) return;
        const location = live.locationLedger.find(entry => entry.id === entryId);
        if (!location) return;
        live.updateLocation(entryId, { placementPendingUntil: undefined,
            ...(!location.knowledge && !location.coordinates ? { knowledge: live.context?.currentPlaceId === entryId ? 'visited' as const : 'rumoured' as const } : {}),
            ...(!location.coordinates && !location.placement ? { placement: { preferredBiomes: [] } } : {}) });
    };
    if (!tierAllows(s.settings.aiTier, 'locationEnrich')) { release(); return; }
    const provider = s.getActiveSummarizerEndpoint() ?? s.getActiveUtilityEndpoint() ?? s.getActiveStoryEndpoint();
    if (!provider) { release(); return; }
    const entry = s.locationLedger.find(l => l.id === entryId);
    if (!entry) return;

    void (async () => {
        const mapContext = await requestPlacementContext(campaignId);
        if (useAppStore.getState().activeCampaignId !== campaignId) return;
        const raw = await fetchEnrichment(provider, s.messages, entry, s.locationLedger, mapContext);
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
    })().catch(error => console.warn('[LocationEnrich]', error)).finally(release);
}
