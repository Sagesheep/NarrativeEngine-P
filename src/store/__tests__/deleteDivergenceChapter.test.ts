import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../useAppStore';
import type { DivergenceEntry, DivergenceRegister } from '../../types';

function makeEntry(id: string, sceneRef: string, source: 'auto' | 'manual'): DivergenceEntry {
    return {
        id,
        chapterId: 'CH01',
        category: 'npc_events',
        text: `fact ${id}`,
        sceneRef,
        npcIds: [],
        pinned: false,
        source,
    };
}

function seedRegister(entries: DivergenceEntry[]): DivergenceRegister {
    const reg: DivergenceRegister = {
        entries,
        chapterToggles: { '002': true },
        categoryToggles: {},
        lastUpdatedSceneId: '',
        lastUpdatedAt: 0,
        version: 2,
    };
    useAppStore.setState({ divergenceRegister: reg, activeCampaignId: 'test' } as Partial<ReturnType<typeof useAppStore.getState>>);
    return reg;
}

describe('WO-12.6: deleteDivergenceChapter purges non-manual facts on scene delete', () => {
    beforeEach(() => {
        useAppStore.setState({
            divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
        } as Partial<ReturnType<typeof useAppStore.getState>>);
    });

    it('removes auto entries for the deleted scene while preserving manual ones', () => {
        const reg = seedRegister([
            makeEntry('a1', '002', 'auto'),
            makeEntry('m1', '002', 'manual'),
            makeEntry('a2', '003', 'auto'),
            makeEntry('a3', '002', 'auto'),
        ]);
        expect(reg.entries.filter(e => e.sceneRef === '002').length).toBe(3);

        useAppStore.getState().deleteDivergenceChapter('002');

        const after = useAppStore.getState().divergenceRegister.entries;
        const remainingFor002 = after.filter(e => e.sceneRef === '002');
        // Only the manual entry survives.
        expect(remainingFor002).toHaveLength(1);
        expect(remainingFor002[0].source).toBe('manual');
        expect(remainingFor002[0].id).toBe('m1');
        // Other scenes untouched.
        expect(after.filter(e => e.sceneRef === '003')).toHaveLength(1);
        // chapterToggle for the deleted scene cleared.
        expect(useAppStore.getState().divergenceRegister.chapterToggles['002']).toBeUndefined();
    });

    it('is a no-op when no entries match the scene', () => {
        seedRegister([makeEntry('a1', '003', 'auto')]);
        useAppStore.getState().deleteDivergenceChapter('999');
        const after = useAppStore.getState().divergenceRegister.entries;
        expect(after).toHaveLength(1);
        expect(after[0].id).toBe('a1');
    });
});