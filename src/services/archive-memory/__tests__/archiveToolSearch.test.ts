import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArchiveIndexEntry } from '../../../types';

vi.mock('../recall', () => ({
    fetchArchiveScenes: vi.fn(async (_c: string, ids: string[]) => ids.map(id => ({ sceneId: id, content: `text of ${id}`, tokens: 3 }))),
    retrieveArchiveMemory: vi.fn(() => ['540']),
}));

import { namedSceneIds, searchArchiveForTool } from '../archiveToolSearch';
import { fetchArchiveScenes, retrieveArchiveMemory } from '../recall';

const entry = (sceneId: string) => ({ sceneId, keywords: [], npcsMentioned: [] }) as unknown as ArchiveIndexEntry;
const index = ['537', '538', '540', '598'].map(entry);

describe('namedSceneIds', () => {
    it('reads a scene number in several languages', () => {
        expect(namedSceneIds('SCENE 598', index)).toEqual(['598']);
        expect(namedSceneIds('Dzwon zakład fryzjerski Watson scena 598 fryzjer', index)).toEqual(['598']);
        expect(namedSceneIds('co było w scenie 538?', index)).toEqual(['538']);
        expect(namedSceneIds('#540 and scene 537', index)).toEqual(['540', '537']);
    });

    it('takes a query of bare numbers, but not numbers inside a sentence', () => {
        expect(namedSceneIds('598', index)).toEqual(['598']);
        expect(namedSceneIds('Wilk claims 538 hand squeezes', index)).toEqual([]);
    });

    it('drops numbers that are not in the archive', () => {
        expect(namedSceneIds('scene 9999', index)).toEqual([]);
    });
});

describe('searchArchiveForTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ sceneIds: ['538'] }) })));
    });

    it('fetches a named scene without ranking', async () => {
        const text = await searchArchiveForTool('c1', index, 'scene 598');
        expect(text).toBe('### Archive scene 598\ntext of 598');
        expect(retrieveArchiveMemory).not.toHaveBeenCalled();
    });

    it('ranks with the embedding candidates when no scene is named', async () => {
        const text = await searchArchiveForTool('c1', index, 'Dzwon fryzjer');
        expect(vi.mocked(retrieveArchiveMemory).mock.calls[0][8]).toEqual(['538']);
        expect(text).toBe('### Archive scene 540\ntext of 540');
    });

    it('returns nothing without a campaign or an index', async () => {
        expect(await searchArchiveForTool(null, index, 'scene 598')).toBe('');
        expect(await searchArchiveForTool('c1', [], 'scene 598')).toBe('');
        expect(fetchArchiveScenes).not.toHaveBeenCalled();
    });
});
