import { describe, it, expect } from 'vitest';
import { parseMentionQuery, matchEntries, stripMention, suggestFromText } from '../galleryMention';
import type { GalleryEntry } from '../../../types';

function entry(over: Partial<GalleryEntry> = {}): GalleryEntry {
    return {
        id: 'g1', source: 'uploaded', title: 'Detective coat',
        imageUrl: '/a.png', caption: 'A long oilcloth coat.', createdAt: 1, ...over,
    };
}

const ENTRIES: GalleryEntry[] = [
    entry({ id: 'coat', title: 'Detective coat' }),
    entry({ id: 'trinket', title: 'Weird brass trinket' }),
    entry({ id: 'map', title: 'Harbour map' }),
    entry({ id: 'blank', title: 'Undescribed thing', caption: '' }),
];

describe('parseMentionQuery', () => {
    it('finds the token the caret sits inside', () => {
        const text = 'I show them @detec';
        expect(parseMentionQuery(text, text.length)).toEqual({ query: 'detec', start: 12, end: 18 });
    });

    it('allows spaces, because titles have them', () => {
        const text = 'I show them @Detective co';
        expect(parseMentionQuery(text, text.length)?.query).toBe('Detective co');
    });

    it('opens on a bare @', () => {
        expect(parseMentionQuery('@', 1)?.query).toBe('');
    });

    it('leaves email addresses alone', () => {
        const text = 'mail me at bob@example';
        expect(parseMentionQuery(text, text.length)).toBeNull();
    });

    it('never spans a newline', () => {
        const text = '@coat\nI walk in';
        expect(parseMentionQuery(text, text.length)).toBeNull();
    });

    it('gives up once the token runs too long', () => {
        const text = '@' + 'x'.repeat(60);
        expect(parseMentionQuery(text, text.length)).toBeNull();
    });

    it('returns null when there is no @ before the caret', () => {
        expect(parseMentionQuery('I draw my sword', 15)).toBeNull();
    });
});

describe('matchEntries', () => {
    it('ranks prefix matches above interior ones', () => {
        const out = matchEntries([entry({ id: 'a', title: 'Coat of arms' }), entry({ id: 'b', title: 'Detective coat' })], 'coat');
        expect(out[0].id).toBe('a');
    });

    it('matches case-insensitively and across spaces', () => {
        expect(matchEntries(ENTRIES, 'detective co').map(e => e.id)).toEqual(['coat']);
    });

    it('lists everything usable for a bare @', () => {
        expect(matchEntries(ENTRIES, '').map(e => e.id)).toEqual(['coat', 'trinket', 'map']);
    });

    it('never offers an image with no caption — there is nothing to hand over', () => {
        expect(matchEntries(ENTRIES, 'undescribed')).toEqual([]);
    });

    it('returns nothing when the query matches nothing, so a stray @ does not hijack', () => {
        expect(matchEntries(ENTRIES, 'zzzz')).toEqual([]);
    });

    it('honours the limit', () => {
        expect(matchEntries(ENTRIES, '', 2)).toHaveLength(2);
    });
});

describe('stripMention', () => {
    it('removes the token and leaves the prose clean', () => {
        const text = 'I show them @Detective co and wait';
        const mention = parseMentionQuery(text, 25)!;
        const out = stripMention(text, mention);
        expect(out.text).toBe('I show them and wait');
        expect(out.caret).toBe(12);
    });

    it('handles a token at the very end', () => {
        const text = 'Look at @coat';
        const out = stripMention(text, parseMentionQuery(text, text.length)!);
        expect(out.text).toBe('Look at ');
    });
});

describe('suggestFromText', () => {
    it('notices a title mentioned in the message', () => {
        expect(suggestFromText('I adjust my detective coat and step inside', ENTRIES).map(e => e.id))
            .toEqual(['coat']);
    });

    it('requires a word boundary, so "key" does not fire on "monkey"', () => {
        const keys = [entry({ id: 'key', title: 'Iron key' })];
        expect(suggestFromText('a monkey sits there', keys)).toEqual([]);
        expect(suggestFromText('I hold the iron key', keys).map(e => e.id)).toEqual(['key']);
    });

    it('does not suggest something already armed, or already dismissed', () => {
        const text = 'I adjust my detective coat';
        expect(suggestFromText(text, ENTRIES, { armed: new Set(['coat']) })).toEqual([]);
        expect(suggestFromText(text, ENTRIES, { dismissed: new Set(['coat']) })).toEqual([]);
    });

    it('ignores entries with no caption', () => {
        expect(suggestFromText('an undescribed thing sits here', ENTRIES)).toEqual([]);
    });

    it('stays quiet on a very short message', () => {
        expect(suggestFromText('go', ENTRIES)).toEqual([]);
    });

    it('caps how many it offers at once', () => {
        const many = [
            entry({ id: '1', title: 'Detective coat' }),
            entry({ id: '2', title: 'Harbour map' }),
            entry({ id: '3', title: 'Weird brass trinket' }),
        ];
        const text = 'my detective coat, the harbour map and a weird brass trinket';
        expect(suggestFromText(text, many).length).toBeLessThanOrEqual(2);
    });
});
