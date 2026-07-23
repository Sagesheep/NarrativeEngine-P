import type { NPCVisualProfile } from '../../types';
import { DEFAULT_VISUAL_PROFILE } from '../../types';
import { DEFAULT_PORTRAIT_ART_STYLE, PORTRAIT_STYLE_PROMPTS } from '../../data/portraitStyles';

const MAX_PORTRAIT_PROMPT_CHARS = 1_100;

function isMeaningful(value: string | undefined): value is string {
    const normalized = value?.trim().toLowerCase();
    return !!normalized && normalized !== 'unknown' && normalized !== 'none';
}

function hasStructuredVisualData(profile: NPCVisualProfile): boolean {
    return Object.entries(profile).some(([field, value]) => field !== 'artStyle' && isMeaningful(value));
}

function compact(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

/** Builds a provider-safe, single-subject portrait prompt for individual and bulk generation. */
export function buildPortraitPrompt(
    vp: NPCVisualProfile | undefined,
    name: string,
    appearance?: string
): string {
    const profile = vp || DEFAULT_VISUAL_PROFILE;
    const style = PORTRAIT_STYLE_PROMPTS[profile.artStyle] || PORTRAIT_STYLE_PROMPTS[DEFAULT_PORTRAIT_ART_STYLE];
    const base = `Create a polished waist-up RPG character dossier portrait of one person only. Face, hair, and upper torso clearly visible. No text, interface, collage, split frame, duplicate, or group. Use an uncluttered atmospheric background suitable for a ledger thumbnail. Style: ${style}.`;
    const fields: Array<[string, string | undefined]> = [
        ['Name', name], ['Race', profile.race], ['Gender', profile.gender], ['Age', profile.ageRange],
        ['Build', profile.build], ['Features', profile.symmetry], ['Hair', profile.hairStyle],
        ['Eyes', profile.eyeColor], ['Skin', profile.skinTone], ['Posture', profile.gait],
        ['Clothing', profile.clothing], ['Marks', profile.distinctMarks],
    ];

    // The legacy prose is a fallback only. Mixing it with structured fields duplicates
    // information and can exceed the image provider's prompt limit.
    if (!hasStructuredVisualData(profile) && isMeaningful(appearance)) fields.push(['Legacy notes', appearance]);

    const populatedFields = fields.filter(([, value]) => isMeaningful(value)) as Array<[string, string]>;
    const availablePerField = Math.max(40, Math.floor((MAX_PORTRAIT_PROMPT_CHARS - base.length - populatedFields.length * 2) / Math.max(1, populatedFields.length)));
    const details = populatedFields.map(([label, value]) => `${label}: ${compact(value, availablePerField)}.`).join(' ');
    return `${base} ${details}`.slice(0, MAX_PORTRAIT_PROMPT_CHARS).trimEnd();
}