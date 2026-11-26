import { describe, it, expect } from 'vitest';
import { renderRegisterForPayload, privateLabel } from '../divergenceRegister';
import type { DivergenceEntry, DivergenceRegister } from '../../../types';

const ledger = [{ id: 'npc_1', name: 'Grak' }, { id: 'npc_2', name: 'Ilsa' }] as never[];

function entry(id: string, text: string, knownBy: string[] | undefined): DivergenceEntry {
    return { id, chapterId: 'CH01', category: 'npc_events', text, sceneRef: '001', npcIds: [], knownBy, pinned: false, source: 'auto' } as DivergenceEntry;
}

function register(entries: DivergenceEntry[]): DivergenceRegister {
    return { entries, chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 };
}

describe('canon block (publicOnly) and knownBy', () => {
    const reg = register([
        entry('a', 'The bridge is out', undefined),
        entry('b', 'The PC allied with Grak', ['player', 'npc_1']),
        entry('c', 'The PC hid the ring', ['player']),
        entry('d', 'Ilsa poisoned the well', ['npc_2']),
    ]);
    const text = renderRegisterForPayload(reg, undefined, undefined, ledger, true);

    it('keeps public facts unlabelled', () => {
        expect(text).toContain('• The bridge is out\n');
    });

    it('includes facts the player knows, labelled with who else knows them', () => {
        expect(text).toContain('The PC allied with Grak (private: known only to the player character and Grak)');
        expect(text).toContain('The PC hid the ring (private: known only to the player character)');
    });

    it('leaves out facts only NPCs know', () => {
        expect(text).not.toContain('Ilsa poisoned the well');
    });

    it('does not depend on who is on stage', () => {
        expect(renderRegisterForPayload(reg, undefined, undefined, ledger, true)).toBe(text);
    });
});

describe('privateLabel', () => {
    it('labels secrets and NPC-only facts', () => {
        expect(privateLabel([], ledger)).toBe(' (secret)');
        expect(privateLabel(['npc_2', 'faction:guild'], ledger)).toBe(' (known only to Ilsa, guild members)');
        expect(privateLabel(undefined, ledger)).toBe('');
    });
});
