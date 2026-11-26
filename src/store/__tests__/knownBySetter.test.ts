import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '../useAppStore';
import type { DivergenceEntry, DivergenceRegister } from '../../types';

function makeEntry(id: string, knownBy?: string[], subjectToken?: string): DivergenceEntry {
    return {
        id, chapterId: 'CH01', category: 'npc_events', text: `fact ${id}`,
        sceneRef: '001', npcIds: [], knownBy, subjectToken, pinned: false, source: 'auto',
    };
}

function seedRegister(entries: DivergenceEntry[]) {
    const reg: DivergenceRegister = {
        entries, chapterToggles: {}, categoryToggles: {},
        lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2,
    };
    useAppStore.setState({ divergenceRegister: reg, activeCampaignId: 'test' } as Partial<ReturnType<typeof useAppStore.getState>>);
}

describe('WO-11.1: editDivergenceKnownBy store setter', () => {
    beforeEach(() => {
        useAppStore.setState({
            divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
        } as Partial<ReturnType<typeof useAppStore.getState>>);
    });

    it('sets knownBy to a scoped token list', () => {
        seedRegister([makeEntry('f1', undefined)]);
        useAppStore.getState().editDivergenceKnownBy('f1', ['npc:n1', 'faction:guard']);
        const e = useAppStore.getState().divergenceRegister.entries.find(x => x.id === 'f1')!;
        expect(e.knownBy).toEqual(['npc:n1', 'faction:guard']);
    });

    it('sets knownBy to undefined (public/broadcast)', () => {
        seedRegister([makeEntry('f1', ['npc:n1'])]);
        useAppStore.getState().editDivergenceKnownBy('f1', undefined);
        const e = useAppStore.getState().divergenceRegister.entries.find(x => x.id === 'f1')!;
        expect(e.knownBy).toBeUndefined();
    });

    it('sets knownBy to [] (secret — player only)', () => {
        seedRegister([makeEntry('f1', undefined)]);
        useAppStore.getState().editDivergenceKnownBy('f1', []);
        const e = useAppStore.getState().divergenceRegister.entries.find(x => x.id === 'f1')!;
        expect(e.knownBy).toEqual([]);
    });

    it('only touches the targeted entry', () => {
        seedRegister([makeEntry('f1', ['npc:n1']), makeEntry('f2', ['npc:n2'])]);
        useAppStore.getState().editDivergenceKnownBy('f1', ['player']);
        const reg = useAppStore.getState().divergenceRegister;
        expect(reg.entries.find(x => x.id === 'f1')!.knownBy).toEqual(['player']);
        expect(reg.entries.find(x => x.id === 'f2')!.knownBy).toEqual(['npc:n2']);
    });
});

describe('WO-11.2: applySubjectTokens store setter', () => {
    beforeEach(() => {
        useAppStore.setState({
            divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
        } as Partial<ReturnType<typeof useAppStore.getState>>);
    });

    it('applies subjectToken updates to matching entries (non-destructive)', () => {
        seedRegister([
            makeEntry('f1'),
            makeEntry('f2', undefined, 'old.token'),
            makeEntry('f3'),
        ]);
        useAppStore.getState().applySubjectTokens([
            { id: 'f1', subjectToken: 'alex.identity' },
            { id: 'f2', subjectToken: 'alex.identity' },
        ]);
        const reg = useAppStore.getState().divergenceRegister;
        expect(reg.entries.find(x => x.id === 'f1')!.subjectToken).toBe('alex.identity');
        expect(reg.entries.find(x => x.id === 'f2')!.subjectToken).toBe('alex.identity');
        // f3 was not in the update list — untouched.
        expect(reg.entries.find(x => x.id === 'f3')!.subjectToken).toBeUndefined();
    });

    it('does not disable or delete any entry (non-destructive)', () => {
        seedRegister([makeEntry('f1'), makeEntry('f2')]);
        useAppStore.getState().applySubjectTokens([{ id: 'f1', subjectToken: 'g1' }]);
        const reg = useAppStore.getState().divergenceRegister;
        expect(reg.entries).toHaveLength(2);
        expect(reg.entries.find(x => x.id === 'f1')!.enabled).not.toBe(false);
    });

    it('no-ops on an empty update list', () => {
        seedRegister([makeEntry('f1', undefined, 'keep.token')]);
        useAppStore.getState().applySubjectTokens([]);
        expect(useAppStore.getState().divergenceRegister.entries.find(x => x.id === 'f1')!.subjectToken).toBe('keep.token');
    });
});