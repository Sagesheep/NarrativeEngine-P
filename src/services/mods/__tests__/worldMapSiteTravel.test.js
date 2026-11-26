import { describe, it, expect } from 'vitest';
import { fixedSiteAnchors, promoteSite, preferSiteStops } from '../../../../public/bundled-mods/worldmap/siteTravel.js';
import { buildCheckpoints } from '../../../../public/bundled-mods/worldmap/index.js';
const site = { id: 'site-one', x: 4, y: 0, type: 'shrine', name: 'The Quiet Bell', description: 'Old bell.' };
describe('site visits and overnight stops', () => {
    it('promotes once, preserves edited identity and creates reciprocal topology', () => {
        const ledger = [{ id: 'a', name: 'A', connections: [] }];
        const next = promoteSite(site, ledger, 'a');
        expect(ledger).toHaveLength(1);
        expect(next.find(entry => entry.id === site.id).name).toBe('The Quiet Bell');
        expect(next[0].connections).toContainEqual({ toId: site.id, band: 'local' });
        const edited = next.map(entry => entry.id === site.id ? { ...entry, name: 'Quiet Bell Abbey' } : entry);
        expect(promoteSite(site, edited, 'a')).toBe(edited);
        const anchors = fixedSiteAnchors({ anchors: [{ locationId: site.id, x: 99, y: 99 }] }, [site], edited);
        expect(anchors.find(anchor => anchor.locationId === site.id)).toMatchObject({ x: 4, y: 0, name: 'Quiet Bell Abbey' });
    });
    it('connects a site discovered from a transit camp to the road endpoints', () => {
        const ledger = [{ id: 'a', connections: [] }, { id: 'b', connections: [] },
            { id: 'camp', kind: 'transit', connections: [{ toId: 'a' }, { toId: 'b' }] }];
        const next = promoteSite(site, ledger, 'camp');
        expect(next.at(-1).connections.map(edge => edge.toId)).toEqual(['a', 'b']);
    });
    it('uses an on-route feature when both adjacent days fit the budget', () => {
        const cells = Array.from({ length: 9 }, (_, x) => ({ x, y: 0, cost: x }));
        const checkpoints = [{ x: 5, y: 0, day: 1, kind: 'camp' }];
        expect(preferSiteStops(checkpoints, cells, [site], 5)[0]).toMatchObject({ x: 4, siteId: site.id });
        expect(cells.at(-1).cost).toBe(8);
        expect(checkpoints[0].x).toBe(5);
    });
    it('refuses an off-route feature or a stop that would overrun the next day', () => {
        const cells = Array.from({ length: 11 }, (_, x) => ({ x, y: 0, cost: x }));
        const cp = [{ x: 5, y: 0, day: 1, kind: 'camp' }];
        expect(preferSiteStops(cp, cells, [site], 5)[0].x).toBe(5);
        expect(preferSiteStops(cp, cells, [{ ...site, y: 1 }], 5)[0].x).toBe(5);
    });
    it('keeps per-hop days and arrival count intact when preferring a feature', () => {
        const cells = Array.from({ length: 9 }, (_, x) => ({ x, y: 0, cost: x }));
        const result = buildCheckpoints([{ cells, legs: 2 }], 5, 1, [site]);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ day: 1, x: 4, siteId: site.id });
    });
});
