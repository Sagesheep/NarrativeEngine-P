import { describe, it, expect } from 'vitest';
import { locateRawSpan } from '../slices/chatSlice';
import { useAppStore } from '../useAppStore';
import type { ChatMessage } from '../../types';

describe('WO-J: locateRawSpan', () => {
    it('finds an exact literal span', () => {
        const span = locateRawSpan('hello world', 'world');
        expect(span).toEqual({ start: 6, end: 11 });
    });

    it('returns null when the target is absent', () => {
        expect(locateRawSpan('hello', 'missing')).toBeNull();
    });

    it('returns null for empty target', () => {
        expect(locateRawSpan('hello', '')).toBeNull();
    });

    it('locates a span across markdown markers (bold/brackets)', () => {
        const raw = 'The knight [**Aldric**] rode forth.';
        const span = locateRawSpan(raw, 'Aldric');
        expect(span).not.toBeNull();
        // The spliced region should cover the inner text + hug the surrounding markers.
        expect(raw.slice(span!.start, span!.end)).toContain('Aldric');
    });

    it('locates a span with collapsed whitespace', () => {
        const raw = 'The  quick    brown fox';
        const span = locateRawSpan(raw, 'quick brown');
        expect(span).not.toBeNull();
        // Splicing should remove the raw region covering the matched text.
        const before = raw.slice(0, span!.start);
        const after = raw.slice(span!.end);
        expect((before + after)).not.toContain('quick    brown');
    });

    it('prefers the exact match when available', () => {
        const raw = 'Aldric';
        const span = locateRawSpan(raw, 'Aldric');
        expect(span).toEqual({ start: 0, end: 6 });
    });
});

describe('WO-J: renameFirstNameInLatestAssistant', () => {
    function seed(messages: { id: string; role: string; content: string; displayContent?: string }[]) {
        const seeded = messages.map(m => ({
            id: m.id,
            role: m.role as ChatMessage['role'],
            content: m.content,
            displayContent: m.displayContent ?? m.content,
            timestamp: 0,
        })) as ChatMessage[];
        useAppStore.setState({ messages: seeded, activeCampaignId: 'test' } as Partial<ReturnType<typeof useAppStore.getState>>);
    }

    it('replaces the first name only in the last assistant message', () => {
        seed([
            { id: '1', role: 'assistant', content: 'Pell Gravatt entered the room. Pell smiled.' },
            { id: '2', role: 'user', content: 'I greet Pell.' },
            { id: '3', role: 'assistant', content: 'Pell nodded back at you.' },
        ]);
        const count = useAppStore.getState().renameFirstNameInLatestAssistant('Pell Gravatt', 'Dirk Stone');
        expect(count).toBe(1);
        const msgs = useAppStore.getState().messages;
        // Only the LAST assistant message (id 3) should be touched.
        expect(msgs[0].content).toBe('Pell Gravatt entered the room. Pell smiled.');
        expect(msgs[2].content).toBe('Dirk nodded back at you.');
    });

    it('returns 0 for a single-token from (no surname)', () => {
        seed([{ id: '1', role: 'assistant', content: 'Pell smiled.' }]);
        const count = useAppStore.getState().renameFirstNameInLatestAssistant('Pell', 'Dirk');
        expect(count).toBe(0);
    });

    it('returns 0 when there is no assistant message', () => {
        seed([{ id: '1', role: 'user', content: 'I speak.' }]);
        const count = useAppStore.getState().renameFirstNameInLatestAssistant('Pell Gravatt', 'Dirk Stone');
        expect(count).toBe(0);
    });

    it('is case-insensitive and whole-word', () => {
        seed([{ id: '1', role: 'assistant', content: 'Pellington saw pell. PELL!' }]);
        const count = useAppStore.getState().renameFirstNameInLatestAssistant('Pell Gravatt', 'Dirk Stone');
        expect(count).toBe(1);
        const msgs = useAppStore.getState().messages;
        // 'Pellington' (prefix, NOT whole-word) is untouched; 'pell' and 'PELL' are whole-word matches.
        expect(msgs[0].content).toBe('Pellington saw Dirk. Dirk!');
    });
});