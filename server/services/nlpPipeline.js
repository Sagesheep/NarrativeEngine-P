/**
 * NLP Pipeline — deferred LLM extraction listener.
 *
 * Phase 5 split: the append route used to inline a `setImmediate` block (lines
 * 187-244 of the old archive.js) that ran LLM witness classification + timeline
 * event extraction after the response was sent. That block now lives here,
 * wired to the `archive:written` event emitted by `archiveService.js`.
 *
 * Invariants preserved:
 *  - Runs only when `utilityConfig.endpoint` is set AND `npcNames.length > 0`
 *    (same gate as the original).
 *  - Schedules via `setImmediate` so it lands after the route's `res.json()`.
 *  - Each write to the index / timeline happens under `withCampaignLock` so
 *    it can't clobber a concurrent append (same lock primitive, same scope).
 *  - Regex timeline extraction is the fallback when the LLM returns null
 *    (preserved bit-for-bit).
 *  - Errors are logged and swallowed — deferred failures must not crash the
 *    process or surface to the long-settled HTTP response.
 *
 * Red zone: `nlp.js` and `llmProxy.js` are NOT modified. We only consume their
 * exports here.
 */

import { archiveEvents, ARCHIVE_WRITTEN } from './archiveEvents.js';
import { withCampaignLock } from '../lib/writeLock.js';
import {
    extractTimelineEventsRegex,
} from '../lib/nlp.js';
import { extractWitnessesLLM, extractTimelineEventsLLM } from './llmProxy.js';
import { normalizeEntityName } from '../lib/entityResolution.js';
import {
    readIndexAt, writeIndexAt, archiveIndexPath, readTimeline, writeTimeline,
} from './archiveRepository.js';

/**
 * Attach the deferred-LLM listener. Called once at server boot.
 *
 * Listener signature mirrors the event payload emitted by archiveService:
 *   { campaignId, sceneId, npcNames, userContent, assistantContent,
 *     combinedText, uniqueEntityNames, knownEntities, currentChapterId,
 *     utilityConfig }
 */
export function registerNlpPipeline() {
    archiveEvents.on(ARCHIVE_WRITTEN, (payload) => {
        const {
            campaignId, sceneId, npcNames, userContent, assistantContent,
            combinedText, uniqueEntityNames, knownEntities, currentChapterId,
            utilityConfig,
        } = payload;

        // Same gate as the original: only run when an endpoint is configured
        // AND we actually detected NPCs in the assistant output.
        if (!utilityConfig?.endpoint || npcNames.length === 0) return;

        setImmediate(async () => {
            try {
                // ── Witness extraction → patch the index entry's witnesses field ──
                const witnessResult = await extractWitnessesLLM(npcNames, userContent, assistantContent, utilityConfig);
                if (witnessResult && Array.isArray(witnessResult.witnesses)) {
                    await withCampaignLock(campaignId, () => {
                        const idxp = archiveIndexPath(campaignId);
                        const entries = readIndexAt(idxp, []);
                        const target = entries.find(e => e.sceneId === sceneId);
                        if (target) {
                            target.witnesses = witnessResult.witnesses;
                            target.witnessSource = 'llm';
                            if (Array.isArray(witnessResult.mentioned)) {
                                target.npcsMentioned = witnessResult.mentioned;
                            }
                        }
                        writeIndexAt(idxp, entries);
                    });
                    console.log(`[Archive] LLM witnesses patched for scene #${sceneId}`);
                }

                // ── Timeline event extraction → append to timeline store ──
                const newEventsRaw = await extractTimelineEventsLLM(uniqueEntityNames, combinedText, sceneId, currentChapterId, utilityConfig);
                let newEvents = null;
                if (newEventsRaw === null) {
                    newEvents = extractTimelineEventsRegex(npcNames, combinedText, sceneId, currentChapterId);
                } else {
                    newEvents = newEventsRaw;
                    for (const ev of newEvents) {
                        ev.subject = normalizeEntityName(ev.subject, knownEntities);
                        ev.object = normalizeEntityName(ev.object, knownEntities);
                    }
                }

                if (newEvents && newEvents.length > 0) {
                    await withCampaignLock(campaignId, () => {
                        const existingEvents = readTimeline(campaignId, []);
                        const maxId = existingEvents.reduce((max, e) => {
                            const num = parseInt(e.id.replace('tl_', ''), 10);
                            return num > max ? num : max;
                        }, 0);
                        let idCounter = maxId + 1;
                        for (const ev of newEvents) {
                            existingEvents.push({
                                id: `tl_${String(idCounter++).padStart(4, '0')}`,
                                ...ev,
                            });
                        }
                        writeTimeline(campaignId, existingEvents);
                    });
                    console.log(`[Archive] LLM timeline events appended for scene #${sceneId} (${newEvents.length} events)`);
                }
            } catch (err) {
                console.warn(`[Archive] Deferred LLM extraction failed for scene #${sceneId}:`, err.message);
            }
        });
    });
}