import type { NPCEntry, LoreChunk, HexAxis, PersonalityHex, NPCDrives, NPCWants, NPCBehavioralTrigger } from '../../types';
import { TRAIT_NAMES } from '../npc/agency/agencyPools';
import { sanitizeSignatureKit } from '../npc/signatureKit';

const HEX_AXES: readonly HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];
const KNOWN_TRAITS = new Set<string>(TRAIT_NAMES);
const VALID_TIERS = new Set<string>(['recurring', 'oneshot', 'walkon']);

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Parses a world lore markdown file for a `## CHARACTERS` section and
 * extracts structured NPC entries for the ledger.
 *
 * Each character block must use `### Name` headers with `**Field:** Value` bullets.
 * Fields: Aliases, Appearance, Disposition, Goals, Faction (single or CSV/delimited list of factions), StoryRelevance,
 *         Status, Affinity, Voice, Personality, Example Output.
 *         Optional agency fields (authoritative for canon NPCs — skip LLM inference):
 *           - **PersonalityHex:** drive:+3, diligence:-1, boldness:+2, warmth:+1,
 *                                  empathy:+2, composure:-1   (CSV or inline JSON)
 *           - **Traits:** [loyal, stubborn, impulsive]   (filtered to TRAIT_VOCAB, ≤5)
 *           - **Tier:** recurring | oneshot | walkon   (default 'recurring' for preseeded)
 *           - **Region:** konoha   (coarse lowercase keyword; matched by === in proximity)
 *           - **Haunt:** the training grounds   (flavor-only display string)
 *           - **HardBoundaries:** [will not betray his team, will not abandon a comrade]
 *           - **SoftBoundaries:** [dislikes being lectured, dislikes waiting]
 *           - **BehavioralTriggers:** [keyword:shift, keyword:shift]
 *                 e.g. [itachi:goes silent and sharpens killing intent,
 *                        sasuke:raises voice and clenches fists]
 *           - **WantsShort:** [train, eat ramen, prank]   (bracketed CSV)
 *           - **WantsMedium:** [learn a new jutsu, win a sparring match]
 *           - **WantsLong:** become Hokage so the village recognizes him
 *           - **CoreWant:** a deep character truth (drives.coreWant)
 *           - **SessionWant:** arc-level goal (drives.sessionWant)
 *           - **SceneWant:** immediate-scene want (drives.sceneWant)
 *           - **SignatureEquipment:** [Excalibur (holy longsword), plate armor]  (durable loadout gear, ≤4)
 *           - **SignatureAbilities:** [fire magic, holy smite]                    (signature powers/techniques, ≤4)
 *           - **Element:** fire                                                   (single affinity tag)
 *         Optional desktop-only visual fields (mobile parser ignores these):
 *           VisualRace, VisualGender, VisualAgeRange, VisualBuild, VisualSymmetry,
 *           VisualHairStyle, VisualEyeColor, VisualSkinTone, VisualGait,
 *           VisualDistinctMarks, VisualClothing, VisualArtStyle
 */
export function parseNPCsFromLore(chunks: LoreChunk[]): NPCEntry[] {
    const npcs: NPCEntry[] = [];
    const characterChunks = chunks.filter(c => c.category === 'character');

    for (const chunk of characterChunks) {
        let name = chunk.header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();
        // Strip "TYPE -- Name" or "TYPE — Name" prefix (e.g. "CHARACTER -- Kaiser Aldricht Voss" or "CHARACTER — Cao Cao")
        const doubleDashMatch = name.match(/^[A-Z][A-Z_\s]*--\s*(.+)/);
        if (doubleDashMatch) {
            name = doubleDashMatch[1].trim();
        } else {
            const emDashMatch = name.match(/^[A-Z][A-Z_\s]*[—–]\s*(.+)/);
            if (emDashMatch) {
                name = emDashMatch[1].trim();
            } else {
                // Fallback: em-dash / en-dash separator (old format where name is first, e.g. "Cao Cao — The Tyrant")
                name = name.split(/[—–]/)[0].trim();
            }
        }
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

        // ---- Lore-authored agency fields (hex + traits). ----
        // The parser is the ONE place lore can authoritatively preseed these for canon NPCs.
        // Without this, populateAgencyFields later re-infers them from the disposition string
        // via an LLM call — which is where canon mischaracterization crept in. When the lore
        // block provides them, the parser surfaces them and populateAgencyFields' existing
        // `if (!npc.personalityHex)` / `if (!npc.traits)` guards skip the LLM inference entirely.

        /** Coerce one axis value to a clamped integer in -3..+3; non-numeric → 0. */
        const clampHexValue = (v: unknown): number => {
            const n = typeof v === 'number' ? v : Number(v);
            if (!Number.isFinite(n)) return 0;
            return Math.max(-3, Math.min(3, Math.round(n)));
        };

        /**
         * Parse `**PersonalityHex:**` from the lore block. Accepts either a CSV of
         * `axis:value` pairs (e.g. "drive:+3, diligence:-1, boldness:+2, ...") or an inline
         * JSON object (e.g. `{"drive":3,"diligence":-1,...}`). Unknown axes are ignored;
         * missing axes default to 0. Returns `undefined` when the field is absent so the
         * downstream `npcs.push` leaves `personalityHex` unset (preserving prior behaviour).
         */
        const getHex = (field: string): PersonalityHex | undefined => {
            const raw = get(field);
            if (!raw) return undefined;
            const hex = {} as PersonalityHex;
            for (const axis of HEX_AXES) hex[axis] = 0;
            // Try JSON first (single-line object form).
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    const obj = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
                    for (const axis of HEX_AXES) {
                        if (axis in obj) hex[axis] = clampHexValue(obj[axis]);
                    }
                    return hex;
                } catch {
                    // fall through to CSV parsing
                }
            }
            // CSV form: drive:+3, diligence:-1, boldness:+2, warmth:+1, empathy:+2, composure:-1
            for (const part of raw.split(',')) {
                const m = part.match(/([a-zA-Z]+)\s*[:=]\s*([-+]?\d+)/);
                if (!m) continue;
                const axis = m[1].toLowerCase();
                const value = parseInt(m[2], 10);
                if ((HEX_AXES as readonly string[]).includes(axis)) {
                    hex[axis as HexAxis] = clampHexValue(value);
                }
            }
            return hex;
        };

        /**
         * Parse `**Traits:**` from the lore block. Accepts `[a, b, c]`, `a, b, c`, or
         * `a b c`. Filters to the controlled vocabulary in TRAIT_VOCAB (case-insensitive),
         * dedupes, caps at 5. Returns `undefined` when absent so the downstream guards still
         * trigger LLM inference for NPCs the lore author didn't seed.
         */
        const getTraits = (field: string): string[] | undefined => {
            const raw = get(field);
            if (!raw) return undefined;
            const stripped = raw.replace(/[[\]]/g, '').trim();
            if (!stripped) return undefined;
            const out: string[] = [];
            for (const item of stripped.split(/[,;]|\s{2,}|\|/)) {
                const t = item.toLowerCase().trim();
                if (!t || !KNOWN_TRAITS.has(t)) continue;
                if (out.includes(t)) continue;
                out.push(t);
                if (out.length >= 5) break;
            }
            return out.length > 0 ? out : undefined;
        };

        /**
         * Parse a bracketed CSV string list (no vocab filter). Used for hardBoundaries,
         * softBoundaries, wants.short, wants.medium. Returns `undefined` when absent.
         */
        const getStringList = (field: string): string[] | undefined => {
            const raw = get(field);
            if (!raw) return undefined;
            const stripped = raw.replace(/[[\]]/g, '').trim();
            if (!stripped) return undefined;
            const out = stripped.split(/[,;]|\s{2,}|\|/)
                .map(s => s.trim())
                .filter(s => s.length > 0);
            return out.length > 0 ? out : undefined;
        };

        /**
         * Parse `**BehavioralTriggers:**` as a bracketed list of `keyword:shift` pairs.
         * Splitter is the FIRST colon in each item (so shifts may contain colons).
         * Returns `undefined` when absent or no valid pairs found.
         */
        const getBehavioralTriggers = (field: string): NPCBehavioralTrigger[] | undefined => {
            const raw = get(field);
            if (!raw) return undefined;
            const stripped = raw.replace(/[[\]]/g, '').trim();
            if (!stripped) return undefined;
            const out: NPCBehavioralTrigger[] = [];
            for (const item of stripped.split(/[,;]|\s{2,}|\|/)) {
                const trimmed = item.trim();
                if (!trimmed) continue;
                const idx = trimmed.indexOf(':');
                if (idx <= 0) continue;
                const keyword = trimmed.slice(0, idx).trim();
                const shift = trimmed.slice(idx + 1).trim();
                if (keyword && shift) out.push({ keyword, shift });
            }
            return out.length > 0 ? out : undefined;
        };

        /** Parse `**Tier:**` — validated to recurring|oneshot|walkon. Default 'recurring'. */
        const getTier = (): NPCEntry['tier'] => {
            const raw = get('Tier');
            if (!raw) return 'recurring';
            const t = raw.toLowerCase().trim();
            return VALID_TIERS.has(t) ? t as NPCEntry['tier'] : 'recurring';
        };

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
            artStyle: getAny(['VisualArtStyle', 'Art Style']) || 'Stylized Game Realism',
        };
        
        const hasVisualProfile = !!(
            visualProfile.race || visualProfile.gender || visualProfile.ageRange || visualProfile.build ||
            visualProfile.symmetry || visualProfile.hairStyle || visualProfile.eyeColor || visualProfile.skinTone ||
            visualProfile.gait || visualProfile.distinctMarks || visualProfile.clothing
        );

        const disposition = get('Disposition') || '';

        // ---- Drives + Wants (legacy NPCDrives + tiered NPCWants). ----
        // populateAgencyFields already respects existing wants.short/medium/long and
        // existing drives — when the parser surfaces them, the engine keeps them
        // instead of pulling from the pools or defaultLongWant(faction).
        const coreWant = getAny(['CoreWant', 'Core Want']);
        const sessionWant = getAny(['SessionWant', 'Session Want']);
        const sceneWant = getAny(['SceneWant', 'Scene Want']);
        const drives: NPCDrives | undefined = (coreWant || sessionWant || sceneWant)
            ? { coreWant: coreWant || '', sessionWant: sessionWant || '', sceneWant: sceneWant || '' }
            : undefined;

        const wantsShort = getStringList('WantsShort');
        const wantsMedium = getStringList('WantsMedium');
        const wantsLong = getAny(['WantsLong', 'Wants Long', 'LongWant', 'Long Want']);
        const wants: NPCWants | undefined = (wantsShort || wantsMedium || wantsLong)
            ? { short: wantsShort ?? [], medium: wantsMedium ?? [], long: wantsLong ?? '' }
            : undefined;

        // ---- Signature Kit (durable loadout — anti-drift for gear + powers). ----
        // Zero-LLM: parsed straight from lore bullets and bounded by the shared sanitizer
        // (cap 8/channel, entry+element length caps) so a lore-seeded kit is identical in
        // shape to one the post-turn updater would accept. Absent fields → undefined kit.
        const signatureKit = sanitizeSignatureKit({
            equipment: getStringList('SignatureEquipment') ?? getStringList('Equipment'),
            abilities: getStringList('SignatureAbilities') ?? getStringList('Abilities') ?? getStringList('Powers'),
            element: getAny(['Element', 'SignatureElement']),
        });

        npcs.push({
            id: uid(),
            name,
            aliases: get('Aliases'),
            appearance: getAny(['Appearance', 'VisualForAI']),
            visualProfile: hasVisualProfile ? visualProfile : undefined,
            disposition,
            goals: get('Goals'),
            faction: get('Faction'),
            storyRelevance: get('StoryRelevance'),
            status: (get('Status') as NPCEntry['status']) || 'Alive',
            affinity: getNum('Affinity', 50),
            voice: getAny(['Voice', 'Speech Pattern', 'Voice & Speech Pattern']),
            personality: getAny(['Personality', 'Personality Traits']) || disposition,
            exampleOutput: getAny(['Example Output', 'Example Dialogue', 'Example Line']),
            // Lore-authored agency fields. When present, populateAgencyFields' existing
            // guards skip the LLM inference / pool-draw calls — canon NPCs keep their
            // authored personality instead of being re-inferred from the disposition string.
            personalityHex: getHex('PersonalityHex'),
            traits: getTraits('Traits'),
            tier: getTier(),
            region: get('Region') || undefined,
            haunt: get('Haunt') || undefined,
            hardBoundaries: getStringList('HardBoundaries'),
            softBoundaries: getStringList('SoftBoundaries'),
            behavioralTriggers: getBehavioralTriggers('BehavioralTriggers'),
            drives,
            wants,
            signatureKit,
            portrait: '',
        });
    }

    return npcs;
}
