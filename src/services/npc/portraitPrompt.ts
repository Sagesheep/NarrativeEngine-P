import { DEFAULT_PORTRAIT_ART_STYLE, PORTRAIT_STYLE_PROMPTS } from '../../data/portraitStyles';

/** Default when the image provider sets no `maxImagePromptChars`. Conservative so it
 *  fits the strictest hosts; a long appearance is shortened to fit it. */
export const DEFAULT_PORTRAIT_PROMPT_CHARS = 1_300;

function isMeaningful(value: string | undefined): value is string {
    const normalized = value?.trim().toLowerCase();
    return !!normalized && normalized !== 'unknown' && normalized !== 'none';
}

function compact(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

/** The generator marks guessed looks "[inferred] "; that tag is for the reader, not the image model. */
function stripInferredTag(value: string): string {
    return value.replace(/^\s*\[inferred\]\s*/i, '');
}

/** Builds a provider-safe, single-subject portrait prompt for individual and bulk generation.
 *
 *  `_name` is deliberately NOT sent to the image model. A name carries no visual
 *  information, and labelling it in the prompt reads as an instruction to letter it
 *  into the frame — models render it as a caption, signature, or (for CJK rosters)
 *  calligraphy and seal stamps. The parameter is kept so the two call sites stay
 *  unchanged and so the intent is documented where someone would re-add it.
 *
 *  The no-writing rule lives in the positive prompt because OpenRouter's image API
 *  has no `negative_prompt` field, so there it is the only defence we get. */
export function buildPortraitPrompt(
    subject: { appearance?: string; artStyle?: string },
    _name: string,
    maxChars: number = DEFAULT_PORTRAIT_PROMPT_CHARS,
): string {
    const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : DEFAULT_PORTRAIT_PROMPT_CHARS;
    const style = PORTRAIT_STYLE_PROMPTS[subject.artStyle ?? ''] || PORTRAIT_STYLE_PROMPTS[DEFAULT_PORTRAIT_ART_STYLE];
    const base = `Single-subject waist-up character dossier portrait: one person only, three-quarter view, face, hair and upper torso clearly visible, detailed costume, cinematic lighting, softly blurred atmospheric background that stays behind the subject. Keep the frame completely free of writing — no text, letters, calligraphy, seals, stamps, signatures, watermarks, captions, or name plates. No collage, split frame, duplicate, or second person. Style: ${style}.`;
    const appearance = stripInferredTag(subject.appearance ?? '');
    if (!isMeaningful(appearance)) return base.slice(0, limit).trimEnd();
    const available = Math.max(40, limit - base.length - ' Appearance: .'.length);
    return `${base} Appearance: ${compact(appearance, available)}`.slice(0, limit).trimEnd();
}