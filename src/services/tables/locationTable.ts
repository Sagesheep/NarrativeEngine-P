import type { TableDescriptor } from '@narrative/engine';
import type { LocationEntry } from '../../types';
import { genericGet } from './genericAccessor';

export const locationTableDescriptor = {
    name: 'locations',
    fileSuffix: '.locations.json',
    recordShape: 'array',
    serverRoutes: { present: true, value: { get: true, put: true } },
    storeAccessor: { present: true, value: { read: true, write: true } },
    hydrator: { present: true, value: loadLocationTable },
    slice: { present: true, value: { field: 'locationLedger' } },
} satisfies TableDescriptor;

export async function loadLocationTable(campaignId: string): Promise<LocationEntry[]> {
    return genericGet(locationTableDescriptor as never, campaignId) as Promise<LocationEntry[]>;
}
