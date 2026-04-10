/**
 * Pure NLP / text-analysis functions extracted from server.js.
 * No filesystem access, no external dependencies.
 */

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

/** Extract NPC names (words wrapped in [**Name**] format from GM output). */
export function extractNPCNames(text) {
    const names = new Set();
    const matches = text.matchAll(/\[\*{0,2}([A-Za-z][A-Za-z0-9 '-]{1,30})\*{0,2}\]/g);
    for (const m of matches) names.add(m[1].trim());
    return Array.from(names).slice(0, 15);
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
        let strength = 0;
        const deathPattern = new RegExp(nameLower + '\\s+(was\\s+)?(killed|slain|died|defeated|destroyed)', 'i');
        const reverseDeath = new RegExp('(killed|slain|defeated|destroyed|murdered)\\s+' + nameLower, 'i');
        if (deathPattern.test(lower) || reverseDeath.test(lower)) {
            strength = 1.0;
        } else {
            let count = 0;
            let pos = 0;
            while ((pos = lower.indexOf(nameLower, pos)) !== -1) { count++; pos += nameLower.length; }
            if (count >= 3) strength = 0.7;
            else if (count >= 2) strength = 0.5;
            else if (count >= 1) strength = 0.3;
            const dialoguePattern = new RegExp(nameLower + '\\s+(said|replied|shouted|whispered|asked|told|exclaimed)', 'i');
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
        // killed_by: "Name was killed/slain/defeated by X"
        const killAsObject = new RegExp('([A-Z][A-Za-z\\s]{1,30})\\s+(killed|slain|defeated|destroyed|murdered)\\s+' + name, 'i');
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
        const deathSelf = new RegExp(name + '\\s+(was\\s+)?(died|found dead|perished|collapsed)', 'i');
        if (deathSelf.test(text)) {
            events.push({
                sceneId, chapterId, subject: name, predicate: 'status',
                object: 'dead',
                summary: `${name} is dead`,
                importance: 10, source: 'regex',
            });
        }

        // located_in: "Name entered/arrived at/fled to X"
        const locPattern = new RegExp(name + '\\s+(entered|arrived at|found in|returned to|fled to)\\s+(?:the\\s+)?([A-Z][A-Za-z\\s]{2,40})', 'i');
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
        const titlePattern = new RegExp(name + ',\\s+((?:King|Queen|Lord|Lady|Duke|Prince|Princess|General|Commander|Archmage|Champion)(?:\\s+of\\s+[A-Za-z\\s]+)?)', 'i');
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
        const factionPattern = new RegExp(name + '[\\s,]+(?:leader\\s+of|member\\s+of|of)\\s+(?:the\\s+)?([A-Z][A-Za-z\\s]{2,30})', 'i');
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
