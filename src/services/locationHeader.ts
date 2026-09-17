/**
 * locationHeader.ts
 * -----------------
 * Engine-side parser for the scene header's `📍 [Location] …` field — the
 * per-turn HOT PATH of location tracking. The default ruleset
 * (rules/defaultRules.ts) instructs the GM to emit
 * `📅 [Time] | 📍 [Location] | 👥 [Present]` on every reply; this module is
 * the sibling of the 👥 [Present] parse in postTurnPipeline. Zero LLM, every
 * tier, runs on commit. The interval-gated scanLocation estimator remains the
 * cold path (features/connections enrichment).
 *
 * Fail-safe doctrine: header absent, empty, or unusable → NO-OP outcome; the
 * last known pointer stands. Unknown places are SUGGESTED, never auto-added.
 *
 * Place–feature rule: "Nero's Apartment — Living Room" is ONE place entry
 * ("Nero's Apartment") with "Living Room" as a feature + currentFeature. A
 * bare generic room label ("Kitchen") while a place is current is treated as
 * a feature of the current place, not a new place.
 */

import type { LocationEntry, LocationSuggestion } from '../types';
import { resolvePlace } from './locationParser';

/**
 * Accepts every observed scene-header dialect:
 *   `📍 [Location] Ninja Academy`   (default ruleset, defaultRules.ts:51)
 *   `📍 Location: Ninja Academy`    (labeled, no brackets)
 *   `📍 Town of Beginning - Back Alley` (bare pin — custom rulesets)
 * The optional label group must NOT eat a real place name, so it only
 * matches the literal word "location" with optional brackets/colon.
 */
const LOCATION_HEADER_RE = /📍\s*(?:\[?\s*location\s*\]?\s*:?\s*)?([^|\n]+)/gi;

/** Segment separators: spaced dashes (em/en/hyphen), colon, comma. A bare
 *  hyphen without surrounding spaces is NOT a separator ("Sakura-jima"). */
const SEGMENT_SPLIT_RE = /\s+[—–-]\s+|\s*[—–]\s*|\s*:\s+|\s*,\s+/;

/** Max raw header text we'll try to interpret — longer captures are almost
 *  certainly malformed output; ignore rather than guess. */
const MAX_RAW_LEN = 100;

const MAX_FEATURES = 20; // keep in sync with locationParser

/** Generic room/space words: when one of these appears with no resolvable
 *  place (e.g. header is just "Kitchen"), it's a feature of the CURRENT
 *  place — never a new-place suggestion. */
const GENERIC_ROOM_WORDS = new Set([
    'kitchen', 'living room', 'livingroom', 'bedroom', 'bathroom', 'toilet',
    'hallway', 'hall', 'corridor', 'balcony', 'basement', 'cellar', 'attic',
    'yard', 'courtyard', 'garden', 'garage', 'office', 'study', 'library',
    'classroom', 'storage', 'storage room', 'storeroom', 'lounge', 'foyer',
    'entrance', 'porch', 'rooftop', 'roof', 'closet', 'pantry', 'dining room',
    'stairs', 'staircase', 'lobby', 'reception', 'workshop', 'shed',
    'slum', 'slums', 'slum district', 'back alley', 'market district', 'residential district',
]);

export type LocationHeaderOutcome =
    | { kind: 'none' }                       // no header / unusable — no-op
    | {
        kind: 'resolved';                    // pointer moves to a known place
        placeId: string;
        feature: string | null;
        /** feature is new on that entry and should be appended (dedupe/cap already checked) */
        appendFeature: boolean;
      }
    | {
        kind: 'feature-only';                // same place, feature update only
        feature: string;
        appendFeature: boolean;              // true when not yet in the current entry's features
      }
    | { kind: 'unknown'; suggestion: LocationSuggestion };  // human-gated proposal

/** Extract the raw `📍 …` location text from a GM reply, or null. When the
 *  reply contains several 📍 lines (mid-reply scene shifts), the LAST one wins
 *  — the pointer should reflect where the scene ENDED. */
export function parseLocationHeader(content: string): string | null {
    const matches = [...content.matchAll(LOCATION_HEADER_RE)];
    if (matches.length === 0) return null;
    for (let i = matches.length - 1; i >= 0; i--) {
        // Defensive: cut at a following scene-header marker if the pipe was omitted.
        let raw = matches[i][1].split(/👥|📅/)[0].trim();
        // Reduce to PLAIN TEXT before any matching: models wrap the header in
        // brackets, bold, or quotes (`📍 [Town of Beginning - Market Square]`,
        // `**📍 Town**`). Parentheses become a segment break so
        // "Town (Market Square)" splits like "Town - Market Square".
        raw = raw
            .replace(/\(/g, ' - ')
            .replace(/[[\])*_`"«»]/g, '')
            .replace(/\s{2,}/g, ' ');
        // Strip leading/trailing decoration the model sometimes adds.
        raw = raw.replace(/^[\s\-–—:]+|[\s\-–—:|]+$/g, '').trim();
        if (raw && raw.length <= MAX_RAW_LEN) return raw;
    }
    return null;
}

/** Labels that normally describe an area within the current place rather than
 * a new world-level location. Used by both automatic headers and manual add. */
export function isLikelyFeatureLabel(value: string): boolean {
    const key = value.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key) return false;
    if (GENERIC_ROOM_WORDS.has(key)) return true;
    return /(?:^|\s)(?:base|summit|top|floor|level|wing|deck|platform|chamber|square|alley|courtyard|landing)$/.test(key);
}
function hasFeature(entry: LocationEntry, feature: string): boolean {
    const lower = feature.toLowerCase();
    return entry.features.some(f => f.toLowerCase() === lower);
}

function canAppendFeature(entry: LocationEntry, feature: string): boolean {
    return !hasFeature(entry, feature) && entry.features.length < MAX_FEATURES;
}

/**
 * Interpret a GM reply's location header against the ledger.
 *
 * Resolution order:
 * 1. Full raw string matches a known place → pointer there, no feature.
 * 2. Split into segments; first segment (left→right) that resolves to a known
 *    place is THE place. The first following segment that does NOT itself
 *    resolve to a place is the feature. Segments before the match (region
 *    prefixes like "Konoha — Academy") are ignored.
 * 3. Nothing resolves: if a current place is set and the raw text matches one
 *    of its features (or is a generic room word) → feature-only update.
 * 4. Otherwise → suggestion (first segment as the place name, full raw text
 *    as context). Never auto-added.
 */
export function resolveLocationHeader(
    content: string,
    ledger: LocationEntry[],
    currentPlaceId: string | null,
): LocationHeaderOutcome {
    const raw = parseLocationHeader(content);
    if (!raw) return { kind: 'none' };

    // 1. Whole-string match
    const whole = resolvePlace(raw, ledger);
    if (whole) {
        return { kind: 'resolved', placeId: whole.id, feature: null, appendFeature: false };
    }

    const segments = raw.split(SEGMENT_SPLIT_RE).map(s => s.trim()).filter(Boolean);

    // 2. Segment scan
    for (let i = 0; i < segments.length; i++) {
        const hit = resolvePlace(segments[i], ledger);
        if (!hit) continue;
        let feature: string | null = null;
        for (let j = i + 1; j < segments.length; j++) {
            // A later segment that is itself a known place (e.g. a region
            // suffix "…, Konoha") is context, not a feature of this place.
            if (resolvePlace(segments[j], ledger)) continue;
            feature = segments[j];
            break;
        }
        return {
            kind: 'resolved',
            placeId: hit.id,
            feature,
            appendFeature: feature !== null && canAppendFeature(hit, feature),
        };
    }

    // 3. Feature of the current place?
    const current = currentPlaceId ? ledger.find(l => l.id === currentPlaceId) : undefined;
    if (current && (segments.length === 1 || isLikelyFeatureLabel(segments[0]))) {
        for (const seg of [raw, ...segments]) {
            if (hasFeature(current, seg)) {
                return { kind: 'feature-only', feature: seg, appendFeature: false };
            }
        }
        for (const seg of [raw, ...segments]) {
            if (isLikelyFeatureLabel(seg)) {
                return { kind: 'feature-only', feature: seg, appendFeature: canAppendFeature(current, seg) };
            }
        }
    }

    // 4. Unknown place → human-gated suggestion. A bare generic room word with
    // no current place anchors nothing — stay a no-op rather than suggest
    // "Kitchen" as a world location.
    const name = segments[0] ?? raw;
    if (isLikelyFeatureLabel(name)) return { kind: 'none' };
    return {
        kind: 'unknown',
        suggestion: {
            name,
            context: raw !== name ? raw : undefined,
            firstSeen: Date.now(),
        },
    };
}

/** Commit-time bridge: only the scene header establishes a new current place.
 * Mentions elsewhere remain suggestions; local features never get world cells.
 */
export function anchorSceneLocation(
    content: string,
    ledger: LocationEntry[],
    currentPlaceId: string | null,
): { outcome: LocationHeaderOutcome; created?: LocationEntry } {
    const outcome = resolveLocationHeader(content, ledger, currentPlaceId);
    if (outcome.kind === 'resolved' || outcome.kind === 'feature-only') return { outcome };
    const raw = parseLocationHeader(content);
    if (!raw || /^(?:unknown|unclear|somewhere|undetermined|unknown location|unknown place)$/i.test(raw)) return { outcome: { kind: 'none' } };
    const segments = raw.split(SEGMENT_SPLIT_RE).map(part => part.trim()).filter(Boolean);
    let name = segments[0];
    let feature = segments.slice(1).join(' — ') || null;
    // A slum establishes urban surroundings, but not a named or sized city.
    if (isLikelyFeatureLabel(name)) {
        if (!/^(?:slum|slums|slum district|market district|residential district)$/i.test(name)) return { outcome: { kind: 'none' } };
        feature = segments.join(' — ');
        name = 'Unknown settlement';
    }
    const existing = resolvePlace(name, ledger);
    if (existing) return { outcome: { kind: 'resolved', placeId: existing.id, feature,
        appendFeature: feature !== null && canAppendFeature(existing, feature) } };
    const now = String(Date.now());
    const created: LocationEntry = {
        id: `loc_${now}_${crypto.randomUUID().slice(0, 8)}`, name,
        aliases: '', broadLocation: '', features: feature ? [feature] : [], connections: [],
        description: '', source: 'llm', kind: 'place', recordKind: 'place',
        firstSeenScene: now, lastSeenScene: now,
    };
    return { created, outcome: { kind: 'resolved', placeId: created.id, feature, appendFeature: false } };
}
