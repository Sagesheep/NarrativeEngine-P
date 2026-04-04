import type { LoreChunk, EngineSeed } from '../types';

export function extractEngineSeeds(chunks: LoreChunk[]): EngineSeed {
    const seed: EngineSeed = {
        surpriseTypes: [],
        surpriseTones: [],
        encounterTypes: [],
        encounterTones: [],
        worldWho: [],
        worldWhere: [],
        worldWhy: [],
        worldWhat: [],
    };

    const whoSet = new Set<string>();
    const whereSet = new Set<string>();
    const whySet = new Set<string>();
    const whatSet = new Set<string>();
    const surpriseTypesSet = new Set<string>();
    const surpriseTonesSet = new Set<string>();
    const encounterTypesSet = new Set<string>();
    const encounterTonesSet = new Set<string>();

    for (const chunk of chunks) {
        const text = chunk.content;
        
        // --- WHO (Factions, Orgs, Key Figures) ---
        if (chunk.category === 'faction') {
            const name = chunk.header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').split(/[—–-]/)[0].trim();
            if (name) whoSet.add(name);
            
            // Extract leader if present
            const leaderMatch = text.match(/\*\*Key Members:\*\*\s*(.+)/i) || text.match(/\*\*Leader:\*\*\s*(.+)/i);
            if (leaderMatch) {
                leaderMatch[1].split(',').forEach(l => whoSet.add(l.trim()));
            }
        }

        // --- WHERE (Locations) ---
        if (chunk.category === 'location') {
            const name = chunk.header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').split(/[—–-]/)[0].trim();
            if (name) whereSet.add(`in or around ${name}`);
        } else if (chunk.category === 'world_overview') {
            // grab capitalized proper nouns that might be places
            const places = text.match(/in (the )?([A-Z][a-z]+(\s[A-Z][a-z]+)*)/g);
            if (places) places.forEach(p => whereSet.add(p));
        }

        // --- WHY (Goals, Motivations) ---
        if (text.includes('**Goals:**')) {
            const match = text.match(/\*\*Goals:\*\*\s*(.+)/i);
            if (match) whySet.add(`to ${match[1].toLowerCase()}`);
        }
        if (chunk.category === 'event' || chunk.category === 'faction') {
            const match = text.match(/\*\*Motivations?:\*\*\s*(.+)/i);
            if (match) whySet.add(`driven by ${match[1].toLowerCase()}`);
        }

        // --- WHAT (Actions, Plot Events) ---
        if (chunk.category === 'event') {
            const summaryLine = chunk.summary;
            if (summaryLine && summaryLine.length > 5) {
                // simple heuristic to get verby action
                whatSet.add(summaryLine.toLowerCase());
            }
            if (chunk.header.toLowerCase().includes('arc')) {
                const name = chunk.header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();
                whatSet.add(`initiated ${name}`);
            }
        }

        // --- TONES (Overview usually sets the tone) ---
        if (chunk.category === 'world_overview' && text.includes('**Tone:**')) {
            const match = text.match(/\*\*Tone:\*\*\s*(.+)/i);
            if (match) {
                match[1].split(/[,/]+/).forEach(t => {
                    const tone = t.trim().toUpperCase();
                    surpriseTonesSet.add(tone);
                    encounterTonesSet.add(tone);
                });
            }
        }

        // --- TYPES (Derived from mechanics, power systems, cultures) ---
        if (chunk.category === 'power_system') {
            encounterTypesSet.add('POWER_ANOMALY');
            surpriseTypesSet.add('MAGIC_FLUCTUATION');
        }
        if (chunk.category === 'rules') {
            encounterTypesSet.add('SYSTEM_GLITCH');
            surpriseTypesSet.add('MECHANIC_SHIFT');
        }
        if (chunk.category === 'culture') {
            surpriseTypesSet.add('CULTURAL_MISUNDERSTANDING');
            encounterTypesSet.add('SOCIAL_FAUX_PAS');
        }

        // --- EXPLICIT ENGINE SEED FIELDS (any chunk, any category) ---
        const seedFieldPatterns: [RegExp, Set<string>][] = [
            [/\*\*Surprise Types:\*\*\s*(.+)/i, surpriseTypesSet],
            [/\*\*Surprise Tones:\*\*\s*(.+)/i, surpriseTonesSet],
            [/\*\*Encounter Types:\*\*\s*(.+)/i, encounterTypesSet],
            [/\*\*Encounter Tones:\*\*\s*(.+)/i, encounterTonesSet],
            [/\*\*World Event Who:\*\*\s*(.+)/i, whoSet],
            [/\*\*World Event What:\*\*\s*(.+)/i, whatSet],
            [/\*\*World Event Where:\*\*\s*(.+)/i, whereSet],
            [/\*\*World Event Why:\*\*\s*(.+)/i, whySet],
        ];

        for (const [pattern, set] of seedFieldPatterns) {
            const m = text.match(pattern);
            if (m) {
                m[1].split(/[,/]+/).map(s => s.trim()).filter(Boolean).forEach(v => set.add(v));
            }
        }
    }

    seed.worldWho = Array.from(whoSet).filter(Boolean);
    seed.worldWhere = Array.from(whereSet).filter(Boolean);
    seed.worldWhy = Array.from(whySet).filter(Boolean);
    seed.worldWhat = Array.from(whatSet).filter(Boolean);
    seed.surpriseTypes = Array.from(surpriseTypesSet).filter(Boolean);
    seed.surpriseTones = Array.from(surpriseTonesSet).filter(Boolean);
    seed.encounterTypes = Array.from(encounterTypesSet).filter(Boolean);
    seed.encounterTones = Array.from(encounterTonesSet).filter(Boolean);

    return seed;
}
