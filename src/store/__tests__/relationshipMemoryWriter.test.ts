import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/npc/relationshipStance', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../services/npc/relationshipStance')>();
    return { ...actual, clearRelationshipStanceCache: vi.fn() };
});

import { useAppStore } from '../useAppStore';
import {
    dropRelationshipMemoriesForScenes,
    markRelationshipMemoriesLoaded,
    resetRelationshipMemoryWriterForTests,
    updateRelationshipMemories,
} from '../relationshipMemoryStore';
import { mergeRelationshipMemoryCollections } from '../../services/archive-memory/relationshipMemory';
import { clearRelationshipStanceCache } from '../../services/npc/relationshipStance';
import { sceneStillArchived } from '../../services/turn/tracks/postCommit/relationshipMemoryTrack';
import { findEditedRecordIndex, latestArchivedSceneId } from '../../components/character/relationshipMemoryEditorHelpers';
import type { RelationshipMemoryRecord } from '../../types';

const CAMPAIGN = 'camp-1';

const rec = (sceneId: string, event: string, extra: Partial<RelationshipMemoryRecord> = {}): RelationshipMemoryRecord => ({
    sceneId, subject: 'npc-1', target: 'MC', mood: 'tender', impact: 'remembered',
    event, outcome: 'nodded', source: 'recorded', ...extra,
});

type Body = { npcToMc: RelationshipMemoryRecord[]; npcToNpc: RelationshipMemoryRecord[] };

let puts: Body[];
let releases: Array<() => void>;

beforeEach(() => {
    resetRelationshipMemoryWriterForTests();
    puts = [];
    releases = [];
    // Each PUT stays open until the test releases it, so saves can overlap.
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
        puts.push(JSON.parse(String(init?.body)));
        return new Promise(resolve => releases.push(() => resolve({ ok: true, json: async () => ({ ok: true }) })));
    }));
    useAppStore.setState({
        activeCampaignId: CAMPAIGN,
        relationshipMemoriesNpcToMc: [rec('001', 'old memory')],
        relationshipMemoriesNpcToNpc: [],
        archiveIndex: [],
    } as never);
    vi.mocked(clearRelationshipStanceCache).mockClear();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

async function flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('relationship memory writer', () => {
    it('two ratings that finish together both survive in the store and on disk', async () => {
        markRelationshipMemoriesLoaded(CAMPAIGN);
        const sceneA = { npcToMc: [rec('040', 'shared a meal')], npcToNpc: [], faults: [] };
        const sceneB = { npcToMc: [rec('041', 'saved her life')], npcToNpc: [], faults: [] };

        const a = updateRelationshipMemories(CAMPAIGN, cur => mergeRelationshipMemoryCollections(cur.npcToMc, cur.npcToNpc, sceneA));
        const b = updateRelationshipMemories(CAMPAIGN, cur => mergeRelationshipMemoryCollections(cur.npcToMc, cur.npcToNpc, sceneB));

        const events = () => useAppStore.getState().relationshipMemoriesNpcToMc.map(r => r.event);
        expect(events()).toEqual(['old memory', 'shared a meal', 'saved her life']);

        // Saves run one at a time; release them in order.
        await flush();
        expect(puts).toHaveLength(1);
        releases[0]();
        await flush();
        expect(puts).toHaveLength(2);
        releases[1]();
        await Promise.all([a, b]);

        expect(puts.at(-1)!.npcToMc.map(r => r.event)).toEqual(['old memory', 'shared a meal', 'saved her life']);
    });

    it('refuses to save when the campaign\'s memories were never loaded', async () => {
        // Nothing marked loaded: the store may be empty while the files hold the history.
        useAppStore.setState({ relationshipMemoriesNpcToMc: [] } as never);
        await expect(updateRelationshipMemories(CAMPAIGN, () => ({ npcToMc: [rec('050', 'new')], npcToNpc: [] })))
            .rejects.toThrow(/not loaded/);
        expect(puts).toHaveLength(0);
    });

    it('does not save into another campaign after a switch', async () => {
        markRelationshipMemoriesLoaded(CAMPAIGN);
        useAppStore.setState({ activeCampaignId: 'camp-2' } as never);
        await updateRelationshipMemories(CAMPAIGN, cur => cur);
        expect(puts).toHaveLength(0);
    });

    it('Clear Archive style drop removes every recorded memory but keeps hand-written ones', async () => {
        markRelationshipMemoriesLoaded(CAMPAIGN);
        useAppStore.setState({
            relationshipMemoriesNpcToMc: [rec('001', 'a'), rec('002', 'b', { source: 'user' })],
            relationshipMemoriesNpcToNpc: [rec('003', 'c', { target: 'npc-2' })],
        } as never);
        const done = dropRelationshipMemoriesForScenes(CAMPAIGN, () => true);
        await flush();
        releases[0]();
        expect(await done).toBe(2);
        expect(useAppStore.getState().relationshipMemoriesNpcToMc.map(r => r.event)).toEqual(['b']);
        expect(useAppStore.getState().relationshipMemoriesNpcToNpc).toEqual([]);
        expect(puts[0].npcToMc.map(r => r.event)).toEqual(['b']);
    });

    it('drops cached stance notes when memories are removed', async () => {
        markRelationshipMemoriesLoaded(CAMPAIGN);
        const done = dropRelationshipMemoriesForScenes(CAMPAIGN, n => n >= 1);
        await flush();
        releases[0]?.();
        await done;
        expect(clearRelationshipStanceCache).toHaveBeenCalled();
    });

    it('a plain merge of a new rating keeps cached stance notes', async () => {
        markRelationshipMemoriesLoaded(CAMPAIGN);
        const done = updateRelationshipMemories(CAMPAIGN, cur => ({ ...cur, npcToMc: [...cur.npcToMc, rec('002', 'x')] }));
        await flush();
        releases[0]();
        await done;
        expect(clearRelationshipStanceCache).not.toHaveBeenCalled();
    });
});

describe('late rating of a rolled-back scene', () => {
    it('is rejected when the scene number now belongs to a newer scene', () => {
        useAppStore.setState({ archiveIndex: [{ sceneId: '012', timestamp: 2000 }] } as never);
        expect(sceneStillArchived('012', 1000)).toBe(false);
        expect(sceneStillArchived('012', 2000)).toBe(true);
    });

    it('is rejected when the scene is gone', () => {
        useAppStore.setState({ archiveIndex: [{ sceneId: '011', timestamp: 1000 }] } as never);
        expect(sceneStillArchived('012', 1000)).toBe(false);
    });
});

describe('hand-written memories', () => {
    it('are filed under the latest archived scene, not scene 0', () => {
        expect(latestArchivedSceneId(['001', '012', '007'])).toBe('012');
        expect(latestArchivedSceneId([])).toBe('000');
    });

    it('editing one of two memories with the same key edits that one', () => {
        const first = rec('012', 'first', { source: 'user' });
        const second = rec('012', 'second', { source: 'user' });
        expect(findEditedRecordIndex([first, second], second)).toBe(1);
        // A copy of the record (store reloaded) is still found by its text.
        expect(findEditedRecordIndex([first, second], { ...second })).toBe(1);
    });
});
