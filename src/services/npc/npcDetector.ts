import type { NPCEntry, EndpointConfig, ProviderConfig } from '../../types';
import type { ModelRequest, ModelResponse } from '../turn/hostFacade';
import { llmCall } from '../../utils/llmCall';
import { extractJson } from '../chatEngine';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import TITLES from '../../data/titles.json';

const TITLES_SET = new Set(TITLES.map(t => t.toLowerCase()));
const NAME_CONNECTIVES = new Set(['of', 'the', 'von', 'de', 'di', 'al', 'el', 'ibn', 'bin']);

const GENERIC_ROLE_PATTERN = /^(guard|scout|merchant|soldier|bandit|thug|villager|citizen|patron|cultist|goblin|orc|skeleton|zombie|enemy|monster|creature|clone|drone|knight|priest|mage|wizard|archer|thief)\s+([a-z0-9]|#\d+)$/i;

const NPC_NAME_BLOCKLIST = new Set([
    // articles / connectives / prepositions
    "you", "i", "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "with", "by", "about", "like", "through", "over", "before", "between", "after", "since", "without", "under", "within", "along", "following", "across", "behind", "beyond", "plus", "except", "up", "out", "around", "down", "off", "above", "near",
    // pronouns
    "she", "he", "it", "they", "them", "we", "us", "his", "her", "their", "our", "your", "my", "mine",
    // sentence starters / discourse markers
    "then", "suddenly", "meanwhile", "however", "although", "therefore", "otherwise", "inside", "outside", "perhaps", "maybe", "indeed", "certainly", "instead", "still", "also", "only", "just", "even", "yet", "soon", "later", "now", "today", "tomorrow", "yesterday", "finally", "eventually", "overall", "moreover", "furthermore", "nevertheless", "nonetheless", "regardless", "anyway", "anyhow", "besides", "actually", "really", "very", "quite", "rather", "somewhat", "always", "never", "often", "sometimes", "rarely", "seldom", "usually", "occasionally",
    // weekdays / months
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
    // common sentence-initial nouns/adjectives
    "every", "each", "all", "some", "any", "no", "none", "many", "few", "several", "most", "more", "less", "much", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "first", "second", "third", "last", "next", "previous", "another", "other", "same", "different",
    "what", "when", "where", "why", "who", "how", "which", "whose", "that", "this", "these", "those", "here", "there",
    "wait", "well", "okay", "ok", "yes", "yep", "no", "nope", "sure", "fine", "good", "great", "nice", "bad", "right", "wrong", "true", "false",
    "not", "but",
    // dice / mechanics terms
    "catastrophe", "failure", "success", "triumph", "fumble", "critical", "crit", "advantage", "disadvantage", "normal", "natural", "encounter", "surprise", "world", "event", "skill", "check", "save", "saving", "throw", "roll", "rolls", "dice", "die", "result", "outcome", "modifier", "bonus", "penalty",
    // narrative meta words
    "equipment", "inventory", "scene", "chapter", "act", "session", "turn", "round", "phase", "time", "day", "night", "morning", "afternoon", "evening", "dawn", "dusk", "midnight", "noon",
    "academy", "adventure", "story", "tale", "narrative", "system",
    // structures & locations (common nouns capitalized in titles)
    "gate", "wall", "hall", "tower", "bridge", "mouth", "square", "market",
    "outpost", "garrison", "district", "quarter", "road", "path", "bay",
    "canal", "harbor", "harbour", "port", "keep", "fortress", "castle",
    "temple", "shrine", "chapel", "tavern", "inn", "manor", "estate",
    "forest", "mountain", "valley", "river", "lake", "sea", "ocean",
    "north", "south", "east", "west", "northern", "southern", "eastern", "western",
    "upper", "lower", "old", "new", "great", "grand",
]);

// Contraction suffix pattern — straight and curly apostrophes
const CONTRACTION_SUFFIX_RE = /['’](s|re|t|ve|ll|d|m)$/i;

// Structural/location words that invalidate two-word Pass-7 candidates.
// All words previously listed here are already covered by NPC_NAME_BLOCKLIST (structures &
// locations section above), so this set holds only words that are structural but NOT in the
// blocklist. Currently empty after dedup — extend here for future structural words not in
// the blocklist.
const STRUCTURAL_WORDS = new Set<string>([
    // (intentionally empty — all structural location words live in NPC_NAME_BLOCKLIST above)
]);

// Maximum Pass-7 (two consecutive capitals) candidates admitted per turn.
// Pass 7 is the weakest heuristic; when the LLM validator is offline (fail-closed →
// rejects everything), an uncapped Pass 7 floods the ledger with false positives.
const PASS7_MAX_PER_TURN = 5;

// Bounded speech attribution verbs
const SPEECH_VERBS = 'said|asked|whispered|shouted|replied|muttered|growled|spoke|called|answered|continued|added|cried|yelled|barked|snapped|hissed|murmured|breathed|intoned|declared|announced|exclaimed|demanded|ordered|commanded|pleaded|begged|insisted|admitted|confessed|offered|suggested|noted|observed|remarked|commented|explained|stated';

function isValidCandidate(raw: string, excludeSet: Set<string>, genericPattern: RegExp, blocklist: Set<string>): boolean {
    if (raw.length < 2) return false;
    if (raw.includes(' ') && raw === raw.toUpperCase()) return false;
    if (blocklist.has(raw.toLowerCase())) return false;
    if (genericPattern.test(raw)) return false;
    if (excludeSet.has(raw.toLowerCase())) return false;
    return true;
}

function stripTitle(raw: string): string {
    const parts = raw.split(/\s+/);
    if (parts.length === 0) return raw;
    const firstLower = parts[0].toLowerCase();
    if (TITLES_SET.has(firstLower)) {
        const remainder = parts.slice(1).join(' ').trim();
        return remainder.length > 0 ? remainder : '';
    }
    return raw;
}

export function extractNPCNames(content: string, excludeNames: string[] = []): string[] {
    const candidates = new Set<string>();
    const excludeSet = new Set(excludeNames.map(n => n.toLowerCase()));

    const tryAdd = (raw: string) => {
        if (!raw || raw.length < 2) return;
        if (CONTRACTION_SUFFIX_RE.test(raw)) return;
        const stripped = stripTitle(raw);
        if (!stripped || stripped.length < 2) return;
        if (CONTRACTION_SUFFIX_RE.test(stripped)) return;
        if (!isValidCandidate(stripped, excludeSet, GENERIC_ROLE_PATTERN, NPC_NAME_BLOCKLIST)) return;
        const tokens = stripped.split(/\s+/);
        if (tokens.length > 1) {
            const hasBadToken = tokens.some(t => {
                const tl = t.toLowerCase();
                return !NAME_CONNECTIVES.has(tl) && NPC_NAME_BLOCKLIST.has(tl);
            });
            if (hasBadToken) return;
        }
        candidates.add(stripped);
    };

    // Pass 1: [Name] and [**Name**]
    for (const m of content.matchAll(/\[\*{0,2}([A-Za-z][A-Za-z0-9 _.'-]*[A-Za-z0-9.])\*{0,2}\]/g)) {
        tryAdd(m[1].trim());
    }

    // Pass 2: [SYSTEM: NPC_ENTRY - Name]
    for (const m of content.matchAll(/\[SYSTEM:\s*NPC_ENTRY\s*[-–—]\s*([A-Za-z][A-Za-z0-9 _'-]*)\]/gi)) {
        tryAdd(m[1].trim());
    }

    // Pass 3: Title-prefixed — "Captain Aldric", "Instructor Roderick Vaul"
    for (const m of content.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z''’-]+){1,3})\b/g)) {
        const raw = m[1].trim();
        if (TITLES_SET.has(raw.split(/\s+/)[0].toLowerCase())) {
            tryAdd(raw);
        }
    }

    // Pass 4a: Name followed by speech verb — "Aldric said", "Maren whispered"
    const nameVerbRe = new RegExp(
        `\\b([A-Z][a-z''\\u2019-]+(?:\\s+[A-Z][a-z''\\u2019-]+){0,2})\\s+(?:${SPEECH_VERBS})\\b`, 'g'
    );
    for (const m of content.matchAll(nameVerbRe)) {
        tryAdd(m[1].trim());
    }

    // Pass 4b: Speech verb followed by name — "said Aldric", "whispered Maren"
    const verbNameRe = new RegExp(
        `\\b(?:${SPEECH_VERBS})\\s+([A-Z][a-z''\\u2019-]+(?:\\s+[A-Z][a-z''\\u2019-]+){0,2})\\b`, 'g'
    );
    for (const m of content.matchAll(verbNameRe)) {
        tryAdd(m[1].trim());
    }

    // Pass 5a: Role-apposition — "the merchant Orin", "an innkeeper Bram"
    for (const m of content.matchAll(/\b(?:[Tt]he|[Aa]n?)\s+\w+\s+([A-Z][a-z’'-]+(?:\s+[A-Z][a-z’'-]+){0,2})\b/g)) {
        tryAdd(m[1].trim());
    }

    // Pass 5b: Named/called introduction — "a man named Bram", "called Orin"
    for (const m of content.matchAll(/\b(?:[Nn]amed|[Cc]alled)\s+([A-Z][a-z’'-]+(?:\s+[A-Z][a-z’'-]+){0,2})\b/g)) {
        tryAdd(m[1].trim());
    }

    // Pass 6: Connective names — "Aldric of Westhold", "Elara von Mire"
    for (const m of content.matchAll(/\b([A-Z][a-z''’-]+\s+(?:of|von|de|di|al|el|ibn|bin)\s+[A-Z][a-z''’-]+)\b/g)) {
        tryAdd(m[1].trim());
    }

    // Pass 7: Two consecutive capitalized non-blocklisted, non-structural, non-title tokens — "Seraphine Thornmere"
    // Capped at PASS7_MAX_PER_TURN to prevent false-positive floods when the LLM validator
    // is offline (fail-closed → rejects all candidates, leaving unvalidated Pass-7 names in the ledger).
    let pass7Count = 0;
    for (const m of content.matchAll(/\b([A-Z][a-z''’-]+)\s+([A-Z][a-z''’-]+)\b/g)) {
        if (pass7Count >= PASS7_MAX_PER_TURN) break;
        const [, a, b] = m;
        if (
            !CONTRACTION_SUFFIX_RE.test(a) && !CONTRACTION_SUFFIX_RE.test(b) &&
            !NPC_NAME_BLOCKLIST.has(a.toLowerCase()) && !NPC_NAME_BLOCKLIST.has(b.toLowerCase()) &&
            !STRUCTURAL_WORDS.has(a.toLowerCase()) && !STRUCTURAL_WORDS.has(b.toLowerCase()) &&
            !TITLES_SET.has(a.toLowerCase()) && !TITLES_SET.has(b.toLowerCase())
        ) {
            const sizeBefore = candidates.size;
            tryAdd(`${a} ${b}`);
            if (candidates.size > sizeBefore) pass7Count++;
        }
    }

    return Array.from(candidates);
}

export function classifyNPCNames(
    names: string[],
    ledger: NPCEntry[],
    excludeNames: string[] = []
): { newNames: string[]; existingNpcs: NPCEntry[] } {
    const excludeSet = new Set(excludeNames.map(n => n.toLowerCase()));

    const normalized = names.map(n =>
        n === n.toUpperCase() && n.length > 1 ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : n
    );
    const uniqueNames = Array.from(new Set(normalized)).filter(n => !excludeSet.has(n.toLowerCase()));

    const newNames: string[] = [];
    const existingNpcs: NPCEntry[] = [];

    for (const potentialName of uniqueNames) {
        const existingNpc = ledger.find(npc => {
            if (!npc.name) return false;
            const aliasesRaw = npc.aliases || '';
            const allNames = [npc.name, ...aliasesRaw.split(',').map(a => a.trim())].filter(Boolean);
            const search = potentialName.toLowerCase();
            return allNames.some(n => {
                const lower = n.toLowerCase();
                return lower === search || lower.startsWith(search + ' ') || lower.endsWith(' ' + search);
            });
        });

        if (!existingNpc) {
            newNames.push(potentialName);
        } else {
            existingNpcs.push(existingNpc);
        }
    }

    return { newNames, existingNpcs };
}

export async function validateNPCCandidates(
    provider: EndpointConfig | ProviderConfig | undefined,
    candidates: string[],
    narrativeContext: string,
    modelCall?: (request: ModelRequest) => Promise<ModelResponse>
): Promise<string[]> {
    if (candidates.length === 0) return candidates;

    console.log(`[NPC Validator] Validating ${candidates.length} candidates against LLM semantic filter...`);

    const shortContext = narrativeContext.slice(-1000);

    const prompt = `You are a strict data filter for a fantasy RPG.
Given a short narrative context and a list of bracketed terms extracted from it, return ONLY the ones that are actual character or NPC names.
Exclude skill checks, game mechanics, actions, meta-tags, stats, spell names, locations, and any other non-name terms.

[NARRATIVE CONTEXT]
${shortContext}

[CANDIDATE NAMES TO FILTER]
${candidates.join(', ')}

Respond ONLY with a valid JSON array of strings containing the true character names. Make no other commentary.
If none are character names, respond with [].
Example: ["Captain Aldric", "Orin"]`;

    try {
        const raw = modelCall
            ? (await modelCall({ prompt, priority: 'low', trackingLabel: 'npc-validate', timeoutMs: AI_CALL_TIMEOUT_MS })).content
            : provider
                ? await llmCall(provider, prompt, { priority: 'low', trackingLabel: 'npc-validate', timeoutMs: AI_CALL_TIMEOUT_MS })
                : '';

        if (raw) {
            const cleanStr = extractJson(raw);
            const parsed = JSON.parse(cleanStr);
            if (Array.isArray(parsed)) {
                const validLower = new Set(parsed.map(s => String(s).toLowerCase()));
                const filtered = candidates.filter(c => validLower.has(c.toLowerCase()));
                console.log(`[NPC Validator] Filtered ${candidates.length} down to ${filtered.length}:`, filtered);
                return filtered;
            }
        }
    } catch (err) {
        console.warn(`[NPC Validator] API failure — rejecting all candidates this pass:`, err);
        return [];
    }

    return [];
}
