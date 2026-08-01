/**
 * locationParser.ts
 * -----------------
 * Post-turn **location state estimator** — the place-analogue of inventoryParser.
 * Sends recent history + the current location ledger to the LLM and asks
 * "where is the PC now?". Returns an updated ledger (features/connections
 * merged into existing entries), the resolved current-place pointer, and a
 * cap-bounded list of new-place suggestions (never auto-added — the player
 * decides in the LocationLedgerModal).
 *
 * Doctrine: state estimation, not event detection. Every commit it answers
 * "where is the PC now?" from recent text against a closed vocabulary (known
 * places + their features + connections + `new`/`unclear` escapes). Wrong
 * answers are cheap and self-heal next turn; `unclear` keeps the last known
 * place. The parser is the safety net — never trust raw model output.
 */

import type { ChatMessage, ProviderConfig, EndpointConfig, LocationEntry, LocationSuggestion, LocationConnection } from '../types';
import { llmCall } from '../utils/llmCall';
import { AI_CALL_TIMEOUT_MS } from './llm/timeouts';
import type { ModelRequest, ModelResponse } from './turn/hostFacade';

export type LocationScanResult = {
    ledger: LocationEntry[];            // updated ledger (features/connections merged into existing entries)
    currentPlaceId: string | null;      // resolved id, or unchanged input value when 'unclear'
    currentFeature: string | null;
    suggestions: LocationSuggestion[];  // NEW places — never auto-added
};

// ── Model output shape (parsed, then validated by applyLocationOps) ────────
type RawCurrent = { place: string; feature: string | null };
type RawNewPlace = { name: string; broadLocation?: string; connectedTo?: string; context?: string };
type RawUpdate = { place: string; addFeatures?: string[]; addConnections?: string[] };
type RawScan = {
    current: RawCurrent;
    newPlaces?: RawNewPlace[];
    updates?: RawUpdate[];
};

const MAX_SUGGESTIONS = 2;
const MAX_FEATURES = 20;
const MAX_CONNECTIONS = 8;

/** Build the "KNOWN PLACES" block for the estimator prompt. */
function buildKnownPlaces(ledger: LocationEntry[]): string {
    if (ledger.length === 0) return '(none yet)';
    return ledger.map(e => {
        const connected = e.connections
            .map(c => {
                const tgt = ledger.find(x => x.id === c.toId);
                return tgt ? tgt.name : '';
            })
            .filter(Boolean);
        return `{"id":"${e.id}","name":"${e.name}","aliases":"${e.aliases}","features":[${e.features.map(f => `"${f}"`).join(',')}],"connectedTo":[${connected.map(n => `"${n}"`).join(',')}]}`;
    }).join('\n');
}

/** Resolve a place-name string (case-insensitive, loose) to a ledger entry id. */
export function resolvePlace(name: string, ledger: LocationEntry[]): LocationEntry | undefined {
    const target = name.trim().toLowerCase();
    if (!target || target === 'unclear' || target === 'new') return undefined;
    // Exact name match first
    let hit = ledger.find(e => e.name.toLowerCase() === target);
    if (hit) return hit;
    // Alias exact match
    hit = ledger.find(e =>
        e.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean).includes(target)
    );
    if (hit) return hit;
    // Loose: name startswith / endswith target (single-token target only, to avoid false hits)
    if (target.split(/\s+/).length === 1) {
        hit = ledger.find(e => {
            const n = e.name.toLowerCase();
            return n.startsWith(target + ' ') || n.endsWith(' ' + target);
        });
        if (hit) return hit;
    }
    return undefined;
}

export async function scanLocation(
    provider: ProviderConfig | EndpointConfig | undefined,
    messages: ChatMessage[],
    ledger: LocationEntry[],
    currentPlaceId: string | null,
    currentFeature: string | null = null,
    modelCall?: (request: ModelRequest) => Promise<ModelResponse>
): Promise<LocationScanResult> {
    const recentMessages = messages.slice(-6);
    if (recentMessages.length === 0) {
        return { ledger, currentPlaceId, currentFeature, suggestions: [] };
    }

    const turns = recentMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    const currentName = (currentPlaceId ? ledger.find(e => e.id === currentPlaceId)?.name : undefined) ?? 'unknown';

    const prompt = `You are a location tracker for a text RPG. Determine where the player character is NOW, at the end of the recent chat below. This is state estimation, not event detection: answer from the text's current situation, not from movement verbs.

=== KNOWN PLACES ===
${buildKnownPlaces(ledger)}
CURRENT (last known): ${currentName}

=== RECENT CHAT ===
${turns}

=== INSTRUCTIONS ===
Return ONLY a JSON object, no prose, no markdown:
{
  "current": {"place": "<known place name/alias | NEW place name | unclear>", "feature": "<feature name within that place, or null>"},
  "newPlaces": [{"name": "", "broadLocation": "", "connectedTo": "<known place name>", "context": "<5-10 word quote>"}],
  "updates": [{"place": "<known place name>", "addFeatures": [], "addConnections": ["<known place name>"]}]
}

Rules:
- Prefer a KNOWN place over declaring a new one. Match loosely against names and aliases.
- "unclear" if the text does not establish where the PC is. When in doubt, "unclear" — the last known place then stands.
- newPlaces: only places the PC is AT or that are concretely established as adjacent scenery. Never places merely mentioned in dialogue, memories, or stories.
- updates: only rooms/features and connections the text actually establishes for known places.
- If nothing changed: {"current":{"place":"unclear","feature":null},"newPlaces":[],"updates":[]}`;

    try {
        const result = modelCall
            ? (await modelCall({ prompt, priority: 'low', trackingLabel: 'location-scan', timeoutMs: AI_CALL_TIMEOUT_MS })).content
            : provider
                ? await llmCall(provider, prompt, { priority: 'low', trackingLabel: 'location-scan', timeoutMs: AI_CALL_TIMEOUT_MS })
                : '';
        let text = result;
        const md = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (md) text = md[1];
        // Extract the outermost JSON object
        const objMatch = text.match(/\{[\s\S]*\}/);
        if (!objMatch) {
            return { ledger, currentPlaceId, currentFeature, suggestions: [] };
        }
        let parsed: RawScan;
        try {
            parsed = JSON.parse(objMatch[0]);
        } catch {
            return { ledger, currentPlaceId, currentFeature, suggestions: [] };
        }
        if (!parsed || typeof parsed !== 'object') {
            return { ledger, currentPlaceId, currentFeature, suggestions: [] };
        }
        return applyLocationOps(parsed, ledger, currentPlaceId, currentFeature);
    } catch (e) {
        console.error('[LocationParser]', e);
        return { ledger, currentPlaceId, currentFeature, suggestions: [] };
    }
}

/**
 * Pure application of a parsed model response to the ledger + pointer.
 * Exported for unit tests. Mirrors inventoryParser.applyOps contract:
 * - returns current state unchanged on any invalid input shape
 * - resolves the model's `current.place` against ledger name+aliases (case-insensitive)
 * - no match and not declared NEW → treat as `unclear` → keep last pointer
 * - new places go to `suggestions` ONLY (capped at 2); never into the ledger
 * - addFeatures/addConnections only target existing entries; dedupe case-insensitively
 * - connections stored one-directionally; when adding A→B also add B→A if absent
 * - touches lastSeenScene on the resolved current entry
 */
export function applyLocationOps(
    raw: RawScan,
    ledger: LocationEntry[],
    currentPlaceId: string | null,
    currentFeature: string | null = null,
): LocationScanResult {
    if (!raw || typeof raw !== 'object') {
        return { ledger, currentPlaceId, currentFeature, suggestions: [] };
    }
    const next = ledger.map(e => ({ ...e, features: [...e.features], connections: e.connections.map(c => ({ ...c })) }));
    const sceneId = String(Date.now());

    // ── Resolve current place ──────────────────────────────────────────
    let newCurrentId = currentPlaceId;
    let newCurrentFeature: string | null = currentFeature;
    // `resolved` is true ONLY when the model returned a known place we matched
    // this turn. "unclear"/"new"/no-match all leave it false, so lastSeenScene
    // is NOT touched (per workorder: "unclear → return everything unchanged").
    let resolved = false;

    const cur = raw.current;
    if (cur && typeof cur === 'object' && typeof cur.place === 'string') {
        const placeStr = cur.place.trim();
        const lower = placeStr.toLowerCase();
        if (lower === 'unclear' || placeStr === '') {
            // Keep last pointer untouched; do NOT touch lastSeenScene (we don't know)
        } else if (lower === 'new') {
            // The model declared a NEW place but it's in newPlaces; don't move pointer.
            // Keep last known.
        } else {
            const resolvedEntry = resolvePlace(placeStr, next);
            if (resolvedEntry) {
                newCurrentId = resolvedEntry.id;
                newCurrentFeature = (typeof cur.feature === 'string' && cur.feature.trim())
                    ? cur.feature.trim()
                    : null;
                resolved = true;
            }
            // No match and not "unclear"/"new" → treat as unclear (per hard rules)
        }
    }

    // Touch lastSeenScene ONLY when we resolved a known place this turn.
    if (resolved && newCurrentId) {
        const cur2 = next.find(e => e.id === newCurrentId);
        if (cur2) cur2.lastSeenScene = sceneId;
    }

    // ── Apply updates (addFeatures / addConnections to existing entries) ──
    const updates = Array.isArray(raw.updates) ? raw.updates : [];
    for (const upd of updates) {
        if (!upd || typeof upd !== 'object' || typeof upd.place !== 'string') continue;
        const target = resolvePlace(upd.place, next);
        if (!target) continue; // may only target existing entries
        // Features
        if (Array.isArray(upd.addFeatures)) {
            for (const f of upd.addFeatures) {
                if (typeof f !== 'string') continue;
                const trimmed = f.trim();
                if (!trimmed) continue;
                if (target.features.length >= MAX_FEATURES) break;
                const lower = trimmed.toLowerCase();
                if (target.features.some(x => x.toLowerCase() === lower)) continue;
                target.features.push(trimmed);
            }
        }
        // Connections
        if (Array.isArray(upd.addConnections)) {
            for (const connName of upd.addConnections) {
                if (typeof connName !== 'string') continue;
                const other = resolvePlace(connName, next);
                if (!other || other.id === target.id) continue;
                if (target.connections.length >= MAX_CONNECTIONS) break;
                // Forward A→B
                if (!target.connections.some(c => c.toId === other.id)) {
                    target.connections.push({ toId: other.id, band: 'short' });
                }
                // Reverse B→A (bidirectional default) — only if B has room
                if (other.connections.length < MAX_CONNECTIONS) {
                    if (!other.connections.some(c => c.toId === target.id)) {
                        other.connections.push({ toId: target.id, band: 'short' });
                    }
                }
            }
        }
    }

    // ── Collect suggestions (new places — never auto-added) ───────────
    const rawNewPlaces = Array.isArray(raw.newPlaces) ? raw.newPlaces : [];
    const suggestions: LocationSuggestion[] = [];
    const seenLower = new Set<string>();
    for (const np of rawNewPlaces) {
        if (!np || typeof np !== 'object' || typeof np.name !== 'string') continue;
        const name = np.name.trim();
        if (!name) continue;
        const lower = name.toLowerCase();
        if (seenLower.has(lower)) continue;
        // Skip if already in ledger (name or alias)
        if (resolvePlace(name, next)) continue;
        if (suggestions.length >= MAX_SUGGESTIONS) break;
        seenLower.add(lower);
        suggestions.push({
            name,
            connectedTo: (typeof np.connectedTo === 'string' && np.connectedTo.trim()) ? np.connectedTo.trim() : undefined,
            context: (typeof np.context === 'string' && np.context.trim()) ? np.context.trim() : undefined,
            firstSeen: Date.now(),
        });
    }

    return {
        ledger: next,
        currentPlaceId: newCurrentId,
        currentFeature: newCurrentFeature,
        suggestions,
    };
}

/** Rebase additive scanner changes onto live state without overwriting edits made in flight. */
export function mergeLocationScanLedger(
    baseline: LocationEntry[],
    scanned: LocationEntry[],
    live: LocationEntry[],
): LocationEntry[] {
    const baselineById = new Map(baseline.map(entry => [entry.id, entry]));
    const scannedById = new Map(scanned.map(entry => [entry.id, entry]));
    let changed = false;

    const merged = live.map(entry => {
        const before = baselineById.get(entry.id);
        const after = scannedById.get(entry.id);
        if (!before || !after) return entry;

        const beforeFeatures = new Set(before.features.map(feature => feature.toLowerCase()));
        const features = [...entry.features];
        const liveFeatures = new Set(features.map(feature => feature.toLowerCase()));
        for (const feature of after.features) {
            const key = feature.toLowerCase();
            if (beforeFeatures.has(key) || liveFeatures.has(key) || features.length >= MAX_FEATURES) continue;
            features.push(feature);
            liveFeatures.add(key);
        }

        const beforeConnections = new Set(before.connections.map(connection => connection.toId));
        const connections = entry.connections.map(connection => ({ ...connection }));
        const liveConnections = new Set(connections.map(connection => connection.toId));
        for (const connection of after.connections) {
            if (beforeConnections.has(connection.toId) || liveConnections.has(connection.toId) || connections.length >= MAX_CONNECTIONS) continue;
            connections.push({ ...connection });
            liveConnections.add(connection.toId);
        }

        const lastSeenScene = after.lastSeenScene !== before.lastSeenScene
            ? after.lastSeenScene
            : entry.lastSeenScene;
        if (features.length === entry.features.length && connections.length === entry.connections.length && lastSeenScene === entry.lastSeenScene) return entry;
        changed = true;
        return { ...entry, features, connections, lastSeenScene };
    });

    return changed ? merged : live;
}
/** Helper used by the [LOCATION] volatile block + modal: find a connection's
 *  band label, falling back to 'short' when unset. */
export function connectionBand(c: LocationConnection): 'adjacent' | 'short' | 'long' {
    return c.band ?? 'short';
}