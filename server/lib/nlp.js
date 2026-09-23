/**
 * Pure NLP / text-analysis functions extracted from server.js.
 * No filesystem access, no external dependencies (JSON import inlined at bundle time).
 */

import TITLES from '../../src/data/titles.json' with { type: 'json' };

const TITLES_SET = new Set(TITLES.map(t => t.toLowerCase()));

const NAME_CONNECTIVES = new Set(['of', 'the', 'von', 'de', 'di', 'al', 'el', 'ibn', 'bin']);

const GENERIC_ROLE_PATTERN = /^(guard|scout|merchant|soldier|bandit|thug|villager|citizen|patron|cultist|goblin|orc|skeleton|zombie|enemy|monster|creature|clone|drone|knight|priest|mage|wizard|archer|thief)\s+([a-z0-9]|#\d+)$/i;

const NPC_NAME_BLOCKLIST = new Set([
    "you", "i", "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "with", "by", "about", "like", "through", "over", "before", "between", "after", "since", "without", "under", "within", "along", "following", "across", "behind", "beyond", "plus", "except", "up", "out", "around", "down", "off", "above", "near",
    "she", "he", "it", "they", "them", "we", "us", "his", "her", "their", "our", "your", "my", "mine",
    "then", "suddenly", "meanwhile", "however", "although", "therefore", "otherwise", "inside", "outside", "perhaps", "maybe", "indeed", "certainly", "instead", "still", "also", "only", "just", "even", "yet", "soon", "later", "now", "today", "tomorrow", "yesterday", "finally", "eventually", "overall", "moreover", "furthermore", "nevertheless", "nonetheless", "regardless", "anyway", "anyhow", "besides", "actually", "really", "very", "quite", "rather", "somewhat", "always", "never", "often", "sometimes", "rarely", "seldom", "usually", "occasionally",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
    "every", "each", "all", "some", "any", "no", "none", "many", "few", "several", "most", "more", "less", "much", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "first", "second", "third", "last", "next", "previous", "another", "other", "same", "different",
    "what", "when", "where", "why", "who", "how", "which", "whose", "that", "this", "these", "those", "here", "there",
    "wait", "well", "okay", "ok", "yes", "yep", "no", "nope", "sure", "fine", "good", "great", "nice", "bad", "right", "wrong", "true", "false",
    "not", "but",
    "catastrophe", "failure", "success", "triumph", "fumble", "critical", "crit", "advantage", "disadvantage", "normal", "natural", "encounter", "surprise", "world", "event", "skill", "check", "save", "saving", "throw", "roll", "rolls", "dice", "die", "result", "outcome", "modifier", "bonus", "penalty",
    "equipment", "inventory", "scene", "chapter", "act", "session", "turn", "round", "phase", "time", "day", "night", "morning", "afternoon", "evening", "dawn", "dusk", "midnight", "noon",
    "academy", "adventure", "story", "tale", "narrative", "system",
    "gate", "wall", "hall", "tower", "bridge", "mouth", "square", "market",
    "outpost", "garrison", "district", "quarter", "road", "path", "bay",
    "canal", "harbor", "harbour", "port", "keep", "fortress", "castle",
    "temple", "shrine", "chapel", "tavern", "inn", "manor", "estate",
    "forest", "mountain", "valley", "river", "lake", "sea", "ocean",
    "north", "south", "east", "west", "northern", "southern", "eastern", "western",
    "upper", "lower", "old", "new", "great", "grand",
]);

const CONTRACTION_SUFFIX_RE = /['\u2019](s|re|t|ve|ll|d|m)$/i;

// Structural/location words that invalidate two-word Pass-7 candidates.
// All words previously listed here are already covered by NPC_NAME_BLOCKLIST (structures &
// locations section above), so this set holds only words that are structural but NOT in the
// blocklist. Currently empty after dedup — extend here for future structural words not in
// the blocklist.
const STRUCTURAL_WORDS = new Set([
    // (intentionally empty — all structural location words live in NPC_NAME_BLOCKLIST above)
]);

/**
 * Escape a string for literal use inside a RegExp.
 *
 * NPC names come from the model's prose, so they can contain `.`, `(`, `+`
 * or `[`. Built into a pattern unescaped, a name like `C++ Bot` throws
 * ("Nothing to repeat") and `Mr. Vale` also matches `Mrx Vale`.
 */
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const SPEECH_VERBS = 'said|asked|whispered|shouted|replied|muttered|growled|spoke|called|answered|continued|added|cried|yelled|barked|snapped|hissed|murmured|breathed|intoned|declared|announced|exclaimed|demanded|ordered|commanded|pleaded|begged|insisted|admitted|confessed|offered|suggested|noted|observed|remarked|commented|explained|stated';

function isValidCandidate(raw, genericPattern, blocklist, excludeSet) {
    if (raw.length < 2) return false;
    if (raw.includes(' ') && raw === raw.toUpperCase()) return false;
    if (blocklist.has(raw.toLowerCase())) return false;
    if (genericPattern.test(raw)) return false;
    if (excludeSet && excludeSet.has(raw.toLowerCase())) return false;
    return true;
}

function stripTitle(raw) {
    const parts = raw.split(/\s+/);
    if (parts.length === 0) return raw;
    const firstLower = parts[0].toLowerCase();
    if (TITLES_SET.has(firstLower)) {
        const remainder = parts.slice(1).join(' ').trim();
        return remainder.length > 0 ? remainder : '';
    }
    return raw;
}

/**
 * Extract keywords from raw text for the archive index.
 * Captures: proper nouns (capitalised 3+ char words), quoted strings,
 * [MEMORABLE: ...] tags from the condenser.
 */
export function extractIndexKeywords(text) {
    const keywords = new Set();
    // Proper nouns — capitalised words 3+ chars
    const properNouns = text.match(/[A-Z][A-Za-z]{2,}(?:\s[A-Z][A-Za-z]{2,})*/g) || [];
    const stopWords = new Set(['The', 'And', 'For', 'Are', 'But', 'Not', 'You', 'All', 'Can', 'Has',
        'Was', 'One', 'His', 'Her', 'Had', 'May', 'Who', 'Been', 'Some', 'They', 'Will', 'Each', 'That',
        'This', 'With', 'From', 'Then', 'When', 'What', 'Where', 'There', 'Those', 'These', 'User', 'Scene']);
    for (const noun of properNouns) {
        if (!stopWords.has(noun)) keywords.add(noun.toLowerCase());
    }
    // Quoted strings — e.g. "I will return"
    const quoted = text.match(/"([^"]{4,60})"/g) || [];
    for (const q of quoted) keywords.add(q.replace(/"/g, '').toLowerCase().trim());
    // [MEMORABLE: ...] tags from condenser
    const memorable = text.match(/\[MEMORABLE:\s*"([^"]+)"\]/g) || [];
    for (const m of memorable) {
        const inner = m.match(/\[MEMORABLE:\s*"([^"]+)"\]/);
        if (inner) keywords.add(inner[1].toLowerCase().trim());
    }
    return Array.from(keywords).slice(0, 20);
}

/**
 * Extract NPC names using 6 high-precision passes.
 * Pass 7 (two-capitalized-tokens) is deliberately omitted because the
 * server has no LLM validator to filter false positives.
 *
 * @param {string} text - The assistant / narrative text to scan.
 * @param {number} [maxNames=15] - Hard cap on returned names.
 * @param {string[]} [excludeNames=[]] - Names to exclude (e.g. player-character names).
 *   The archive route currently passes no excludeNames because the route receives only
 *   userContent + assistantContent; it has no access to a player-character roster at call
 *   time. Pass an array here if a future caller gains that context.
 */
export function extractNPCNames(text, maxNames = 15, excludeNames = []) {
    const candidates = [];
    const seen = new Set();
    const excludeSet = excludeNames.length > 0
        ? new Set(excludeNames.map(n => n.toLowerCase()))
        : null;

    const tryAdd = (raw) => {
        if (!raw || raw.length < 2) return;
        if (CONTRACTION_SUFFIX_RE.test(raw)) return;
        const stripped = stripTitle(raw);
        if (!stripped || stripped.length < 2) return;
        if (CONTRACTION_SUFFIX_RE.test(stripped)) return;
        if (!isValidCandidate(stripped, GENERIC_ROLE_PATTERN, NPC_NAME_BLOCKLIST, excludeSet)) return;
        const tokens = stripped.split(/\s+/);
        if (tokens.length > 1) {
            const hasBadToken = tokens.some(t => {
                const tl = t.toLowerCase();
                return !NAME_CONNECTIVES.has(tl) && NPC_NAME_BLOCKLIST.has(tl);
            });
            if (hasBadToken) return;
        }
        const key = stripped.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            candidates.push(stripped);
        }
    };

    // Pass 1: [Name] and [**Name**]
    for (const m of text.matchAll(/\[\*{0,2}([A-Za-z][A-Za-z0-9 _.'-]*[A-Za-z0-9.])\*{0,2}\]/g)) {
        tryAdd(m[1].trim());
    }

    // Pass 2: [SYSTEM: NPC_ENTRY - Name]
    for (const m of text.matchAll(/\[SYSTEM:\s*NPC_ENTRY\s*[-\u2013\u2014]\s*([A-Za-z][A-Za-z0-9 _'-]*)\]/gi)) {
        tryAdd(m[1].trim());
    }

    // Pass 3: Title-prefixed — "Captain Aldric", "Instructor Roderick Vaul"
    for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z''\u2019-]+){1,3})\b/g)) {
        const raw = m[1].trim();
        if (TITLES_SET.has(raw.split(/\s+/)[0].toLowerCase())) {
            tryAdd(raw);
        }
    }

    // Pass 4a: Name followed by speech verb — "Aldric said"
    const nameVerbRe = new RegExp(
        `\\b([A-Z][a-z''\\u2019-]+(?:\\s+[A-Z][a-z''\\u2019-]+){0,2})\\s+(?:${SPEECH_VERBS})\\b`, 'g'
    );
    for (const m of text.matchAll(nameVerbRe)) {
        tryAdd(m[1].trim());
    }

    // Pass 4b: Speech verb followed by name — "said Aldric"
    const verbNameRe = new RegExp(
        `\\b(?:${SPEECH_VERBS})\\s+([A-Z][a-z''\\u2019-]+(?:\\s+[A-Z][a-z''\\u2019-]+){0,2})\\b`, 'g'
    );
    for (const m of text.matchAll(verbNameRe)) {
        tryAdd(m[1].trim());
    }

    // Pass 5a: Role-apposition — "the merchant Orin", "an innkeeper Bram"
    for (const m of text.matchAll(/\b(?:[Tt]he|[Aa]n?)\s+\w+\s+([A-Z][a-z\u2019'-]+(?:\s+[A-Z][a-z\u2019'-]+){0,2})\b/g)) {
        tryAdd(m[1].trim());
    }

    // Pass 5b: Named/called introduction — "a man named Bram", "called Orin"
    for (const m of text.matchAll(/\b(?:[Nn]amed|[Cc]alled)\s+([A-Z][a-z\u2019'-]+(?:\s+[A-Z][a-z\u2019'-]+){0,2})\b/g)) {
        tryAdd(m[1].trim());
    }

    // Pass 6: Connective names — "Aldric of Westhold", "Elara von Mire"
    for (const m of text.matchAll(/\b([A-Z][a-z''\u2019-]+\s+(?:of|von|de|di|al|el|ibn|bin)\s+[A-Z][a-z''\u2019-]+)\b/g)) {
        tryAdd(m[1].trim());
    }

    return candidates.slice(0, maxNames);
}

/**
 * Estimate intrinsic importance of a scene (1-10) based on content patterns.
 * No LLM call — pure heuristic.
 */
export function estimateImportance(text) {
    const lower = text.toLowerCase();
    let importance = 3;

    if (/\b(killed|slain|died|defeated|destroyed|executed|murdered|sacrificed)\b/.test(lower)) importance += 3;
    if (/\[MEMORABLE:/.test(text)) importance += 2;
    if (/\b(king|queen|emperor|empress|lord|lady|prince|princess|archmage|general|commander|champion)\b/.test(lower)) importance += 1;
    if (/\b(acquired|obtained|rewarded|treasure|legendary|artifact|enchanted)\b/.test(lower)) importance += 1;
    if (/\b(quest|mission|objective|prophecy|oath|vow|alliance|betrayal|treaty)\b/.test(lower)) importance += 1;

    return Math.min(10, importance);
}

/**
 * Extract graded keyword strengths (0-1) from text.
 * Strength based on: frequency, position (early = stronger), memorable association.
 */
export function extractKeywordStrengths(text, keywords) {
    const lower = text.toLowerCase();
    const strengths = {};
    const textLen = lower.length;

    for (const kw of keywords) {
        const kwLower = kw.toLowerCase();
        let strength = 0;
        let count = 0;
        let pos = 0;
        while ((pos = lower.indexOf(kwLower, pos)) !== -1) {
            count++;
            if (pos < textLen * 0.2) strength += 0.3;
            pos += kwLower.length;
        }
        if (count >= 3) strength += 0.6;
        else if (count >= 2) strength += 0.4;
        else if (count >= 1) strength += 0.2;
        if (lower.includes('[memorable:')) {
            const memIdx = lower.indexOf('[memorable:');
            const memContext = lower.substring(Math.max(0, memIdx - 100), memIdx + 200);
            if (memContext.includes(kwLower)) strength += 0.3;
        }
        strengths[kw] = Math.min(1.0, strength);
    }
    return strengths;
}

/**
 * Extract graded NPC strengths (0-1) from GM output.
 * Strength based on: death proximity, dialogue/action proximity, mention frequency.
 */
export function extractNPCStrengths(text, npcNames) {
    const lower = text.toLowerCase();
    const strengths = {};

    for (const name of npcNames) {
        const nameLower = name.toLowerCase();
        // Escaped for the patterns below. The file already escaped names in
        // `extractTimelineEventsRegex`; this function did not, so a name with a
        // regex metacharacter threw inside the scene append path.
        const namePat = escapeRegex(nameLower);
        let strength = 0;
        const deathPattern = new RegExp(namePat + '\\s+(was\\s+)?(killed|slain|died|defeated|destroyed)', 'i');
        const reverseDeath = new RegExp('(killed|slain|defeated|destroyed|murdered)\\s+' + namePat, 'i');
        if (deathPattern.test(lower) || reverseDeath.test(lower)) {
            strength = 1.0;
        } else {
            let count = 0;
            let pos = 0;
            while ((pos = lower.indexOf(nameLower, pos)) !== -1) { count++; pos += nameLower.length; }
            if (count >= 3) strength = 0.7;
            else if (count >= 2) strength = 0.5;
            else if (count >= 1) strength = 0.3;
            const dialoguePattern = new RegExp(namePat + '\\s+(said|replied|shouted|whispered|asked|told|exclaimed)', 'i');
            if (dialoguePattern.test(lower)) strength = Math.max(strength, 0.7);
        }
        strengths[name] = Math.min(1.0, strength);
    }
    return strengths;
}

export function extractWitnessesHeuristic(npcNames, userContent, assistantContent) {
    const witnesses = [];
    const mentioned = [];

    for (const name of npcNames) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const dialoguePattern = new RegExp(
            '\\[\\*{0,2}' + escaped + '\\*{0,2}\\]\\s*[^\\n]{10,}', 'i'
        );
        const addressedPattern = new RegExp(
            '(?:talk to|ask|tell|speak with|confront|approach|address)\\s+' + escaped, 'i'
        );

        const hasDialogue = dialoguePattern.test(assistantContent);
        const isAddressed = addressedPattern.test(userContent);

        if (hasDialogue || isAddressed) {
            witnesses.push(name);
        } else {
            mentioned.push(name);
        }
    }

    return { witnesses, mentioned };
}

export function extractTimelineEventsRegex(npcNames, text, sceneId, chapterId) {
    const events = [];

    for (const name of npcNames) {
        const pat = escapeRegex(name);

        // killed_by: "Name was killed/slain/defeated by X"
        const killAsObject = new RegExp('([A-Z][A-Za-z\\s]{1,30})\\s+(killed|slain|defeated|destroyed|murdered)\\s+' + pat, 'i');
        const killMatch = text.match(killAsObject);
        if (killMatch) {
            events.push({
                sceneId, chapterId, subject: name, predicate: 'killed_by',
                object: killMatch[1].trim(),
                summary: `${name} was killed by ${killMatch[1].trim()}`,
                importance: 10, source: 'regex',
            });
        }

        // status: "Name was found dead / died"
        const deathSelf = new RegExp(pat + '\\s+(was\\s+)?(died|found dead|perished|collapsed)', 'i');
        if (deathSelf.test(text)) {
            events.push({
                sceneId, chapterId, subject: name, predicate: 'status',
                object: 'dead',
                summary: `${name} is dead`,
                importance: 10, source: 'regex',
            });
        }

        // located_in: "Name entered/arrived at/fled to X"
        const locPattern = new RegExp(pat + '\\s+(entered|arrived at|found in|returned to|fled to)\\s+(?:the\\s+)?([A-Z][A-Za-z\\s]{2,40})', 'i');
        const locMatch = text.match(locPattern);
        if (locMatch) {
            events.push({
                sceneId, chapterId, subject: name, predicate: 'located_in',
                object: locMatch[2].trim(),
                summary: `${name} is at ${locMatch[2].trim()}`,
                importance: 5, source: 'regex',
            });
        }

        // holds: "Name, King/Queen/Lord/... of X"
        const titlePattern = new RegExp(pat + ',\\s+((?:King|Queen|Lord|Lady|Duke|Prince|Princess|General|Commander|Archmage|Champion)(?:\\s+of\\s+[A-Za-z\\s]+)?)', 'i');
        const titleMatch = text.match(titlePattern);
        if (titleMatch) {
            events.push({
                sceneId, chapterId, subject: name, predicate: 'holds',
                object: titleMatch[1].trim(),
                summary: `${name} holds title: ${titleMatch[1].trim()}`,
                importance: 7, source: 'regex',
            });
        }

        // allied_with: "Name, leader/member of X"
        const factionPattern = new RegExp(pat + '[\\s,]+(?:leader\\s+of|member\\s+of|of)\\s+(?:the\\s+)?([A-Z][A-Za-z\\s]{2,30})', 'i');
        const factionMatch = text.match(factionPattern);
        if (factionMatch) {
            events.push({
                sceneId, chapterId, subject: name, predicate: 'allied_with',
                object: factionMatch[1].trim(),
                summary: `${name} is allied with ${factionMatch[1].trim()}`,
                importance: 7, source: 'regex',
            });
        }
    }

    return events;
}
