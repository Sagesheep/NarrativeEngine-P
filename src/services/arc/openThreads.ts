// Phase 3 port: open-thread extractor for the ArcInjectorButton. Mobile had this in
// services/payload/payloadWorldContext.ts; desktop has no equivalent module. Inlined here
// because it's a small pure utility used only by the Arc Injector spawn path.
import type { ArchiveChapter } from '../../types';

export function computeOpenThreads(chapters: ArchiveChapter[]): { text: string; chapterId: string }[] {
    const allUnresolved: { text: string; chapterId: string }[] = [];
    for (const ch of chapters) {
        // Invalidated chapters have stale summaries, so their threads are stale too.
        if (ch.invalidated) continue;
        if (ch.unresolvedThreads) {
            for (const t of ch.unresolvedThreads) {
                allUnresolved.push({ text: t, chapterId: ch.chapterId });
            }
        }
    }
    const allResolved = new Set<string>();
    for (const ch of chapters) {
        // Desktop's ArchiveChapter type doesn't include resolvedThreads; tolerate its absence
        // (treat as no resolved threads — the open list is just the unresolved set).
        const resolved = (ch as ArchiveChapter & { resolvedThreads?: string[] }).resolvedThreads;
        if (resolved) {
            for (const t of resolved) {
                allResolved.add(t);
            }
        }
    }
    const open = allUnresolved.filter(t => !allResolved.has(t.text));
    return open.slice(-12);
}