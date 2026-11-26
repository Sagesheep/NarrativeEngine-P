import { describe, it, expect } from 'vitest';
import { resolveGalleryRecall } from '../galleryIndex';
import type { GalleryEntry } from '../../../types';

const entry: GalleryEntry = {
    id: 'coat', source: 'uploaded', title: 'Detective coat', imageUrl: '/coat.png',
    caption: 'An oilcloth coat.', createdAt: 1, autoInjectKeyword: 'red cloak',
};

describe('gallery keyword recall', () => {
    it.each(['I wear the RED CLOAK.', 'red   cloak', 'A red\ncloak!'])('matches phrases without @: %s', text => {
        expect(resolveGalleryRecall(text, [entry], null)).toEqual([
            { id: entry.id, title: entry.title, caption: entry.caption },
        ]);
    });
    it.each(['red cloaks', 'tattered cloak', 'infrared cloak', ''])('ignores non-matching input: %s', text => {
        expect(resolveGalleryRecall(text, [entry], null)).toBeNull();
    });
    it('does not match keywords within words', () => {
        const key = { ...entry, autoInjectKeyword: 'key' };
        expect(resolveGalleryRecall('monkey keys keyhole', [key], null)).toBeNull();
        expect(resolveGalleryRecall('monkey, then a KEY!', [key], null)).toHaveLength(1);
    });
    it('matches Unicode words and literal regex punctuation', () => {
        expect(resolveGalleryRecall('ÉPÉE!', [{ ...entry, autoInjectKeyword: 'épée' }], null)).toHaveLength(1);
        expect(resolveGalleryRecall('Use C++.', [{ ...entry, autoInjectKeyword: 'C++' }], null)).toHaveLength(1);
    });
    it('ignores legacy, disabled and undescribed entries', () => {
        for (const patch of [{ autoInjectKeyword: undefined }, { autoInjectKeyword: '  ' }, { caption: '  ' }]) {
            expect(resolveGalleryRecall('red cloak', [{ ...entry, ...patch }], null)).toBeNull();
        }
    });
    it('merges matching images with manual recalls once per id', () => {
        const second = { ...entry, id: 'second', source: 'generated' as const };
        const manual = { id: entry.id, title: entry.title, caption: entry.caption };
        const other = { id: 'other', title: 'Other', caption: 'A hat.' };
        expect(resolveGalleryRecall('red cloak, red cloak', [entry, second], [manual, other, manual])).toEqual([
            manual, other, { id: second.id, title: second.title, caption: second.caption },
        ]);
    });
    it('does not mutate settings or keep a recall armed for unrelated later input', () => {
        resolveGalleryRecall('red cloak', [entry], null);
        expect(resolveGalleryRecall('I walk away.', [entry], null)).toBeNull();
        expect(entry.autoInjectKeyword).toBe('red cloak');
    });
});
