import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageMarkdown } from '../message/MessageMarkdown';
import { useAppStore } from '../../store/useAppStore';
import type { LocationEntry, NPCEntry } from '../../types';

const harbor: LocationEntry = { id: 'harbor', name: 'Old Harbor', aliases: 'the docks', image: '/assets/harbor.png', description: 'Broken piers under red cliffs.', broadLocation: 'Coast', features: [], connections: [], firstSeenScene: '1', lastSeenScene: '1', source: 'manual' };
describe('location name previews', () => {
    beforeEach(() => useAppStore.setState({ locationLedger: [harbor], npcLedger: [], context: { ...useAppStore.getState().context, glossary: [] } }));
    afterEach(() => { cleanup(); useAppStore.setState({ locationLedger: [], npcLedger: [] }); });
    it('matches full names and aliases and includes the saved description', () => {
        render(<MessageMarkdown content="We enter Old Harbor, also called the docks." />);
        const names = screen.getAllByRole('button');
        expect(names).toHaveLength(2);
        fireEvent.mouseEnter(names[0]);
        expect(screen.getByAltText('Old Harbor')).toBeInTheDocument();
        expect(screen.getByText(harbor.description)).toBeInTheDocument();
        expect(names[0]).toHaveAttribute('tabindex', '0');
        fireEvent.mouseLeave(names[0]);
        fireEvent.mouseEnter(names[1]);
        expect(screen.getByText(harbor.description)).toBeInTheDocument();
    });
    it('does not turn partial names, code, or existing links into previews', () => {
        render(<MessageMarkdown content={'Old walls. Old Harbors. \x60Old Harbor\x60. [Old Harbor](https://example.com).'} />);
        expect(screen.queryByAltText('Old Harbor')).not.toBeInTheDocument();
        expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com');
    });
    it('keeps NPC previews and matches longer location names before NPC first names', () => {
        useAppStore.setState({ npcLedger: [{ id: 'old', name: 'Old Sailor', portrait: '/assets/sailor.png' } as NPCEntry] });
        render(<MessageMarkdown content="Old Sailor enters Old Harbor." />);
        fireEvent.mouseEnter(screen.getByRole('button', { name: 'Old Sailor' }));
        expect(screen.getByAltText('Old Sailor')).toHaveAttribute('src', '/assets/sailor.png');
        fireEvent.mouseLeave(screen.getByRole('button', { name: 'Old Sailor' }));
        fireEvent.mouseEnter(screen.getByRole('button', { name: 'Old Harbor' }));
        expect(screen.getByAltText('Old Harbor')).toHaveAttribute('src', '/assets/harbor.png');
    });
    it('previews text-only places without requiring a picture', () => {
        useAppStore.setState({ locationLedger: [{ ...harbor, image: undefined }] });
        render(<MessageMarkdown content="Old Harbor" />);
        fireEvent.focus(screen.getByRole('button', { name: 'Old Harbor' }));
        expect(screen.getByText(harbor.description)).toBeInTheDocument();
        expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });
    it('keeps bracketed NPC names bold without displaying their brackets', () => {
        const { container } = render(<MessageMarkdown content="[Old Harbor] and [**Old Harbor**]" />);
        expect(container.textContent).toBe('Old Harbor and Old Harbor');
        expect(container.querySelectorAll('strong')).toHaveLength(2);
        expect(screen.getAllByRole('button')).toHaveLength(2);
    });
});

describe('glossary previews', () => {
    const entry = { id: 'house / one', name: 'House Veyran', aliases: 'the Veyrans', description: 'A noble family controlling the northern salt trade.', category: 'Family' };
    beforeEach(() => useAppStore.setState({ npcLedger: [], locationLedger: [], context: { ...useAppStore.getState().context, glossary: [entry] } }));
    afterEach(() => { cleanup(); useAppStore.setState({ context: { ...useAppStore.getState().context, glossary: [] } }); });

    it('matches full names and explicit aliases case-insensitively, without expanding component words', () => {
        render(<MessageMarkdown content="HOUSE VEYRAN meets the Veyrans in a house." />);
        expect(screen.getAllByRole('button')).toHaveLength(2);
        fireEvent.mouseEnter(screen.getByRole('button', { name: 'the Veyrans' }));
        expect(screen.getByRole('tooltip')).toHaveTextContent(entry.description);
        expect(screen.getByRole('tooltip')).toHaveTextContent('Family');
    });

    it('supports keyboard focus, escape, tapping, and outside dismissal', () => {
        render(<MessageMarkdown content="House Veyran" />);
        const trigger = screen.getByRole('button');
        fireEvent.focus(trigger);
        expect(screen.getByRole('tooltip')).toHaveTextContent(entry.description);
        fireEvent.keyDown(trigger, { key: 'Escape' });
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        fireEvent.click(trigger);
        fireEvent.mouseLeave(trigger);
        expect(screen.getByRole('tooltip')).toBeInTheDocument();
        fireEvent.pointerDown(document.body);
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    });

    it('preserves code fences, links, image alt text, reference links, and autolinks', () => {
        render(<MessageMarkdown content={'`House Veyran`\n\n~~~\nHouse Veyran\n~~~\n\n[House Veyran](https://example.com)\n\n![House Veyran](/test.png)\n\n[House Veyran][ref]\n\n[ref]: https://example.org\n\nhttps://example.com/House'} />);
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(screen.getAllByRole('link')).toHaveLength(3);
        expect(screen.getByAltText('House Veyran')).toHaveAttribute('src', '/test.png');
    });

    it('uses Unicode word boundaries and prefers longer phrases', () => {
        useAppStore.setState({ context: { ...useAppStore.getState().context, glossary: [entry, { ...entry, id: 'queen', name: 'Éléonore', aliases: '' }, { ...entry, id: 'house', name: 'House', aliases: '' }] } });
        render(<MessageMarkdown content="House Veyran knows ÉLÉONORE, but not Éléonores or préÉléonore." />);
        expect(screen.getAllByRole('button').map(item => item.textContent)).toEqual(['House Veyran', 'ÉLÉONORE']);
    });

    it('leaves ambiguous aliases and secret places unlinked', () => {
        useAppStore.setState({ locationLedger: [{ ...harbor, knowledge: 'secret' }], context: { ...useAppStore.getState().context, glossary: [entry, { ...entry, id: 'other', name: 'Other house' }] } });
        render(<MessageMarkdown content="the Veyrans meet at Old Harbor." />);
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('updates existing messages when glossary entries are edited or removed', () => {
        render(<MessageMarkdown content="House Veyran" />);
        act(() => useAppStore.setState({ context: { ...useAppStore.getState().context, glossary: [{ ...entry, description: 'Updated reminder.' }] } }));
        fireEvent.mouseEnter(screen.getByRole('button'));
        expect(screen.getByRole('tooltip')).toHaveTextContent('Updated reminder.');
        act(() => useAppStore.setState({ context: { ...useAppStore.getState().context, glossary: [] } }));
        expect(screen.queryByRole('button')).not.toBeInTheDocument();
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
        expect(screen.getByText('House Veyran')).toBeInTheDocument();
    });
});
