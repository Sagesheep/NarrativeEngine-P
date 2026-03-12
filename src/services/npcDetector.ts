import type { NPCEntry, EndpointConfig, ProviderConfig } from '../types';
import { sendMessage, extractJson } from './chatEngine';

/** Extract NPC names from assistant response text using bracket/system tag patterns */
export function extractNPCNames(content: string): string[] {
    const extractedNames: string[] = [];

    // Pattern to exclude generic roles like "Guard A" or "Scout 1"
    const GENERIC_ROLE_PATTERN = /^(guard|scout|merchant|soldier|bandit|thug|villager|citizen|patron|cultist|goblin|orc|skeleton|zombie|enemy|monster|creature)\s+[a-z0-9]$/i;
    const NPC_NAME_BLOCKLIST = new Set(["you", "i", "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "with", "by", "about", "like", "through", "over", "before", "between", "after", "since", "without", "under", "within", "along", "following", "across", "behind", "beyond", "plus", "except", "but", "up", "out", "around", "down", "off", "above", "near"]);

    // Pattern 1 & 2: [Name] or [**Name**] — no colons allowed inside (filters out [SYSTEM: ...])
    const bracketMatches = Array.from(content.matchAll(/\[\*{0,2}([A-Za-z][A-Za-z0-9 _.'-]*[A-Za-z0-9.])\*{0,2}\]/g));
    for (const m of bracketMatches) {
        const raw = m[1].trim();
        // Skip common false positives
        if (raw.length < 2) continue;
        if (raw.includes(' ') && raw === raw.toUpperCase()) continue;
        // Skip blocklisted words
        if (NPC_NAME_BLOCKLIST.has(raw.toLowerCase())) continue;
        // Skip generic roles
        if (GENERIC_ROLE_PATTERN.test(raw)) continue;
        extractedNames.push(raw);
    }

    // Pattern 3: [SYSTEM: NPC_ENTRY - NAME]
    const entryMatches = Array.from(content.matchAll(/\[SYSTEM:\s*NPC_ENTRY\s*[-–—]\s*([A-Za-z][A-Za-z0-9 _'-]*)\]/gi));
    for (const m of entryMatches) {
        const raw = m[1].trim();
        if (NPC_NAME_BLOCKLIST.has(raw.toLowerCase())) continue;
        if (GENERIC_ROLE_PATTERN.test(raw)) continue;
        extractedNames.push(raw);
    }

    return extractedNames;
}

/** Filter extracted names against existing ledger, return { newNames, existingNpcs } */
export function classifyNPCNames(
    names: string[],
    ledger: NPCEntry[]
): { newNames: string[]; existingNpcs: NPCEntry[] } {
    // Normalize: title-case all-caps single words (e.g., ORIN -> Orin)
    const normalized = names.map(n =>
        n === n.toUpperCase() ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : n
    );
    const uniqueNames = Array.from(new Set(normalized));

    const newNames: string[] = [];
    const existingNpcs: NPCEntry[] = [];

    for (const potentialName of uniqueNames) {
        // Check if already in ledger (case-insensitive against name + aliases)
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

/** 
 * LLM validation pass to filter out non-name false positives (e.g. skills, mechanics). 
 * Falls back to original candidates on API error.
 */
export async function validateNPCCandidates(
    provider: EndpointConfig | ProviderConfig,
    candidates: string[],
    narrativeContext: string
): Promise<string[]> {
    if (candidates.length === 0) return candidates;

    console.log(`[NPC Validator] Validating ${candidates.length} candidates against LLM semantic filter...`);

    const shortContext = narrativeContext.slice(-1000); // Keep it cheap

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

    const messages = [{ role: 'user' as const, content: prompt }];

    try {
        let fullJsonStr = '';
        await new Promise<void>((resolve, reject) => {
            sendMessage(
                provider,
                messages,
                (chunk) => { fullJsonStr = chunk; },
                () => resolve(),
                (err) => reject(new Error(err))
            );
        });

        if (fullJsonStr) {
            const cleanStr = extractJson(fullJsonStr);
            const parsed = JSON.parse(cleanStr);
            if (Array.isArray(parsed)) {
                // Return only strings that were in the original candidates (case-insensitive) to prevent hallucinations
                const validLower = new Set(parsed.map(s => String(s).toLowerCase()));
                const filtered = candidates.filter(c => validLower.has(c.toLowerCase()));
                console.log(`[NPC Validator] Filtered ${candidates.length} down to ${filtered.length}:`, filtered);
                return filtered;
            }
        }
    } catch (err) {
        console.warn(`[NPC Validator] API validation failed, falling back to raw candidates:`, err);
    }
    
    return candidates;
}
