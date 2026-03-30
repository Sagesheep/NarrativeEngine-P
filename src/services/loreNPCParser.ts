import type { NPCEntry, LoreChunk } from '../types';

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Parses a world lore markdown file for a `## CHARACTERS` section and
 * extracts structured NPC entries for the ledger.
 *
 * Each character block must use `### Name` headers with `**Field:** Value` bullets.
 * Fields: Aliases, Appearance, Disposition, Goals, Faction, StoryRelevance,
 *         Status, Affinity, Nature, Training, Emotion, Social, Belief, Ego
 */
export function parseNPCsFromLore(chunks: LoreChunk[]): NPCEntry[] {
    const npcs: NPCEntry[] = [];
    const characterChunks = chunks.filter(c => c.category === 'character');

    for (const chunk of characterChunks) {
        let name = chunk.header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();
        name = name.split(/[—–-]/)[0].trim();
        if (!name) continue;

        const body = chunk.content;

        const get = (field: string): string => {
            const re = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, 'i');
            const m = body.match(re);
            return m ? m[1].trim() : '';
        };
        
        const getAny = (fields: string[]): string => {
            for (const field of fields) {
                const value = get(field);
                if (value) return value;
            }
            return '';
        };

        const getNum = (field: string, fallback: number): number => {
            const raw = get(field);
            if (!raw) return fallback;
            const match = raw.match(/\d+/);
            if (!match) return fallback;
            const n = parseInt(match[0], 10);
            return isNaN(n) ? fallback : n;
        };
        
        // Handle Axes format explicitly if present (e.g. "Nature(8) Training(5)...")
        const axesMatch = body.match(/\*\*Axes:\*\*\s*(.+)/i);
        let axesStr = axesMatch ? axesMatch[1] : '';
        const parseAxis = (label: string, fallback: number): number => {
            if (!axesStr) return getNum(label, fallback);
            const ref = new RegExp(`${label}\\s*\\((\\d+)\\)`, 'i');
            const m = axesStr.match(ref);
            return m ? parseInt(m[1], 10) : getNum(label, fallback);
        }

        const visualProfile = {
            race: getAny(['VisualRace', 'Visual Race', 'Race', 'Race / Species']),
            gender: getAny(['VisualGender', 'Gender']),
            ageRange: getAny(['VisualAgeRange', 'Age Range', 'VisualAge', 'Age']),
            build: getAny(['VisualBuild', 'Build', 'Build / Body Type']),
            symmetry: getAny(['VisualSymmetry', 'Attract / Symmetry', 'Symmetry', 'Attractiveness']),
            hairStyle: getAny(['VisualHairStyle', 'Hair Style & Color', 'Hair', 'Hair Style']),
            eyeColor: getAny(['VisualEyeColor', 'Eye Color', 'Eyes']),
            skinTone: getAny(['VisualSkinTone', 'Skin Tone']),
            gait: getAny(['VisualGait', 'Gait / Posture', 'Gait']),
            distinctMarks: getAny(['VisualDistinctMarks', 'Distinct Marks']),
            clothing: getAny(['VisualClothing', 'Clothing Style', 'Clothing']),
            artStyle: getAny(['VisualArtStyle', 'Art Style']) || 'Anime',
        };
        
        const hasVisualProfile = !!(
            visualProfile.race || visualProfile.gender || visualProfile.ageRange || visualProfile.build ||
            visualProfile.symmetry || visualProfile.hairStyle || visualProfile.eyeColor || visualProfile.skinTone ||
            visualProfile.gait || visualProfile.distinctMarks || visualProfile.clothing
        );

        npcs.push({
            id: uid(),
            name,
            aliases: get('Aliases'),
            appearance: getAny(['Appearance', 'VisualForAI']),
            visualProfile: hasVisualProfile ? visualProfile : undefined,
            disposition: get('Disposition'),
            goals: get('Goals'),
            faction: get('Faction'),
            storyRelevance: get('StoryRelevance'),
            status: (get('Status') as NPCEntry['status']) || 'Alive',
            affinity: parseAxis('Affinity', 50),
            nature: parseAxis('Nature', 5),
            training: parseAxis('Training', 5),
            emotion: parseAxis('Emotion', 5),
            social: parseAxis('Social', 5),
            belief: parseAxis('Belief', 5),
            ego: parseAxis('Ego', 5),
            portrait: '',
        });
    }

    return npcs;
}
