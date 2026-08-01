import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ValidatedMod } from '../modTypes';

const mocks = vi.hoisted(() => ({
    fetchMods: vi.fn(),
    setExtensionModules: vi.fn(),
}));
const { fetchMods, setExtensionModules } = mocks;

vi.mock('../modClient', () => ({ fetchMods: mocks.fetchMods }));
vi.mock('../../payload/contributions/extensions', () => ({ setExtensionModules: mocks.setExtensionModules }));

import { refreshMods } from '../modBootstrap';
import { postTurnTracks } from '../../turn/tracks';

const computeMod = (): ValidatedMod => ({
    id: 'compute-bootstrap',
    name: 'Compute Bootstrap',
    version: '1.0.0',
    description: '',
    file: 'compute-bootstrap.mod.json',
    contributions: [{ id: 'fixture', order: 100, text: 'fixture' }],
    compute: {
        file: 'compute-bootstrap.compute.js',
        hook: 'postTurn',
        capabilities: ['write:updateContext'],
    },
    computeSource: 'export default async function () { return null; }',
});

const dataMod = (): ValidatedMod => ({
    id: 'data-only',
    name: 'Data Only',
    version: '1.0.0',
    description: '',
    file: 'data-only.mod.json',
    contributions: [{ id: 'fixture', order: 100, text: 'fixture' }],
});

beforeEach(() => {
    vi.clearAllMocks();
    for (const track of postTurnTracks.list()) {
        if (track.id.startsWith('mod.') && track.id.endsWith('.compute')) postTurnTracks.unregister(track.id);
    }
});

describe('refreshMods compute registration', () => {
    it('registers compute tracks and removes them when the refreshed mod set no longer contains them', async () => {
        fetchMods.mockResolvedValueOnce({ mods: [computeMod()], faults: [] });
        await refreshMods();

        expect(postTurnTracks.get('mod.compute-bootstrap.compute')).toBeDefined();

        fetchMods.mockResolvedValueOnce({ mods: [dataMod()], faults: [] });
        await refreshMods();

        expect(postTurnTracks.get('mod.compute-bootstrap.compute')).toBeUndefined();
        expect(postTurnTracks.get('mod.data-only.compute')).toBeUndefined();
        expect(setExtensionModules).toHaveBeenCalledTimes(2);
    });
});

