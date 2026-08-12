import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextNavigationDrawer } from '../ContextNavigationDrawer';
import { useAppStore } from '../../store/useAppStore';

afterEach(() => {
    cleanup();
    useAppStore.setState({ drawerOpen: true, contextScreen: null });
});

describe('ContextNavigationDrawer', () => {
    it('renders grouped vertical navigation and opens a context screen from store state', () => {
        render(<ContextNavigationDrawer />);

        expect(screen.getByRole('navigation', { name: 'Context navigation' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'System Context' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Backups' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'System Context' }));

        expect(useAppStore.getState().contextScreen).toBe('sys');
        expect(screen.getByRole('dialog', { name: 'System Context' })).toBeInTheDocument();
    });

    it('can collapse a group without changing the selected screen', () => {
        render(<ContextNavigationDrawer />);
        fireEvent.click(screen.getByRole('button', { name: 'Story' }));

        expect(screen.queryByRole('button', { name: 'System Context' })).toBeNull();
        expect(screen.getByRole('button', { name: /^NPCs/ })).toBeInTheDocument();
    });
});
