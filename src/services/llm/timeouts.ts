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
