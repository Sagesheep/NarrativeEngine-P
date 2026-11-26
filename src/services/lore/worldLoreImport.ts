import { llmCall } from '../../utils/llmCall';
import { useAppStore } from '../../store/useAppStore';
import { AuxNotConfiguredError } from './worldLoreAI';

export type ClassifiedCategory =
    | 'background'
    | 'languages'
    | 'powerSystem'
    | 'techEconomy'
    | 'timeline'
    | 'toneBoundaries'
    | 'houseRules'
    | 'locations'
    | 'cultures'
    | 'factions'
    | 'threats'
    | 'npcs';

export type ClassifiedChunk = {
    category: ClassifiedCategory;
    title: string;
    body: string;
};

const ALL_CATEGORIES: ClassifiedCategory[] = [
    'background', 'languages', 'powerSystem', 'techEconomy', 'timeline',
    'toneBoundaries', 'houseRules', 'locations', 'cultures', 'factions', 'threats', 'npcs',
];

const CATEGORY_LABELS: Record<ClassifiedCategory, string> = {
    background: 'World Background',
    languages: 'Languages & Naming Conventions',
    powerSystem: 'Power System',
    techEconomy: 'Technology & Economy Level',
    timeline: 'Timeline / Calendar / Current Era',
    toneBoundaries: 'Tone & Content Boundaries',
    houseRules: 'House Rules / Mechanical Conventions',
    locations: 'Geography & Locations',
    cultures: 'Cultures',
    factions: 'Established Factions',
    threats: 'Threats / Antagonist Forces',
    npcs: 'Pre-seeded NPCs',
};

export { CATEGORY_LABELS, ALL_CATEGORIES };

const CLASSIFY_PROMPT = `You are a TTRPG world-building assistant. The user will paste a block of existing world lore text. Classify it into one or more chunks, assigning each chunk to the most appropriate category and giving it a concise title.

Available categories:
- background: World overview, history, core conflicts
- languages: Languages, naming conventions
- powerSystem: Magic, technology, energy systems
- techEconomy: Technology level, currency, trade
- timeline: Calendar, eras, dates
- toneBoundaries: Tone, content boundaries, themes
- houseRules: House rules, mechanical conventions
- locations: Places, geography, regions
- cultures: Cultural groups, customs, religions
- factions: Organizations, political groups, guilds
- threats: Antagonists, dangers, enemy forces
- npcs: Named characters, NPCs, pre-seeded characters

Respond ONLY with a JSON array. Each element must have:
- "category": one of the categories listed above
- "title": a short descriptive title
- "body": the relevant text content

Example response:
[{"category":"locations","title":"The Iron Citadel","body":"A massive fortress built on the edge of the Shattered Plains..."},{"category":"factions","title":"The Silver Hand","body":"A paladin order dedicated to eradicating undeath..."}]

Do NOT include any text outside the JSON array.`;

function extractJSONArray(text: string): string | null {
    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) return null;
    return text.substring(firstBracket, lastBracket + 1);
}

export async function classifyPastedLore(text: string): Promise<ClassifiedChunk[]> {
    const endpoint = useAppStore.getState().getActiveAuxiliaryEndpoint();
    if (!endpoint || !endpoint.endpoint) throw new AuxNotConfiguredError();

    const prompt = `${CLASSIFY_PROMPT}\n\n---\n\n${text}`;
    const raw = await llmCall(endpoint, prompt, { temperature: 0.3, priority: 'low' });

    const jsonStr = extractJSONArray(raw);
    if (!jsonStr) {
        throw new Error(`AI response did not contain a JSON array. Raw response:\n\n${raw.substring(0, 500)}`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonStr);
    } catch {
        throw new Error(`Failed to parse AI classification response. The AI may have returned malformed JSON. Try pasting in smaller chunks or categorize manually.\n\nRaw:\n${jsonStr.substring(0, 300)}`);
    }

    if (!Array.isArray(parsed)) {
        throw new Error('AI returned something other than an array. Try again or categorize manually.');
    }

    const validCategories = new Set<string>(ALL_CATEGORIES);
    const chunks: ClassifiedChunk[] = [];

    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const cat = typeof item.category === 'string' && validCategories.has(item.category)
            ? item.category as ClassifiedCategory
            : 'background';
        const title = typeof item.title === 'string' ? item.title.trim() : 'Untitled';
        const body = typeof item.body === 'string' ? item.body.trim() : '';
        if (title || body) {
            chunks.push({ category: cat, title, body });
        }
    }

    if (chunks.length === 0) {
        throw new Error('AI classified zero chunks from the pasted text. Try again or categorize manually.');
    }

    return chunks;
}