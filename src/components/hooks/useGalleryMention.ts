import { useState, useMemo, useCallback, useEffect, useRef, type RefObject } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { buildGallery } from '../../services/gallery/galleryIndex';
import {
    parseMentionQuery, matchEntries, stripMention, suggestFromText, type MentionQuery,
} from '../../services/gallery/galleryMention';
import type { GalleryEntry } from '../../types';

/**
 * Composer-side gallery invocation: the `@` picker and the suggestion offer.
 *
 * Both are local string work over entries already in memory. Neither adds a
 * retrieval pass to the turn, and neither puts anything in the payload — they
 * only ever call `setArmedGalleryRecall`, which the player can undo before
 * sending. The whole point of choosing this over keyword auto-injection is
 * that the cost stays visible and deliberate.
 */
export function useGalleryMention({
    input,
    setInput,
    inputRef,
}: {
    input: string;
    setInput: (v: string) => void;
    inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
    const messages = useAppStore(s => s.messages);
    const uploads = useAppStore(s => s.context.galleryUploads);
    const armedRecall = useAppStore(s => s.armedGalleryRecall);
    const setArmedGalleryRecall = useAppStore(s => s.setArmedGalleryRecall);

    const [mention, setMention] = useState<MentionQuery | null>(null);
    const [activeIndex, setActiveIndex] = useState(0);
    const [dismissed, setDismissed] = useState<Set<string>>(new Set());
    // Where to put the caret after a pick rewrote the text. A ref, not state:
    // the restore is a DOM side effect, and routing it through setState would
    // mean a setState inside an effect and an extra render for nothing.
    const pendingCaretRef = useRef<number | null>(null);

    const entries = useMemo(() => buildGallery(messages, uploads), [messages, uploads]);
    const armedIds = useMemo(() => new Set((armedRecall ?? []).map(a => a.id)), [armedRecall]);

    const matches = useMemo(
        () => (mention ? matchEntries(entries, mention.query) : []),
        [mention, entries],
    );

    const suggestions = useMemo(
        () => (mention ? [] : suggestFromText(input, entries, { dismissed, armed: armedIds })),
        [mention, input, entries, dismissed, armedIds],
    );

    /** Re-read the caret and recompute whether an `@` token is active. */
    const syncFromTextarea = useCallback(() => {
        const el = inputRef.current;
        if (!el) return;
        const next = parseMentionQuery(el.value, el.selectionStart ?? 0);
        setMention(next);
        setActiveIndex(0);
    }, [inputRef]);

    // The pick rewrote `input`; once that render lands, put the caret back where
    // the token used to be so typing continues from the right place.
    useEffect(() => {
        const caret = pendingCaretRef.current;
        if (caret === null) return;
        pendingCaretRef.current = null;
        const el = inputRef.current;
        if (el) {
            el.focus();
            el.setSelectionRange(caret, caret);
        }
    }, [input, inputRef]);

    const arm = useCallback((entry: GalleryEntry) => {
        if (!entry.caption.trim()) return;
        const current = useAppStore.getState().armedGalleryRecall ?? [];
        if (current.some(a => a.id === entry.id)) return;
        setArmedGalleryRecall([...current, { id: entry.id, title: entry.title, caption: entry.caption }]);
    }, [setArmedGalleryRecall]);

    const unarm = useCallback((id: string) => {
        const current = useAppStore.getState().armedGalleryRecall ?? [];
        setArmedGalleryRecall(current.filter(a => a.id !== id));
    }, [setArmedGalleryRecall]);

    /** Pick a match: arm it and delete the `@…` token from the message. */
    const pick = useCallback((entry: GalleryEntry) => {
        arm(entry);
        if (mention) {
            const { text, caret } = stripMention(input, mention);
            setInput(text);
            pendingCaretRef.current = caret;
        }
        setMention(null);
    }, [arm, mention, input, setInput]);

    const dismissSuggestion = useCallback((id: string) => {
        setDismissed(prev => new Set(prev).add(id));
    }, []);

    const resetSuggestions = useCallback(() => setDismissed(new Set()), []);

    /**
     * Keyboard for the open picker. Returns true when the event was consumed,
     * so the composer knows not to send on Enter.
     */
    const handleKeyDown = useCallback((e: React.KeyboardEvent): boolean => {
        if (!mention || matches.length === 0) return false;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex(i => (i + 1) % matches.length);
            return true;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex(i => (i - 1 + matches.length) % matches.length);
            return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            pick(matches[activeIndex] ?? matches[0]);
            return true;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            setMention(null);
            return true;
        }
        return false;
    }, [mention, matches, activeIndex, pick]);

    return {
        /** Entries matching the open `@` token. Empty when the picker is closed. */
        matches,
        activeIndex,
        setActiveIndex,
        pickerOpen: !!mention && matches.length > 0,
        /** Entries whose name the player just typed, offered but never injected. */
        suggestions,
        armed: armedRecall ?? [],
        syncFromTextarea,
        handleKeyDown,
        pick,
        arm,
        unarm,
        dismissSuggestion,
        /** Called on send: a dismissal applies to the message it was made on,
         *  not to the rest of the session. */
        resetSuggestions,
    };
}
