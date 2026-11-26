import type { RelationshipMemoryMood, RelationshipMemoryRecord } from '../../types';
import {
    isTruncatable,
    orderForTruncation,
    RELATIONSHIP_MEMORY_READING_WEIGHTS,
} from './relationshipMemoryReading';

export type RelationshipMemoryCompactionOptions = {
    unpinnedRecordLimit?: number;
    triggerRecordCount?: number;
};

export type RelationshipMemoryCompactionResult = {
    records: RelationshipMemoryRecord[];
    dropped: RelationshipMemoryRecord[];
    era?: RelationshipMemoryRecord;
    triggered: boolean;
};

export type RelationshipMemoryCompactionCollections = {
    npcToMc: RelationshipMemoryRecord[];
    npcToNpc: RelationshipMemoryRecord[];
    reports: {
        npcToMc: RelationshipMemoryCollectionReport;
        npcToNpc: RelationshipMemoryCollectionReport;
    };
};

export type RelationshipMemoryCollectionReport = {
    dropped: RelationshipMemoryRecord[];
    triggered: boolean;
    edges: Array<{
        edgeKey: string;
        result: RelationshipMemoryCompactionResult;
    }>;
};

const IMPACT_ORDER: readonly RelationshipMemoryRecord['impact'][] = [
    'passing', 'remembered', 'formative', 'carried',
];

function positiveInteger(value: number | undefined, fallback: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : fallback;
}

function sceneNumber(sceneId: string): number {
    const parsed = Number.parseInt(sceneId, 10);
    return Number.isFinite(parsed) ? parsed : 0;
}

function eraMood(records: readonly RelationshipMemoryRecord[]): RelationshipMemoryMood {
    const counts = new Map<RelationshipMemoryMood, number>();
    let dominant = records[0]?.mood ?? 'logistical';
    let dominantCount = 0;
    for (const record of records) {
        const count = (counts.get(record.mood) ?? 0) + 1;
        counts.set(record.mood, count);
        if (count > dominantCount) {
            dominant = record.mood;
            dominantCount = count;
        }
    }
    return dominant;
}

function eraImpact(records: readonly RelationshipMemoryRecord[]): RelationshipMemoryRecord['impact'] {
    return records.reduce<RelationshipMemoryRecord['impact']>((strongest, record) => {
        return IMPACT_ORDER.indexOf(record.impact) > IMPACT_ORDER.indexOf(strongest)
            ? record.impact
            : strongest;
    }, 'passing');
}

function eventText(record: RelationshipMemoryRecord): string {
    // WO-6 Appendix A: event is the shared fact. Legacy records without event fall back to
    // outcome for that entry only; the outcome is never preferred when event is available.
    return (record.event ?? record.outcome).trim();
}

function buildEraLine(dropped: readonly RelationshipMemoryRecord[]): RelationshipMemoryRecord {
    const first = dropped.reduce((earliest, record) =>
        sceneNumber(record.sceneId) < sceneNumber(earliest.sceneId) ? record : earliest,
    dropped[0]);
    const last = dropped.reduce((latest, record) =>
        sceneNumber(record.sceneId) > sceneNumber(latest.sceneId) ? record : latest,
    dropped[0]);
    const snippets = Array.from(new Set(dropped.map(eventText).filter(Boolean))).slice(
        0,
        RELATIONSHIP_MEMORY_READING_WEIGHTS.truncation.eraEventSnippetLimit,
    );
    const range = `${first.sceneId}-${last.sceneId}`;
    const eraId = `era:${first.subject}:${first.target}:${range}`;
    return {
        sceneId: `era:${range}`,
        subject: first.subject,
        target: first.target,
        mood: eraMood(dropped),
        impact: eraImpact(dropped),
        event: snippets.length > 0
            ? `Earlier history — ${snippets.join('; ')}`
            : 'Earlier history',
        outcome: `${dropped.length} records folded`,
        source: 'era',
        eraId,
        absorbedCount: dropped.length,
    };
}

/**
 * Compact one relationship edge for a read. The input is never mutated, and synthetic era lines
 * are deliberately kept out of the persisted shape by this function's caller.
 */
export function compactRelationshipMemoryEdge(
    records: readonly RelationshipMemoryRecord[],
    options: RelationshipMemoryCompactionOptions = {},
): RelationshipMemoryCompactionResult {
    const limit = positiveInteger(
        options.unpinnedRecordLimit,
        RELATIONSHIP_MEMORY_READING_WEIGHTS.truncation.unpinnedRecordLimit,
    );
    const trigger = positiveInteger(
        options.triggerRecordCount,
        RELATIONSHIP_MEMORY_READING_WEIGHTS.truncation.triggerRecordCount,
    );
    const fullLog = records.slice();
    const unpinned = fullLog.filter(isTruncatable);
    const excess = Math.max(0, unpinned.length - limit);
    if (excess === 0) {
        return { records: fullLog, dropped: [], triggered: fullLog.length > trigger };
    }

    const dropped = orderForTruncation(unpinned).slice(0, excess);
    const droppedSet = new Set(dropped);
    const retained = fullLog.filter(record => !droppedSet.has(record));
    const era = buildEraLine(dropped);
    return {
        records: [...retained, era],
        dropped,
        era,
        triggered: fullLog.length > trigger,
    };
}

/** The seal-time check is count-based and deliberately independent of scene or mood. */
export function shouldCompactRelationshipMemoryEdge(
    records: readonly RelationshipMemoryRecord[],
    triggerRecordCount = RELATIONSHIP_MEMORY_READING_WEIGHTS.truncation.triggerRecordCount,
): boolean {
    return records.length > positiveInteger(triggerRecordCount, 0);
}

/** Compact both persisted collections for a reader while leaving the full log untouched. */
export function compactRelationshipMemoryCollections(
    npcToMc: readonly RelationshipMemoryRecord[],
    npcToNpc: readonly RelationshipMemoryRecord[],
    options: RelationshipMemoryCompactionOptions = {},
): RelationshipMemoryCompactionCollections {
    const compactCollection = (records: readonly RelationshipMemoryRecord[]) => {
        const groups = new Map<string, { records: RelationshipMemoryRecord[]; lastIndex: number }>();
        records.forEach((record, index) => {
            const edgeKey = `${record.subject}|${record.target}`;
            const group = groups.get(edgeKey);
            if (group) {
                group.records.push(record);
                group.lastIndex = index;
            } else {
                groups.set(edgeKey, { records: [record], lastIndex: index });
            }
        });

        const edgeResults = Array.from(groups.entries()).map(([edgeKey, group]) => ({
            edgeKey,
            result: compactRelationshipMemoryEdge(group.records, options),
            lastIndex: group.lastIndex,
        }));
        const resultByKey = new Map(edgeResults.map(edge => [edge.edgeKey, edge] as const));
        const dropped = edgeResults.flatMap(edge => edge.result.dropped);
        const compacted: RelationshipMemoryRecord[] = [];
        records.forEach((record, index) => {
            const edge = resultByKey.get(`${record.subject}|${record.target}`);
            if (!edge?.result.dropped.includes(record)) compacted.push(record);
            if (edge && index === edge.lastIndex && edge.result.era) compacted.push(edge.result.era);
        });

        return {
            records: compacted,
            report: {
                dropped,
                triggered: edgeResults.some(edge => edge.result.triggered),
                edges: edgeResults.map(({ edgeKey, result }) => ({ edgeKey, result })),
            },
        };
    };
    const mc = compactCollection(npcToMc);
    const npc = compactCollection(npcToNpc);
    return {
        npcToMc: mc.records,
        npcToNpc: npc.records,
        reports: { npcToMc: mc.report, npcToNpc: npc.report },
    };
}

export const compactRelationshipMemoryForRead = compactRelationshipMemoryEdge;
