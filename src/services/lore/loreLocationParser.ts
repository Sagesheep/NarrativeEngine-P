import type { LoreChunk, LocationEntry, LocationConnection } from '../../types';

/**
 * loreLocationParser.ts
 * ---------------------
 * Zero-LLM seeder for the Location Ledger — the place-analogue of
 * loreNPCParser. Reads `category: 'location'` chunks out of a world-lore file
 * and turns them into ledger entries so the campaign starts with its canon
 * geography already known, instead of discovering it one estimator guess at a
 * time.
 *
 * Format (matches the shipped compendiums, e.g. Aethelgard):
 *
 *   ### LOCATION -- Caldera City (Caldera)
 *   **Type:** Capital city
 *   **Status:** Flourishing, politically tense
 *   The seat of the Calderan Crown. A walled city of stone and timber ...
 *
 * The header's trailing parenthetical is the broad location ("Caldera"); every
 * non-bullet line is the description prose. Optional author-authoritative
 * bullets — the one place lore can preseed ledger structure directly:
 *
 *   **Aliases:**        the capital, Calderaton      (comma-separated)
 *   **BroadLocation:**  Caldera                      (overrides the parenthetical)
 *   **Features:**       [Royal Keep, horse market, lower city]   (≤20)
 *   **ConnectedTo:**    [The Northern Marches, Veythar City]     (≤8)
 *   **Description:**    ...                          (overrides the prose)
 *   **Status:**         Flourishing                  (injected when set)
 *   **Type:**           Capital city                 (prefixes the description)
 *
 * Doctrine — three constraints the NPC seeder does not have:
 *
 * 1. DESCRIPTION IS BUDGETED. `[LOCATION]` (payload/volatile.ts) hard-caps the
 *    whole block at 400 chars and trims features → Nearby → blind slice. A raw
 *    lore paragraph (600–900 chars here) would eat the block and get cut
 *    mid-word, so descriptions are cut to whole sentences at parse time.
 * 2. CONNECTIONS ARE CLOSED. `**ConnectedTo:**` resolves only against places
 *    parsed from the same file — at import there is no other ledger to point
 *    at. Unresolvable names are dropped, not invented.
 * 3. `source: 'manual'`. 'llm' specifically marks estimator output and
 *    accepted suggestions; lore is hand-authored and should not be mistaken
 *    for a machine guess.
 *
 * Entries are born with empty firstSeenScene/lastSeenScene — the place is
 * known, not yet visited. The estimator stamps them on first arrival.
 */

// Keep in sync with locationParser.ts / locationHeader.ts.
const MAX_FEATURES = 20;
const MAX_CONNECTIONS = 8;

/**
 * Description budget. The `[LOCATION]` block caps at 400 chars total and must
 * still fit `At: <name> (<region>) — <status>` plus Nearby plus features, so
 * the prose gets a little over half. Cut on a sentence boundary — a lore
 * paragraph that survives to injection reads as prose, not as a fragment.
 */
const DESCRIPTION_CHAR_CAP = 240;

function newLocationId(): string {
    return `loc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Split the chunk header into a display name and the trailing parenthetical
 * region. Handles every dialect the chunker emits:
 *   `[CHUNK: LOCATION] Caldera City (Caldera)`
 *   `LOCATION -- Caldera City (Caldera)`
 *   `LOCATION — Caldera City`
 *   `Caldera City`
 */
export function parseLocationHeaderName(header: string): { name: string; broadLocation: string } {
    let name = header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();

    // Strip a leading `TYPE -- ` / `TYPE — ` marker (mirrors loreNPCParser).
    const doubleDash = name.match(/^[A-Z][A-Z_\s]*--\s*(.+)/);
    if (doubleDash) {
        name = doubleDash[1].trim();
    } else {
        const emDash = name.match(/^[A-Z][A-Z_\s]*[—–]\s*(.+)/);
        if (emDash) name = emDash[1].trim();
    }

    // Trailing parenthetical is the broad location: "Caldera City (Caldera)".
    let broadLocation = '';
    const paren = name.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    if (paren) {
        name = paren[1].trim();
        broadLocation = paren[2].trim();
    }

    return { name, broadLocation };
}

/** Cut `text` to whole sentences within `cap`. Falls back to a word-boundary
 *  cut with an ellipsis when even the first sentence overruns. */
export function trimToSentences(text: string, cap = DESCRIPTION_CHAR_CAP): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= cap) return clean;

    // Sentence-ish split that keeps the terminator attached.
    const sentences = clean.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) ?? [clean];
    let out = '';
    for (const sentence of sentences) {
        const next = (out + sentence).trimEnd();
        if (next.length > cap) break;
        out = out + sentence;
    }
    out = out.trim();
    if (out) return out;

    // First sentence alone is over budget — cut at the last word boundary.
    const hard = clean.slice(0, cap - 1);
    const lastSpace = hard.lastIndexOf(' ');
    return `${(lastSpace > cap / 2 ? hard.slice(0, lastSpace) : hard).trimEnd()}…`;
}

/**
 * Parse a world lore file's `## LOCATIONS` chunks into ledger entries.
 *
 * Duplicate names within the file collapse to the first occurrence — the
 * chunker splits oversized chunks into `#w0`/`#w1` windows that all carry the
 * same header, and a windowed location must not become two places.
 */
export function parseLocationsFromLore(chunks: LoreChunk[]): LocationEntry[] {
    const locations: LocationEntry[] = [];
    const seenNames = new Set<string>();
    /** name/alias (lowercased) → index into `locations`, for the connection pass. */
    const byName = new Map<string, number>();
    /** parsed index → raw `**ConnectedTo:**` names, resolved after every entry exists. */
    const pendingConnections = new Map<number, string[]>();

    for (const chunk of chunks.filter(c => c.category === 'location')) {
        const { name, broadLocation: headerRegion } = parseLocationHeaderName(chunk.header);
        if (!name) continue;

        const nameKey = name.toLowerCase();
        if (seenNames.has(nameKey)) continue;
        seenNames.add(nameKey);

        const body = chunk.content;

        const get = (field: string): string => {
            const m = body.match(new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, 'i'));
            return m ? m[1].trim() : '';
        };

        const getAny = (fields: string[]): string => {
            for (const field of fields) {
                const value = get(field);
                if (value) return value;
            }
            return '';
        };

        /** Bracketed or bare CSV list — same convention as loreNPCParser.getStringList. */
        const getList = (fields: string[]): string[] => {
            const raw = getAny(fields);
            if (!raw) return [];
            const stripped = raw.replace(/[[\]]/g, '').trim();
            if (!stripped) return [];
            return stripped.split(/[,;]|\s{2,}|\|/).map(s => s.trim()).filter(Boolean);
        };

        // Prose = every line that is not a `**Field:** value` bullet. This is
        // what the compendiums actually carry, so it is the description unless
        // the author wrote an explicit `**Description:**`.
        const prose = body
            .split('\n')
            .filter(line => !/^\s*\*\*[^*]+:\*\*/.test(line))
            .join(' ')
            .trim();

        const type = get('Type');
        const explicitDescription = getAny(['Description', 'Summary']);
        const rawDescription = explicitDescription || prose;
        // `**Type:**` has no field of its own on LocationEntry, and it is the
        // single most useful orienting word for the GM ("Capital city",
        // "Border region"). Lead the description with it rather than drop it.
        const withType = type && !rawDescription.toLowerCase().startsWith(type.toLowerCase())
            ? `${type.replace(/[.\s]+$/, '')}. ${rawDescription}`
            : rawDescription;

        const index = locations.length;
        const connectedTo = getList(['ConnectedTo', 'Connected To', 'Connections']);
        if (connectedTo.length > 0) pendingConnections.set(index, connectedTo);

        const aliases = getAny(['Aliases', 'Alias']);
        locations.push({
            id: newLocationId(),
            name,
            aliases,
            broadLocation: getAny(['BroadLocation', 'Broad Location', 'Region', 'Parent']) || headerRegion,
            features: getList(['Features', 'Rooms', 'Landmarks']).slice(0, MAX_FEATURES),
            connections: [],
            description: trimToSentences(withType),
            status: get('Status') || undefined,
            // Known from lore, not yet visited — the estimator stamps these on
            // the first turn the PC actually arrives.
            firstSeenScene: '',
            lastSeenScene: '',
            source: 'manual',
        });

        byName.set(nameKey, index);
        for (const alias of aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)) {
            if (!byName.has(alias)) byName.set(alias, index);
        }
    }

    // ── Connection pass ────────────────────────────────────────────────
    // Runs after every entry exists so a `**ConnectedTo:**` can name a place
    // declared later in the file. Bidirectional by default, matching
    // applyLocationOps; unresolvable names are dropped.
    for (const [fromIndex, names] of pendingConnections) {
        const from = locations[fromIndex];
        for (const rawName of names) {
            const toIndex = byName.get(rawName.toLowerCase());
            if (toIndex === undefined || toIndex === fromIndex) continue;
            const to = locations[toIndex];
            if (from.connections.length >= MAX_CONNECTIONS) break;
            if (!from.connections.some((c: LocationConnection) => c.toId === to.id)) {
                from.connections.push({ toId: to.id, band: 'local' });
            }
            if (to.connections.length < MAX_CONNECTIONS && !to.connections.some((c: LocationConnection) => c.toId === from.id)) {
                to.connections.push({ toId: from.id, band: 'local' });
            }
        }
    }

    return locations;
}
