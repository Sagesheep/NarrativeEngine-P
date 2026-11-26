/**
 * Archive Events — shared EventEmitter for the archive write lifecycle.
 *
 * Phase 5 split: a tiny standalone module holding the event bus so the service
 * (emitter) and the NLP pipeline (listener) can be wired without a circular
 * import. The service emits `archive:written` after a scene is persisted; the
 * NLP pipeline attaches a listener that runs the deferred LLM extraction.
 */

import { EventEmitter } from 'events';

export const archiveEvents = new EventEmitter();

/** Event name constant — keep in one place so renames are mechanical. */
export const ARCHIVE_WRITTEN = 'archive:written';