import type { TimelineEvent } from '../../types';
import { SUPERSEDE_RULES } from '../../types';

export type ResolvedTruth = TimelineEvent;

/**
 * Core resolution: group events by subject|predicate, keep the latest scene per group,
 * then apply supersede rules to suppress logically invalidated predicates.
 */
export function resolveTimeline(events: TimelineEvent[]): ResolvedTruth[] {
    if (events.length === 0) return [];

    // Step 1: Group by subject|predicate
    const groups = new Map<string, TimelineEvent[]>();
    for (const e of events) {
        const key = `${e.subject}|${e.predicate}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(e);
    }

    // Step 2: For each group, sort by sceneId descending — latest scene wins
    const resolved: TimelineEvent[] = [];
    for (const groupEvents of groups.values()) {
        groupEvents.sort((a, b) => b.sceneId.localeCompare(a.sceneId));
        resolved.push(groupEvents[0]);
    }

    // Step 3: Apply supersede rules
    // Collect which predicates have a resolved winner per subject
    const subjectPredicates = new Map<string, Set<string>>();
    for (const r of resolved) {
        if (!subjectPredicates.has(r.subject)) subjectPredicates.set(r.subject, new Set());
        subjectPredicates.get(r.subject)!.add(r.predicate);
    }

    const final = resolved.filter(r => {
        // Check if any killer predicate (resolved for this subject) supersedes this predicate
        for (const [killer, victims] of Object.entries(SUPERSEDE_RULES)) {
            if (subjectPredicates.get(r.subject)?.has(killer) && victims.includes(r.predicate)) {
                return false;
            }
        }
        return true;
    });

    // Step 4: Sort by importance desc, then subject alpha
    final.sort((a, b) => b.importance - a.importance || a.subject.localeCompare(b.subject));
    return final;
}

/**
 * Resolution with optional subject/predicate filter applied after resolution.
 */
export function queryTimeline(
    events: TimelineEvent[],
    filter?: { subject?: string; predicate?: string }
): ResolvedTruth[] {
    const resolved = resolveTimeline(events);
    if (!filter) return resolved;
    return resolved.filter(r => {
        if (filter.subject && !r.subject.toLowerCase().includes(filter.subject.toLowerCase())) return false;
        if (filter.predicate && r.predicate !== filter.predicate) return false;
        return true;
    });
}

/**
 * Format resolved truths as a compact T3 context block.
 */
export function formatResolvedForContext(resolved: ResolvedTruth[]): string {
    if (resolved.length === 0) return '';
    const lines = resolved.map(r => `${r.subject} → ${r.predicate}: ${r.object} (scene ${r.sceneId})`);
    return `[RESOLVED WORLD STATE]\n${lines.join('\n')}\n[END RESOLVED WORLD STATE]`;
}

/**
 * All events that occurred in a specific scene (for dot-row popover).
 */
export function getEventsByScene(events: TimelineEvent[], sceneId: string): TimelineEvent[] {
    return events.filter(e => e.sceneId === sceneId);
}

/**
 * All events linked to a specific chapter (for chapter segment view).
 */
export function getEventsByChapter(events: TimelineEvent[], chapterId: string): TimelineEvent[] {
    return events.filter(e => e.chapterId === chapterId);
}

/**
 * Set of scene IDs that have at least one timeline event (for dot-row rendering).
 */
export function getScenesWithEvents(events: TimelineEvent[]): Set<string> {
    return new Set(events.map(e => e.sceneId));
}

/**
 * Max importance of events in a scene (for dot sizing).
 */
export function maxImportanceForScene(events: TimelineEvent[], sceneId: string): number {
    const sceneEvents = getEventsByScene(events, sceneId);
    if (sceneEvents.length === 0) return 0;
    return Math.max(...sceneEvents.map(e => e.importance));
}
