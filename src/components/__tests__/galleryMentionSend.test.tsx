/* eslint-disable @typescript-eslint/no-explicit-any */
// Regression: "send cat pic" showed the suggestion chip, then sent the message
// without the image, and the GM answered a question about a picture it had
// never been given. A visible suggestion is a STANDING offer — pressing Enter
// accepts it, it does not expire.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef } from 'react';
import type { ChatMessage, GalleryEntry, ArmedGalleryRecall } from '../../types';

let armed: ArmedGalleryRecall[] | null;
let uploads: GalleryEntry[];
const setArmedGalleryRecall = vi.fn((next: ArmedGalleryRecall[] | null) => {
    armed = next && next.length ? next : null;
});

vi.mock('../../store/useAppStore', () => {
    const state = {
        messages: [] as ChatMessage[],
        get context() { return { galleryUploads: uploads }; },
        get armedGalleryRecall() { return armed; },
        setArmedGalleryRecall: (n: any) => setArmedGalleryRecall(n),
    };
    const useAppStore = (selector: (s: any) => unknown) => selector(state);
    useAppStore.getState = () => state;
    return { useAppStore };
});

import { useGalleryMention } from '../hooks/useGalleryMention';

// The player's real gallery at the time of the bug.
const CAT: GalleryEntry = {
    id: 'cat', source: 'uploaded', title: 'Cat Pic', imageUrl: '/cat.png',
    caption: 'An anthropomorphic orange tabby cat dressed as a businessman.', createdAt: 3,
};

function setup(input: string) {
    return renderHook(() => {
        const inputRef = useRef<HTMLTextAreaElement>(null);
        return useGalleryMention({ input, setInput: vi.fn(), inputRef });
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    armed = null;
    uploads = [CAT];
});

describe('sending with a live suggestion', () => {
    it('offers Cat Pic for "send cat pic" — the message that regressed', () => {
        const { result } = setup('send cat pic');
        expect(result.current.suggestions.map(e => e.title)).toEqual(['Cat Pic']);
    });

    it('arms the standing offer when the player sends', () => {
        const { result } = setup('send cat pic');
        act(() => { result.current.armPendingSuggestions(); });
        expect(armed).toEqual([
            { id: 'cat', title: 'Cat Pic', caption: CAT.caption },
        ]);
    });

    it('does nothing when there is no suggestion', () => {
        const { result } = setup('I draw my sword and advance');
        act(() => { result.current.armPendingSuggestions(); });
        expect(setArmedGalleryRecall).not.toHaveBeenCalled();
        expect(armed).toBeNull();
    });

    it('respects a dismissal — dismissing then sending must NOT arm it', () => {
        const { result } = setup('send cat pic');
        act(() => { result.current.dismissSuggestion('cat'); });
        expect(result.current.suggestions).toEqual([]);
        act(() => { result.current.armPendingSuggestions(); });
        expect(armed).toBeNull();
    });

    it('does not double-arm something already armed', () => {
        armed = [{ id: 'cat', title: 'Cat Pic', caption: CAT.caption }];
        const { result } = setup('send cat pic');
        act(() => { result.current.armPendingSuggestions(); });
        expect(setArmedGalleryRecall).not.toHaveBeenCalled();
        expect(armed).toHaveLength(1);
    });

    it('never arms an entry with no caption — there is nothing to hand over', () => {
        uploads = [{ ...CAT, caption: '' }];
        const { result } = setup('send cat pic');
        act(() => { result.current.armPendingSuggestions(); });
        expect(armed).toBeNull();
    });
});
