import { describe, expect, it, vi } from 'vitest';
import type { TableDescriptor } from '@narrative/engine';
import { createTableSlice } from '../genericAccessor';

type Location = { id: string; name: string };
type LocationState = {
    context: {
        currentPlaceId: string | null;
        currentFeature: string | null;
    };
};

const locations: TableDescriptor = {
    name: 'locations',
    fileSuffix: '.locations.json',
    recordShape: 'array',
    hooks: {},
};

describe('createTableSlice', () => {
    it('merges an onRemove state patch while removing the record and allows the hook to schedule its save', () => {
        const scheduleCampaignStateSave = vi.fn();
        const descriptor: TableDescriptor = {
            ...locations,
            hooks: {
                onRemove: ((_campaignId: string, id: string, state: LocationState) => {
                    if (state.context.currentPlaceId !== id) return undefined;
                    scheduleCampaignStateSave();
                    return {
                        context: {
                            currentPlaceId: null,
                            currentFeature: null,
                        },
                    };
                }) as never,
            },
        };
        const state: LocationState = {
            context: {
                currentPlaceId: 'standing-here',
                currentFeature: 'market-square',
            },
        };
        const slice = createTableSlice<Location[], LocationState>(descriptor, []);

        const result = slice.remove(
            [{ id: 'standing-here', name: 'Market' }, { id: 'elsewhere', name: 'Docks' }],
            'standing-here',
            { campaignId: 'camp-1', state },
        );

        expect(result.field).toEqual([{ id: 'elsewhere', name: 'Docks' }]);
        expect(result.statePatch).toEqual({
            context: {
                currentPlaceId: null,
                currentFeature: null,
            },
        });
        expect(scheduleCampaignStateSave).toHaveBeenCalledTimes(1);
    });

    it('does not create a state patch when the hook has no cross-table work', () => {
        const descriptor: TableDescriptor = {
            ...locations,
            hooks: {
                onRemove: ((_campaignId: string, id: string, state: LocationState) => (
                    state.context.currentPlaceId === id ? { context: state.context } : undefined
                )) as never,
            },
        };
        const slice = createTableSlice<Location[], LocationState>(descriptor, []);

        const result = slice.remove(
            [{ id: 'standing-here', name: 'Market' }, { id: 'elsewhere', name: 'Docks' }],
            'elsewhere',
            {
                campaignId: 'camp-1',
                state: { context: { currentPlaceId: 'standing-here', currentFeature: 'market-square' } },
            },
        );

        expect(result.field).toEqual([{ id: 'standing-here', name: 'Market' }]);
        expect(result.statePatch).toBeUndefined();
    });
});
