import type { EndpointConfig, ProviderConfig, NPCVisualProfile } from '../../types';
import { getApiFormat, getChatUrl, buildChatHeaders, extractContent } from '../../utils/llmApiHelper';
import { getQueueForEndpoint } from '../llm/llmRequestQueue';
import { startUtilityCall } from '../llm/utilityCallTracker';
import { llmFetch } from '../llm/llmFetch';
import { PORTRAIT_ART_STYLE_OPTIONS } from '../../data/portraitStyles';
import { buildVisionBody, type VisionImage } from './visionRequest';

/**
 * Vision v1 — image in, text out.
 *
 * The story model never sees the image. A vision model reads it ONCE, at the
 * moment it is attached, and writes what it saw into the fields the payload
 * already carries: the structured `visualProfile` (which `buildPortraitPrompt`
 * also reads, so a described portrait can be regenerated consistently) and the
 * `appearance` prose (which `minifyNPC` already injects every turn).
 *
 * That is why this feature needs no payload plumbing and no orchestrator
 * change: the caption enters through fields the turn pipeline already reads.
 * It also means the cost is one call ever, not one per turn — see the token
 * note in `imageSource.ts` for why that distinction is worth the lossiness.
 *
 * The caption is a DRAFT, always. It lands in editable form fields and the
 * user saves it deliberately; nothing here writes to the record on its own.
 * Vision models confidently invent details, and an unreviewed "she carries
 * three swords" would become permanent canon the story model then honours.
 */

const TRACKING_LABEL = 'vision-describe';
const CALL_TIMEOUT_MS = 120_000;

/** Cap per structured field — these render into single-line inputs. */
const FIELD_CAP = 80;
/** Cap for the prose caption — it is injected every turn, so it stays small. */
const APPEARANCE_CAP = 600;

/** The visualProfile keys the model is asked to fill (artStyle is handled separately). */
const OBSERVED_FIELDS = [
    'race', 'gender', 'ageRange', 'build', 'symmetry',
    'hairStyle', 'eyeColor', 'skinTone', 'gait', 'distinctMarks', 'clothing',
] as const;

export type VisionDescription = {
    visualProfile: Partial<NPCVisualProfile>;
    appearance: string;
    /** Raw model text, kept for debugging a bad parse. */
    raw: string;
};

export class VisionParseError extends Error {
    raw: string;
    constructor(raw: string) {
        super('The vision model did not return usable JSON.');
        this.name = 'VisionParseError';
        this.raw = raw;
    }
}

const ART_STYLES = PORTRAIT_ART_STYLE_OPTIONS.map(o => o.value);

export function buildDescribeInstruction(subjectName?: string): string {
    const who = subjectName?.trim() ? `The character is named ${subjectName.trim()}. ` : '';
    return `You are a character-sheet scribe for a tabletop RPG. ${who}Look at the image and record ONLY what you can actually see.

Return a single JSON object, no markdown fences and no commentary:

{
  "race": "species or ethnicity as read from the image, e.g. 'human, East Asian' or 'elf'",
  "gender": "presented gender, or 'ambiguous'",
  "ageRange": "e.g. 'late teens', 'mid 30s', 'elderly'",
  "build": "body type, e.g. 'lean and wiry', 'broad-shouldered'",
  "symmetry": "one of: plain, average, pretty, handsome, striking, beautiful",
  "hairStyle": "length, style and colour",
  "eyeColor": "eye colour",
  "skinTone": "skin tone",
  "gait": "posture or bearing as it reads in the pose, e.g. 'upright and guarded'",
  "distinctMarks": "scars, tattoos, prosthetics, horns, heterochromia — '' if none visible",
  "clothing": "garments, armour, and any visible weapons or carried gear",
  "artStyle": "closest match from this list: ${ART_STYLES.join(' | ')}",
  "appearance": "2-4 sentences of prose a game master could read aloud to describe this character on sight"
}

Rules:
- Describe ONLY what is visible. If something is not shown, use "" — never guess.
- Keep every field except "appearance" under ${FIELD_CAP} characters.
- No commentary about art quality, the medium, or the image itself.
- If the image shows no character at all, set every field to "" and put what the image actually shows in "appearance".`;
}

/** Strip fences and isolate the outermost JSON object. */
export function extractJsonObject(raw: string): string {
    const fenceStripped = raw.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const start = fenceStripped.indexOf('{');
    const end = fenceStripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return fenceStripped;
    return fenceStripped.slice(start, end + 1);
}

function clamp(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (!trimmed) return '';
    return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trim();
}

/** Parse the model's JSON into a partial visual profile + appearance prose. */
export function parseVisionDescription(raw: string): VisionDescription {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
    } catch {
        throw new VisionParseError(raw);
    }
    if (!parsed || typeof parsed !== 'object') throw new VisionParseError(raw);

    const visualProfile: Partial<NPCVisualProfile> = {};
    for (const key of OBSERVED_FIELDS) {
        const value = clamp(parsed[key], FIELD_CAP);
        if (value) visualProfile[key] = value;
    }

    // artStyle is a controlled vocabulary — only accept a value that is in the
    // list, otherwise leave the user's existing choice alone.
    const artStyle = clamp(parsed.artStyle, FIELD_CAP);
    const matchedStyle = ART_STYLES.find(s => s.toLowerCase() === artStyle.toLowerCase());
    if (matchedStyle) visualProfile.artStyle = matchedStyle;

    const appearance = clamp(parsed.appearance, APPEARANCE_CAP);

    if (Object.keys(visualProfile).length === 0 && !appearance) {
        throw new VisionParseError(raw);
    }

    return { visualProfile, appearance, raw };
}

/**
 * Send one image to the vision provider and get a structured description back.
 * Non-streaming, queued behind the same per-endpoint limiter as every other
 * utility call, and registered with the tracker so the UI can show and extend it.
 */
export async function describeImage(
    provider: EndpointConfig | ProviderConfig,
    image: VisionImage,
    opts?: { subjectName?: string; signal?: AbortSignal; instruction?: string },
): Promise<VisionDescription> {
    const format = getApiFormat(provider);
    const instruction = opts?.instruction ?? buildDescribeInstruction(opts?.subjectName);
    const body = buildVisionBody(provider, image, instruction);

    let url = getChatUrl(provider);
    if (format === 'gemini' && provider.apiKey) {
        url += (url.includes('?') ? '&' : '?') + `key=${provider.apiKey}`;
    }
    const headers = buildChatHeaders(provider);

    const trackingName = (provider as EndpointConfig).modelName || provider.endpoint;
    const handle = startUtilityCall(TRACKING_LABEL, trackingName, CALL_TIMEOUT_MS);
    const ownAbort = new AbortController();
    const signal = opts?.signal
        ? AbortSignal.any([opts.signal, ownAbort.signal])
        : ownAbort.signal;
    handle.deadlinePromise.then(() => ownAbort.abort()).catch(() => { /* settled */ });

    const queue = getQueueForEndpoint(provider.endpoint);
    await queue.acquireSlot('normal');
    try {
        const res = await llmFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
        if (!res.ok) {
            const errBody = await res.text();
            if (res.status === 429 || res.status === 503 || res.status === 529) queue.onRateLimitHit();
            throw new Error(`Vision API error ${res.status}: ${errBody}`);
        }
        const data = await res.json();
        const text = extractContent(data, provider);
        if (!text.trim()) throw new VisionParseError('');
        const description = parseVisionDescription(text);
        handle.settleSuccess();
        return description;
    } catch (err) {
        const aborted = ownAbort.signal.aborted || opts?.signal?.aborted;
        if (aborted) handle.settleError(ownAbort.signal.aborted ? 'timeout' : 'aborted');
        else handle.settleError('error', err instanceof Error ? err.message : String(err));
        throw err;
    } finally {
        queue.releaseSlot();
    }
}
