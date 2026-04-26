import type { NPCEntry, EndpointConfig, ProviderConfig } from '../types';
import { callLLM } from './callLLM';
import { extractJson } from './chatEngine';

const GENERIC_ROLE_PATTERN = /^(guard|scout|merchant|soldier|bandit|thug|villager|citizen|patron|cultist|goblin|orc|skeleton|zombie|enemy|monster|creature)\s+[a-z0-9]$/i;
const NPC_NAME_BLOCKLIST = new Set(["you", "i", "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "with", "by", "about", "like", "through", "over", "before", "between", "after", "since", "without", "under", "within", "along", "following", "across", "behind", "beyond", "plus", "except", "but", "up", "out", "around", "down", "off", "above", "near"]);

export function extractNPCNames(content: string): string[] {
    const extractedNames: string[] = [];

    const bracketMatches = Array.from(content.matchAll(/\[\*{0,2}([A-Za-z][A-Za-z0-9 _.'-]*[A-Za-z0-9.])\*{0,2}\]/g));
    for (const m of bracketMatches) {
        const raw = m[1].trim();
        if (raw.length < 2) continue;
        if (raw.includes(' ') && raw === raw.toUpperCase()) continue;
        if (NPC_NAME_BLOCKLIST.has(raw.toLowerCase())) continue;
        if (GENERIC_ROLE_PATTERN.test(raw)) continue;
        extractedNames.push(raw);
    }

    const entryMatches = Array.from(content.matchAll(/\[SYSTEM:\s*NPC_ENTRY\s*[-–—]\s*([A-Za-z][A-Za-z0-9 _'-]*)\]/gi));
    for (const m of entryMatches) {
        const raw = m[1].trim();
        if (NPC_NAME_BLOCKLIST.has(raw.toLowerCase())) continue;
        if (GENERIC_ROLE_PATTERN.test(raw)) continue;
        extractedNames.push(raw);
    }

    return extractedNames;
}

export function classifyNPCNames(
    names: string[],
    ledger: NPCEntry[]
): { newNames: string[]; existingNpcs: NPCEntry[] } {
    const normalized = names.map(n =>
        n === n.toUpperCase() ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : n
    );
    const uniqueNames = Array.from(new Set(normalized));

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
    provider: EndpointConfig | ProviderConfig,
    candidates: string[],
    narrativeContext: string
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
        const raw = await callLLM(provider, prompt, { priority: 'low' });

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
        console.warn(`[NPC Validator] API validation failed, falling back to raw candidates:`, err);
    }
    
    return candidates;
}
