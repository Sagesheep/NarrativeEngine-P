import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MessageMarkdown, escapeLinkDefinitions } from '../MessageMarkdown';
import { useAppStore } from '../../../store/useAppStore';

afterEach(() => {
    cleanup();
    useAppStore.setState({ npcLedger: [], locationLedger: [] });
});

describe('speaker lines shaped like link definitions', () => {
    it('renders [**Name**]: "line." instead of hiding it', () => {
        useAppStore.setState({ npcLedger: [], locationLedger: [] });
        const c = render(<MessageMarkdown content={'Before.\n\n[**Marlow**]: "Brant."\n\nAfter.'} />).container;
        expect(c.textContent).toContain('Marlow');
        expect(c.textContent).toContain('"Brant."');
        expect(c.textContent).not.toContain('\\');
    });

    it('renders plain [Name]: "line." too', () => {
        const c = render(<MessageMarkdown content={'[Marlow]: "Brant."'} />).container;
        expect(c.textContent).toContain('Brant.');
    });

    it('leaves fenced code and ordinary text alone', () => {
        const code = '```\n[a]: b\n```';
        expect(escapeLinkDefinitions(code)).toBe(code);
        expect(escapeLinkDefinitions('She said [softly]: no.')).toBe('She said [softly]: no.');
        expect(escapeLinkDefinitions('[a]: b')).toBe('\\[a]: b');
        expect(escapeLinkDefinitions('> [a]: b')).toBe('> \\[a]: b');
    });
});
