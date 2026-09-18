import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageMarkdown } from '../message/MessageMarkdown';
import { useAppStore } from '../../store/useAppStore';
import type { LocationEntry, NPCEntry } from '../../types';

const harbor: LocationEntry = { id: 'harbor', name: 'Old Harbor', aliases: 'the docks', image: '/assets/harbor.png', description: 'Broken piers under red cliffs.', broadLocation: 'Coast', features: [], connections: [], firstSeenScene: '1', lastSeenScene: '1', source: 'manual' };
describe('location name previews', () => {
    beforeEach(() => useAppStore.setState({ locationLedger: [harbor], npcLedger: [] }));
    afterEach(() => { cleanup(); useAppStore.setState({ locationLedger: [], npcLedger: [] }); });
    it('matches full names and aliases and includes the saved description', () => {
        render(<MessageMarkdown content="We enter Old Harbor, also called the docks." />);
        expect(screen.getAllByAltText('Old Harbor')).toHaveLength(2);
        expect(screen.getAllByText(harbor.description)).toHaveLength(2);
        expect(screen.getAllByAltText('Old Harbor')[0].closest('[tabindex]')).toHaveAttribute('tabindex', '0');
    });
    it('does not turn partial names, code, or existing links into previews', () => {
        render(<MessageMarkdown content={'Old walls. Old Harbors. \x60Old Harbor\x60. [Old Harbor](https://example.com).'} />);
        expect(screen.queryByAltText('Old Harbor')).not.toBeInTheDocument();
        expect(screen.getByRole('link')).toHaveAttribute('href', 'https://example.com');
    });
    it('keeps NPC previews and matches longer location names before NPC first names', () => {
        useAppStore.setState({ npcLedger: [{ id: 'old', name: 'Old Sailor', portrait: '/assets/sailor.png' } as NPCEntry] });
        render(<MessageMarkdown content="Old Sailor enters Old Harbor." />);
        expect(screen.getByAltText('Old Sailor')).toHaveAttribute('src', '/assets/sailor.png');
        expect(screen.getByAltText('Old Harbor')).toHaveAttribute('src', '/assets/harbor.png');
    });
    it('leaves names without pictures as ordinary prose', () => {
        useAppStore.setState({ locationLedger: [{ ...harbor, image: undefined }] });
        render(<MessageMarkdown content="Old Harbor" />);
        expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });
});
