import type { EndpointConfig, ProviderConfig } from '../../types';
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
 * moment it is attached, and writes what it saw into the field the payload
 * already carries: the `appearance` prose (which `minifyNPC` injects every turn
 * and `buildPortraitPrompt` reads, so a described portrait can be regenerated
 * consistently), plus the closest `artStyle` preset.
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

/** Cap for the art-style name. */
const FIELD_CAP = 80;
/** Cap for the appearance prose — the portrait prompt carries it whole. */
const APPEARANCE_CAP = 700;

export type VisionDescription = {
    appearance: string;
    /** A preset from PORTRAIT_ART_STYLE_OPTIONS, or undefined when the model's pick matched none. */
    artStyle?: string;
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
  "appearance": "3-5 sentences a game master could read aloud. Open with the most identifying details (species, presented gender, age, build), then hair, eyes, skin, clothing and carried gear, and any scars, tattoos or other distinct marks.",
  "artStyle": "closest match from this list: ${ART_STYLES.join(' | ')}"
}

Rules:
- Describe ONLY what is visible. Leave out anything not shown — never guess.
- No commentary about art quality, the medium, or the image itself.
- If the image shows no character at all, put what the image actually shows in "appearance".`;
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

/** Parse the model's JSON into appearance prose + an art-style preset. */
export function parseVisionDescription(raw: string): VisionDescription {
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
    } catch {
        throw new VisionParseError(raw);
    }
    if (!parsed || typeof parsed !== 'object') throw new VisionParseError(raw);

    const appearance = clamp(parsed.appearance, APPEARANCE_CAP);
    if (!appearance) throw new VisionParseError(raw);

    // artStyle is a controlled vocabulary — only accept a value that is in the
    // list, otherwise leave the user's existing choice alone.
    const style = clamp(parsed.artStyle, FIELD_CAP);
    const artStyle = ART_STYLES.find(s => s.toLowerCase() === style.toLowerCase());

    return { appearance, artStyle, raw };
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

// ─── Free-form captioning (chat attachments) ─────────────────────────────
//
// The portrait path above returns character-sheet JSON. A chat attachment can
// be anything — a map, an item, a scene, a meme — so it gets prose instead,
// and a much shorter leash: this text is prepended to the player's message and
// then lives in the archive forever, so it must stay cheap to carry.

/** Cap for a chat-attachment caption. Roughly 100 tokens. */
export const CAPTION_CAP = 500;

export function buildCaptionInstruction(userNote?: string): string {
    const note = userNote?.trim()
        ? `

The player said this alongside the image: "${userNote.trim().slice(0, 200)}". Let it steer what you pay attention to, but describe the image, do not answer the message.`
        : '';
    return `Describe this image for a game master who cannot see it.

Write 2-4 sentences of plain prose. Lead with what the image IS (a person, a place, a map, an object, a diagram), then the details that would matter at a tabletop: who or what is shown, notable features, mood, and any legible text or labels.

Do not comment on art quality, style, or the medium. Do not speculate about anything not visible. Do not use markdown or bullet points.${note}`;
}

/**
 * Caption an arbitrary image as prose. Same transport as `describeImage`, but
 * no JSON contract — a caption that comes back malformed is still a caption.
 */
export async function captionImage(
    provider: EndpointConfig | ProviderConfig,
    image: VisionImage,
    opts?: { userNote?: string; signal?: AbortSignal },
): Promise<string> {
    const format = getApiFormat(provider);
    const body = buildVisionBody(provider, image, buildCaptionInstruction(opts?.userNote), { maxTokens: 400 });

    let url = getChatUrl(provider);
    if (format === 'gemini' && provider.apiKey) {
        url += (url.includes('?') ? '&' : '?') + `key=${provider.apiKey}`;
    }

    const trackingName = (provider as EndpointConfig).modelName || provider.endpoint;
    const handle = startUtilityCall('vision-caption', trackingName, CALL_TIMEOUT_MS);
    const ownAbort = new AbortController();
    const signal = opts?.signal ? AbortSignal.any([opts.signal, ownAbort.signal]) : ownAbort.signal;
    handle.deadlinePromise.then(() => ownAbort.abort()).catch(() => { /* settled */ });

    const queue = getQueueForEndpoint(provider.endpoint);
    await queue.acquireSlot('normal');
    try {
        const res = await llmFetch(url, { method: 'POST', headers: buildChatHeaders(provider), body: JSON.stringify(body), signal });
        if (!res.ok) {
            const errBody = await res.text();
            if (res.status === 429 || res.status === 503 || res.status === 529) queue.onRateLimitHit();
            throw new Error(`Vision API error ${res.status}: ${errBody}`);
        }
        const text = extractContent(await res.json(), provider).trim();
        if (!text) throw new VisionParseError('');
        handle.settleSuccess();
        // Strip stray fences/quotes some models wrap prose in.
        const cleaned = text.replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/i, '').trim();
        return cleaned.length <= CAPTION_CAP ? cleaned : cleaned.slice(0, CAPTION_CAP).trim() + '…';
    } catch (err) {
        const aborted = ownAbort.signal.aborted || opts?.signal?.aborted;
        if (aborted) handle.settleError(ownAbort.signal.aborted ? 'timeout' : 'aborted');
        else handle.settleError('error', err instanceof Error ? err.message : String(err));
        throw err;
    } finally {
        queue.releaseSlot();
    }
}

/** Wrap a caption in the block the story model sees inline in the player's message. */
export function formatAttachmentBlock(caption: string): string {
    return `[THE PLAYER SHOWS YOU AN IMAGE]
${caption.trim()}
[/IMAGE]`;
}

/** Marker pair wrapping an attachment caption inside a player message. */
const ATTACHMENT_BLOCK_RE = /^\[THE PLAYER SHOWS YOU AN IMAGE\]\r?\n([\s\S]*?)\r?\n\[\/IMAGE\]\s*/;

/**
 * Inverse of `formatAttachmentBlock` — pull the caption back out of a stored
 * message so the bubble can show the player's own words with the caption
 * tucked behind a disclosure instead of shouting it inline.
 */
export function splitAttachmentBlock(text: string): { caption: string; body: string } {
    const match = ATTACHMENT_BLOCK_RE.exec(text);
    if (!match) return { caption: '', body: text };
    return { caption: match[1].trim(), body: text.slice(match[0].length) };
}
