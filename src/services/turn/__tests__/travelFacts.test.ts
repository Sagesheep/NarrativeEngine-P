import { describe, expect, it } from 'vitest';
import type { GameContext, LocationEntry } from '../../../types';
import { buildTravelFacts } from '../travelFacts';

function place(id: string, name: string, connections: LocationEntry['connections'] = []): LocationEntry {
    return {
        id,
        name,
        aliases: '',
        broadLocation: '',
        features: [],
        connections,
        description: '',
        firstSeenScene: '1',
        lastSeenScene: '1',
        source: 'manual',
    };
}

function context(overrides: Partial<GameContext> = {}): GameContext {
    return { currentPlaceId: 'ashfen', worldDay: 12, ...overrides } as GameContext;
}

describe('buildTravelFacts', () => {
    it('returns [] when worldDay is unset', () => {
        const ledger = [place('ashfen', 'Ashfen Crossing', [{ toId: 'ravenhold', band: 'far' }]), place('ravenhold', 'Ravenhold')];
        expect(buildTravelFacts(context({ worldDay: undefined }), ledger)).toEqual([]);
    });

    it('returns [] when the only connection is adjacent', () => {
        const ledger = [place('ashfen', 'Ashfen Crossing', [{ toId: 'ravenhold', band: 'adjacent' }]), place('ravenhold', 'Ravenhold')];
        expect(buildTravelFacts(context(), ledger)).toEqual([]);
    });

    it('renders the exact far-band wording and minimum-day floor', () => {
        const ledger = [place('ashfen', 'Ashfen Crossing', [{ toId: 'ravenhold', band: 'far' }]), place('ravenhold', 'Ravenhold')];
        expect(buildTravelFacts(context(), ledger)).toEqual([
            'Ashfen Crossing → Ravenhold is far (16–30 grids), roughly 6–10 days on foot. Today is day 12; arrival is impossible before day 18.',
        ]);
    });

    it('caps at three facts and orders nearest-first by band', () => {
        const ledger = [
            place('ashfen', 'Ashfen Crossing', [
                { toId: 'far', band: 'far' },
                { toId: 'regional', band: 'regional' },
                { toId: 'adjacent', band: 'adjacent' },
                { toId: 'nearby', band: 'nearby' },
                { toId: 'local', band: 'local' },
            ]),
            place('far', 'Farhold'),
            place('regional', 'Regional Keep'),
            place('adjacent', 'Ashfen Gate'),
            place('nearby', 'Nearford'),
            place('local', 'Localstead'),
        ];
        const facts = buildTravelFacts(context(), ledger);
        expect(facts).toHaveLength(3);
        expect(facts[0]).toContain('→ Nearford is nearby');
        expect(facts[1]).toContain('→ Localstead is local');
        expect(facts[2]).toContain('→ Regional Keep is regional');
    });

    it('lazily reads a legacy long connection as far', () => {
        const legacyLong = 'long' as unknown as LocationEntry['connections'][number]['band'];
        const ledger = [place('ashfen', 'Ashfen Crossing', [{ toId: 'ravenhold', band: legacyLong }]), place('ravenhold', 'Ravenhold')];
        expect(buildTravelFacts(context(), ledger)[0]).toContain('Ravenhold is far (16–30 grids)');
    });
});