import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { GlossaryTab } from '../context-drawer/GlossaryTab';
import { ContextNavigationDrawer } from '../ContextNavigationDrawer';
import { useAppStore } from '../../store/useAppStore';
import { migrateLegacyContext } from '../../types';

beforeEach(() => useAppStore.setState({ activeCampaignId: null, context: migrateLegacyContext({}), contextScreen: null, glossaryDraftName: null, drawerOpen: true }));
afterEach(() => { cleanup(); useAppStore.setState({ contextScreen: null, context: migrateLegacyContext({}) }); });

it('creates, edits, searches, and deletes a campaign glossary entry', () => {
    render(<GlossaryTab />);
    fireEvent.click(screen.getByRole('button', { name: 'New entry' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'House Veyran' } });
    fireEvent.change(screen.getByLabelText('Aliases (comma-separated)'), { target: { value: 'the Veyrans' } });
    fireEvent.change(screen.getByLabelText('Short description'), { target: { value: 'A salt-trading noble family.' } });
    fireEvent.change(screen.getByLabelText('Category (optional)'), { target: { value: 'Family' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }));
    expect(useAppStore.getState().context.glossary).toEqual([expect.objectContaining({ name: 'House Veyran', aliases: 'the Veyrans', description: 'A salt-trading noble family.', category: 'Family' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit House Veyran' }));
    fireEvent.change(screen.getByLabelText('Short description'), { target: { value: 'Now controls the harbor.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save entry' }));
    expect(screen.getByText('Now controls the harbor.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search glossary'), { target: { value: 'missing' } });
    expect(screen.getByText('No matching terms.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search glossary'), { target: { value: 'Veyrans' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete House Veyran' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    expect(useAppStore.getState().context.glossary).toEqual([]);
});

it('opens from World navigation and can prefill selected text without saving it', () => {
    render(<ContextNavigationDrawer />);
    fireEvent.click(screen.getByRole('button', { name: /^Glossary/ }));
    expect(screen.getByRole('dialog', { name: 'Glossary' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Glossary' }));
    act(() => useAppStore.getState().openGlossary('Order of Ash'));
    // The selected term opens an unsaved draft, not an automatic new entry.
    expect(useAppStore.getState().glossaryDraftName).toBe('Order of Ash');
    expect(screen.getByLabelText('Name')).toHaveValue('Order of Ash');
    expect(useAppStore.getState().context.glossary).toBeUndefined();
});

it('prefills a draft, allows longer descriptions, and cancel leaves the campaign untouched', () => {
    render(<GlossaryTab initialName="Order of Ash" />);
    expect(screen.getByLabelText('Name')).toHaveValue('Order of Ash');
    fireEvent.change(screen.getByLabelText('Short description'), { target: { value: 'A longer reminder. '.repeat(20) } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useAppStore.getState().context.glossary).toBeUndefined();
});
