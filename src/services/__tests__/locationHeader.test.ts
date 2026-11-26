import { describe, it, expect } from 'vitest';
import { parseLocationHeader, resolveLocationHeader } from '../locationHeader';
import type { LocationEntry } from '../../types';

function entry(partial: Partial<LocationEntry> & { id: string; name: string }): LocationEntry {
    return {
        aliases: '',
        broadLocation: '',
        features: [],
        connections: [],
        description: '',
        firstSeenScene: '1',
        lastSeenScene: '1',
        source: 'manual',
        ...partial,
    };
}

const apartment = entry({
    id: 'loc_apt',
    name: "Nero's Apartment",
    aliases: 'the apartment, apartment',
    features: ['Living Room'],
});
const academy = entry({
    id: 'loc_academy',
    name: 'Ninja Academy',
    aliases: 'the academy',
    features: ['Class A', 'training yard'],
});
const konoha = entry({ id: 'loc_konoha', name: 'Konoha' });
const LEDGER = [apartment, academy, konoha];

const gm = (header: string) =>
    `📅 [Time] Evening | 📍 [Location] ${header} | 👥 [Present] Alice, Nero\n\nThe rain kept falling.`;

describe('parseLocationHeader', () => {
    it('extracts the location field from a full scene header', () => {
        expect(parseLocationHeader(gm("Nero's Apartment"))).toBe("Nero's Apartment");
    });

    it('returns null when there is no header', () => {
        expect(parseLocationHeader('Just prose, no header at all.')).toBeNull();
    });

    it('stops at a following marker even when the pipe is missing', () => {
        expect(parseLocationHeader('📍 [Location] Ninja Academy 👥 [Present] Iruka')).toBe('Ninja Academy');
    });

    it('rejects absurdly long captures', () => {
        expect(parseLocationHeader(`📍 [Location] ${'x'.repeat(150)}`)).toBeNull();
    });

    it('is case-insensitive on the tag', () => {
        expect(parseLocationHeader('📍 [location] Konoha')).toBe('Konoha');
    });

    it('accepts the bare-pin dialect (custom rulesets, no [Location] tag)', () => {
        expect(parseLocationHeader('📍 Town of Beginning - Back Alley')).toBe('Town of Beginning - Back Alley');
        expect(parseLocationHeader('📍 Town of Beginning - Market Square')).toBe('Town of Beginning - Market Square');
    });

    it('accepts the "Location:" labeled dialect', () => {
        expect(parseLocationHeader('📍 Location: Ninja Academy')).toBe('Ninja Academy');
    });

    it('strips brackets/markdown down to plain text (the user-reported bracket case)', () => {
        expect(parseLocationHeader('📍 [Town of Beginning - Market Square]')).toBe('Town of Beginning - Market Square');
        expect(parseLocationHeader('**📍 Town of Beginning - Back Alley**')).toBe('Town of Beginning - Back Alley');
        expect(parseLocationHeader('📍 "Town of Beginning"')).toBe('Town of Beginning');
    });

    it('treats parentheses as a segment break', () => {
        expect(parseLocationHeader('📍 Town of Beginning (Market Square)')).toBe('Town of Beginning - Market Square');
    });

    it('takes the LAST header when a reply shifts scenes mid-text', () => {
        const reply = '📍 Town of Beginning - Market Square\n\nYou walk on.\n\n📍 Town of Beginning - Back Alley\n\nIt is dark here.';
        expect(parseLocationHeader(reply)).toBe('Town of Beginning - Back Alley');
    });
});

describe('resolveLocationHeader', () => {
    it('no header → none (pointer stands)', () => {
        expect(resolveLocationHeader('prose only', LEDGER, 'loc_apt').kind).toBe('none');
    });

    it('whole-string match moves the pointer with no feature', () => {
        const r = resolveLocationHeader(gm('Ninja Academy'), LEDGER, null);
        expect(r).toEqual({ kind: 'resolved', placeId: 'loc_academy', feature: null, appendFeature: false });
    });

    it('resolves via alias', () => {
        const r = resolveLocationHeader(gm('the academy'), LEDGER, null);
        expect(r.kind).toBe('resolved');
        if (r.kind === 'resolved') expect(r.placeId).toBe('loc_academy');
    });

    it("place — known feature: one entry, feature set, no duplicate append", () => {
        const r = resolveLocationHeader(gm("Nero's Apartment — Living Room"), LEDGER, null);
        expect(r).toEqual({ kind: 'resolved', placeId: 'loc_apt', feature: 'Living Room', appendFeature: false });
    });

    it('place — NEW feature: same entry, appendFeature true (the kitchen rule)', () => {
        const r = resolveLocationHeader(gm("Nero's Apartment — Kitchen"), LEDGER, null);
        expect(r).toEqual({ kind: 'resolved', placeId: 'loc_apt', feature: 'Kitchen', appendFeature: true });
    });

    it('handles hyphen-with-spaces and colon separators the same way', () => {
        for (const header of ["Nero's Apartment - Kitchen", "Nero's Apartment: Kitchen"]) {
            const r = resolveLocationHeader(gm(header), LEDGER, null);
            expect(r.kind).toBe('resolved');
            if (r.kind === 'resolved') {
                expect(r.placeId).toBe('loc_apt');
                expect(r.feature).toBe('Kitchen');
            }
        }
    });

    it('does not split unspaced hyphens inside names', () => {
        const r = resolveLocationHeader(gm('Sakura-jima Street'), LEDGER, null);
        expect(r.kind).toBe('unknown');
        if (r.kind === 'unknown') expect(r.suggestion.name).toBe('Sakura-jima Street');
    });

    it('region prefix is skipped: "Konoha — Ninja Academy — Class A"', () => {
        const r = resolveLocationHeader(gm('Konoha — Ninja Academy — Class A'), LEDGER, null);
        // Konoha resolves first (left→right), Ninja Academy resolves too → treated as
        // context, Class A becomes the feature of the FIRST match. Verify the contract:
        expect(r.kind).toBe('resolved');
        if (r.kind === 'resolved') {
            expect(r.placeId).toBe('loc_konoha');
            expect(r.feature).toBe('Class A');
        }
    });

    it('trailing known place is context, not a feature: "Ninja Academy, Konoha"', () => {
        const r = resolveLocationHeader(gm('Ninja Academy, Konoha'), LEDGER, null);
        expect(r).toEqual({ kind: 'resolved', placeId: 'loc_academy', feature: null, appendFeature: false });
    });

    it('bare known feature while a place is current → feature-only', () => {
        const r = resolveLocationHeader(gm('Living Room'), LEDGER, 'loc_apt');
        expect(r).toEqual({ kind: 'feature-only', feature: 'Living Room', appendFeature: false });
    });

    it('bare generic room word while a place is current → feature-only with append', () => {
        const r = resolveLocationHeader(gm('Kitchen'), LEDGER, 'loc_apt');
        expect(r).toEqual({ kind: 'feature-only', feature: 'Kitchen', appendFeature: true });
    });

    it('manual structural sublocations become features of the current place', () => {
        const town = entry({ id: 'loc_town', name: 'Town of Beginning', features: ['Market Square'] });
        for (const feature of ['Wizard Tower Base', 'Wizard Tower Top', 'Back Alley']) {
            const r = resolveLocationHeader(gm(feature), [town], 'loc_town');
            expect(r).toEqual({ kind: 'feature-only', feature, appendFeature: true });
        }
    });

    it('a distinct named building remains a new-place suggestion', () => {
        const town = entry({ id: 'loc_town', name: 'Town of Beginning' });
        const r = resolveLocationHeader(gm('The Hearthstone Cottage'), [town], 'loc_town');
        expect(r.kind).toBe('unknown');
    });
    it('bare generic room word with NO current place → none (never a world suggestion)', () => {
        expect(resolveLocationHeader(gm('Kitchen'), LEDGER, null).kind).toBe('none');
    });

    it('unknown place → suggestion with first segment as name and raw as context', () => {
        const r = resolveLocationHeader(gm('Ichiraku Ramen — counter'), LEDGER, 'loc_apt');
        expect(r.kind).toBe('unknown');
        if (r.kind === 'unknown') {
            expect(r.suggestion.name).toBe('Ichiraku Ramen');
            expect(r.suggestion.context).toBe('Ichiraku Ramen — counter');
        }
    });

    it('empty ledger cold start: unknown place still becomes a suggestion', () => {
        const r = resolveLocationHeader(gm("MC's House"), [], null);
        expect(r.kind).toBe('unknown');
        if (r.kind === 'unknown') expect(r.suggestion.name).toBe("MC's House");
    });

    it('bare-pin dialect end-to-end: known place + new feature (the user-reported case)', () => {
        const town = entry({ id: 'loc_town', name: 'Town of Beginning', features: ['Market Square'] });
        const r = resolveLocationHeader(
            '📍 Town of Beginning - Back Alley\n\nThe alley reeks of fish.',
            [town],
            'loc_town',
        );
        expect(r).toEqual({ kind: 'resolved', placeId: 'loc_town', feature: 'Back Alley', appendFeature: true });
    });

    it('bare-pin dialect: known feature updates currentFeature without append', () => {
        const town = entry({ id: 'loc_town', name: 'Town of Beginning', features: ['Market Square'] });
        const r = resolveLocationHeader('📍 Town of Beginning - Market Square', [town], null);
        expect(r).toEqual({ kind: 'resolved', placeId: 'loc_town', feature: 'Market Square', appendFeature: false });
    });
});
