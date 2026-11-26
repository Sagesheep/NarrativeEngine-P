/**
 * Timeout tiers for tracked LLM utility calls (those wired into utilityCallTracker).
 *
 * - AI calls (context/relevance/summarization) get a generous budget — slow local
 *   models are common, the user can see them running in the strip, and EXTEND is there
 *   if they need longer.
 * - Engine calls (game-engine classifiers like scene-stakes) must stay snappy: they
 *   gate turn pacing and a wrong/late answer is cheap to fall back from.
 */
export const AI_CALL_TIMEOUT_MS = 180_000;     // 3 min
export const ENGINE_CALL_TIMEOUT_MS = 30_000;  // 30 s

export const DEFAULT_STORY_TIMEOUT_SECONDS = 600;
export const MIN_STORY_TIMEOUT_SECONDS = 30;
export const MAX_STORY_TIMEOUT_SECONDS = 3600;

/** Validate persisted values as well as settings entered in the UI. */
export function normalizeStoryTimeoutSeconds(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return DEFAULT_STORY_TIMEOUT_SECONDS;
    }
    return Math.min(MAX_STORY_TIMEOUT_SECONDS, Math.max(MIN_STORY_TIMEOUT_SECONDS, Math.round(value)));
}

/**
 * Chapter seal reads a whole chapter and writes its summary plus facts in one call,
 * so on slow or local models it often outruns the 3-minute AI_CALL budget. It runs
 * in the background, so a longer default costs nothing while it works.
 */
export const DEFAULT_SEAL_TIMEOUT_SECONDS = 480;
export const MIN_SEAL_TIMEOUT_SECONDS = 60;
export const MAX_SEAL_TIMEOUT_SECONDS = 3600;

export function normalizeSealTimeoutSeconds(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return DEFAULT_SEAL_TIMEOUT_SECONDS;
    }
    return Math.min(MAX_SEAL_TIMEOUT_SECONDS, Math.max(MIN_SEAL_TIMEOUT_SECONDS, Math.round(value)));
}
