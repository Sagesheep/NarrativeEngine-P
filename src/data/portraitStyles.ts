/**
 * Portrait style identifiers are persisted with NPC records. Keep legacy values
 * here so old campaigns remain selectable when portraits are regenerated.
 */
export const DEFAULT_PORTRAIT_ART_STYLE = 'Stylized Game Realism';

export const PORTRAIT_ART_STYLE_OPTIONS = [
    { value: 'Stylized Game Realism', label: 'Stylized Game Realism (Recommended)' },
    { value: 'Cinematic Historical Fantasy', label: 'Cinematic Historical Fantasy' },
    { value: 'Painterly Realism', label: 'Painterly Realism' },
    { value: 'Classical Ink & Colour', label: 'Classical Ink & Colour' },
    { value: 'Graphic Novel', label: 'Graphic Novel' },
    { value: 'Western RPG Concept Art', label: 'Western RPG Concept Art' },
    { value: 'Stylized Anime', label: 'Stylized Anime' },
    { value: 'Chibi', label: 'Chibi' },
    // Legacy saved values: retain these until a campaign is deliberately updated.
    { value: 'Cinematic Fantasy', label: 'Cinematic Fantasy (Classic)' },
    { value: 'Realistic', label: 'Realistic (Classic)' },
    { value: 'Anime Realistic', label: 'Anime Realistic (Classic)' },
    { value: 'Anime', label: 'Anime (Classic)' },
    { value: 'Western RPG', label: 'Western RPG (Classic)' },
] as const;

/** Pure visual directions; deliberately free of artist, studio, and game references. */
export const PORTRAIT_STYLE_PROMPTS: Record<string, string> = {
    'Stylized Game Realism': 'premium stylized game-character art, realistic facial anatomy with subtly idealized features, luminous but natural skin, detailed fabric and metal materials, refined 3D-rendered illustration finish, elegant cinematic lighting',
    'Cinematic Historical Fantasy': 'cinematic historical-fantasy character portrait, refined painterly realism, period-inspired textiles and accessories, elegant composition, dramatic lantern or window light',
    'Painterly Realism': 'high-detail painterly realistic character portrait, nuanced skin and fabric texture, restrained colour palette, gallery-quality lighting',
    'Classical Ink & Colour': 'classical ink-and-colour character portrait, expressive brushwork, mineral-pigment palette, graceful composition, fine historical costume detail',
    'Graphic Novel': 'premium graphic-novel character portrait, confident linework, deliberate shapes, cinematic contrast, sophisticated colour design',
    'Western RPG Concept Art': 'high-detail fantasy concept-art portrait, believable materials, atmospheric lighting, grounded character design',
    'Stylized Anime': 'polished semi-realistic stylized-animation portrait, clean expressive linework over realistic proportions, finely rendered individual hair strands, ornate layered costume detail, dramatic rim and backlighting, cinematic colour grading, mature character design',
    'Chibi': 'polished chibi character portrait, expressive proportions, clean shapes, charming but detailed costume design',
    // Existing saves retain their prior value but receive vendor-neutral directions.
    'Cinematic Fantasy': 'cinematic fantasy character portrait, refined painterly realism, dramatic but natural lighting, richly textured materials, grounded expression',
    'Realistic': 'high-detail realistic digital character portrait, natural lighting, believable materials',
    'Anime Realistic': 'highly detailed semi-realistic stylized-animation portrait with realistic proportions, luminous natural lighting, finely rendered hair and fabric, ornate costume embroidery, dramatic backlit sky, cinematic depth of field, refined character design',
    'Anime': 'polished stylized-animation portrait, crisp linework, expressive features, refined colour design',
    'Western RPG': 'high-detail fantasy concept-art portrait, believable materials, atmospheric lighting, grounded character design',
};