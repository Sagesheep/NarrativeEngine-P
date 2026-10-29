import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../../store/useAppStore';
import { cancelPendingSaves } from '../../store/slices/campaignSlice';
import { migrateLegacyContext, type PromptInjection } from '../../types';
import { ContextNavigationDrawer } from '../ContextNavigationDrawer';
import { InjectionModifierPanel } from '../injections/InjectionModifierPanel';

const initialState = useAppStore.getState();
const injection: PromptInjection = {
    id: 'a', name: 'Campaign A reminder', content: 'Only in A', enabled: true,
    role: 'system', depth: 1, mode: 'message', triggers: ['reply'],
};
beforeEach(() => {
    useAppStore.setState({
        activeCampaignId: 'a', context: migrateLegacyContext({ promptInjections: [injection] }),
        drawerOpen: true, injectionModifierOpen: false,
    });
});
afterEach(() => {
    cleanup();
    cancelPendingSaves();
    useAppStore.setState(initialState);
});

describe('campaign Injection Modifier', () => {
    it('opens from the Gallery sidebar, toggles immediately, and edits campaign context', () => {
        render(<><ContextNavigationDrawer /><InjectionModifierPanel /></>);
        const nav = screen.getByRole('navigation', { name: 'Context navigation' });
        expect(within(nav).getByRole('button', { name: 'Gallery' })).toBeInTheDocument();
        expect(within(nav).getByRole('button', { name: /Injection Modifier/ })).toHaveTextContent('1');
        fireEvent.click(within(nav).getByRole('switch', { name: 'Enable Campaign A reminder' }));
        expect(useAppStore.getState().context.promptInjections?.[0].enabled).toBe(false);
        fireEvent.click(within(nav).getByRole('button', { name: 'Edit injections' }));
        const panel = screen.getByRole('complementary', { name: 'Injection Modifier' });
        fireEvent.change(within(panel).getByLabelText('Injection content'), { target: { value: 'Edited in campaign A' } });
        expect(useAppStore.getState().context.promptInjections?.[0].content).toBe('Edited in campaign A');
        expect(useAppStore.getState().settings).toBe(initialState.settings);
        fireEvent.click(within(panel).getByRole('button', { name: 'Close Injection Modifier' }));
        expect(screen.queryByRole('complementary', { name: 'Injection Modifier' })).toBeNull();
    });

    it('resets selection and undo when switching campaigns without leaking old cards', () => {
        useAppStore.setState({ injectionModifierOpen: true });
        render(<InjectionModifierPanel />);
        fireEvent.click(screen.getByRole('button', { name: 'Delete injection' }));
        expect(screen.getByRole('button', { name: 'Undo delete' })).toBeInTheDocument();
        act(() => useAppStore.setState({ activeCampaignId: 'b', context: migrateLegacyContext({ promptInjections: [{ ...injection, id: 'b', name: 'Campaign B reminder', content: 'Only in B' }] }) }));
        expect(screen.queryByRole('button', { name: 'Undo delete' })).toBeNull();
        expect(screen.getByLabelText('Injection content')).toHaveValue('Only in B');
        act(() => useAppStore.setState({ activeCampaignId: 'c', context: migrateLegacyContext({}) }));
        expect(screen.queryByLabelText('Injection content')).toBeNull();
        expect(screen.getByRole('button', { name: 'Create your first injection' })).toBeInTheDocument();
    });
});
