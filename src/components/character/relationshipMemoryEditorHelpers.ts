import type { RelationshipMemoryRecord } from '../../types';

export function recordKey(record: Pick<RelationshipMemoryRecord, 'sceneId' | 'subject' | 'target'>): string {
    return `${record.sceneId}|${record.subject}|${record.target}`;
}

/** The latest archived scene: a memory written by hand now belongs to where the story is.
 *  The old default, 'manual', read as scene 0, so a fresh memory ranked as the oldest one. */
export function latestArchivedSceneId(sceneIds: readonly string[]): string {
    let best = 0;
    for (const id of sceneIds) {
        const n = Number.parseInt(id, 10);
        if (Number.isFinite(n) && n > best) best = n;
    }
    return String(best).padStart(3, '0');
}

/** Where the record being edited sits in a collection: the same object if it is still
 *  there, else the first record with the same key and text. Keys alone are not unique —
 *  two hand-written memories of one pair in one scene share them. */
export function findEditedRecordIndex(
    collection: readonly RelationshipMemoryRecord[],
    edited: RelationshipMemoryRecord,
): number {
    const same = collection.indexOf(edited);
    if (same >= 0) return same;
    return collection.findIndex(record =>
        recordKey(record) === recordKey(edited)
        && record.event === edited.event
        && record.outcome === edited.outcome,
    );
}
