import { it, expect } from 'vitest';
import { buildMapDiscoveriesBlock, buildMapEncounterBlock } from '../payload/volatile';
import type { GameContext } from '../../types';

it('only supplies discoveries for their recorded checkpoint, distinguishing nearby from reached', () => {
    const context = { currentPlaceId: 'camp', worldDay: 3, travel: null,
        mapDiscoveries: { placeId: 'camp', worldDay: 3, leg: null, sites: [
            { id: 'one', name: 'The Quiet Bell', type: 'shrine', description: 'A cracked bell.', distance: 1 },
        ] } } as GameContext;
    expect(buildMapDiscoveriesBlock(context)).toContain('Nearby, not yet reached: The Quiet Bell');
    expect(buildMapDiscoveriesBlock({ ...context, worldDay: 4 })).toBe('');
    expect(buildMapDiscoveriesBlock({ ...context, currentPlaceId: 'town' })).toBe('');
    expect(buildMapDiscoveriesBlock({ ...context, mapDiscoveries: undefined })).toBe('');
});

it('scopes encounter prompts and prevents quiet or consumed outcomes restarting', () => {
    const context = { currentPlaceId: 'camp', worldDay: 3, travel: null,
        mapEncounter: { key: '3:1:1', placeId: 'camp', worldDay: 3, leg: null, weather: 'fog', biome: 'plains',
            quiet: false, status: 'available', events: [{ id: 'test', source: 'biome', title: 'Travellers', text: 'A distant cart.' }] } } as GameContext;
    expect(buildMapEncounterBlock(context)).toContain('A distant cart.');
    expect(buildMapEncounterBlock(context)).toContain('Roleplay is optional');
    expect(buildMapEncounterBlock({ ...context, worldDay: 4 })).toBe('');
    expect(buildMapEncounterBlock({ ...context, currentPlaceId: 'town' })).toBe('');
    expect(buildMapEncounterBlock({ ...context, mapEncounter: { ...context.mapEncounter!, leg: 2 } })).toBe('');
    const handled = buildMapEncounterBlock({ ...context, mapEncounter: { ...context.mapEncounter!, status: 'handled' } });
    expect(handled).toContain('Do not restart');
    expect(handled).not.toContain('A distant cart.');
    expect(buildMapEncounterBlock({ ...context, mapEncounter: { ...context.mapEncounter!, quiet: true, events: [] } })).toContain('Quiet checkpoint');
});


it('supplies saved scene identities and outcome notes without inventing camp movement', () => {
    const context = { currentPlaceId: 'camp', worldDay: 3, travel: null,
        mapEncounter: { key: '3:1:1', placeId: 'camp', worldDay: 3, leg: null, weather: 'clear', biome: 'forest',
            scene: 'Leaf litter beneath the trees.', note: 'Agreed to meet tomorrow.', quiet: false, status: 'available',
            events: [{ id: 'merchant', source: 'road', title: 'Merchant', text: 'A pack beside the path.',
                actor: { id: 'person-1', name: 'Sella Reed', role: 'merchant', motive: 'trade supplies' } }] } } as GameContext;
    const block = buildMapEncounterBlock(context);
    expect(block).toContain('Sella Reed'); expect(block).toContain('trade supplies');
    expect(block).toContain('Agreed to meet tomorrow.'); expect(block).toContain('Leaf litter');
    expect(block).toContain('does not advance a travel leg');
    const handled = buildMapEncounterBlock({ ...context, mapEncounter: { ...context.mapEncounter!, status: 'handled' } });
    expect(handled).toContain('Agreed to meet tomorrow.'); expect(handled).not.toContain('A pack beside the path.');
});
