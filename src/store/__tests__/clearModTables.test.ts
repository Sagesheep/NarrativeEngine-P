import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../useAppStore';

/**
 * Phase 6.4 / `DATA_POLICY.md` §3 — the local half of the clean action.
 *
 * `clearModTables` drops one mod's in-memory rows after the server has already
 * removed the files. Two properties matter and both are about not destroying
 * more than was asked for: it must not touch another mod's rows, and it must
 * not write or delete anything itself.
 */
type StoreState = ReturnType<typeof useAppStore.getState>;

const seed = (modTables: Record<string, unknown>) => {
    useAppStore.setState({ modTables, activeCampaignId: 'c1' } as Partial<StoreState>);
};

describe('clearModTables', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        seed({});
    });

    it('drops only the named mod\'s entries', () => {
        seed({
            'mod.compendium.powers': [{ id: 'fireball' }],
            'mod.compendium.notes': [{ id: 'n1' }],
            'mod.arc.arcs': [{ id: 'arc-1' }],
        });

        useAppStore.getState().clearModTables('compendium');

        expect(useAppStore.getState().modTables).toEqual({ 'mod.arc.arcs': [{ id: 'arc-1' }] });
    });

    it('does not drop a mod whose id merely starts with the same characters', () => {
        // `arc` vs `arc-2`: the namespace separator is the dot, and matching on
        // the bare id would erase a sibling mod's live rows.
        seed({
            'mod.arc.arcs': [{ id: 'a' }],
            'mod.arc-2.arcs': [{ id: 'b' }],
        });

        useAppStore.getState().clearModTables('arc');

        expect(useAppStore.getState().modTables).toEqual({ 'mod.arc-2.arcs': [{ id: 'b' }] });
    });

    it('touches the network not at all — the DELETE is made once, elsewhere', () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        seed({ 'mod.compendium.powers': [{ id: 'fireball' }] });

        useAppStore.getState().clearModTables('compendium');

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('is a no-op for a mod with no rows', () => {
        seed({ 'mod.arc.arcs': [{ id: 'a' }] });
        useAppStore.getState().clearModTables('compendium');
        expect(useAppStore.getState().modTables).toEqual({ 'mod.arc.arcs': [{ id: 'a' }] });
    });
});
