import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CombatAllocationHint, StartCombatButton } from '../StartCombatButton';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { migrateLegacyContext } from '../../../types';
import type { CombatSheet, GameContext } from '../../../types';

const sheet = (needsAllocation: boolean): CombatSheet => ({
    abilities: { STR: 8, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8 }, budget: 'NORMAL', level: 1, needsAllocation,
});

function setCombat(patch: Partial<GameContext>) {
    useAppStore.setState({ context: { ...migrateLegacyContext({}), ...patch }, combatSession: null, combatProposal: null, pcPanelOpen: false });
}

function composerRow() {
    return render(<><CombatAllocationHint variant="notice" /><StartCombatButton isStreaming={false} /></>);
}

describe('combat allocation notice above the composer', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    });

    afterEach(() => {
        cancelPendingSaves();
        vi.unstubAllGlobals();
    });

    it('shows the notice instead of Start combat while ability points are pending', () => {
        setCombat({ combatModeActive: true, combatSheet: sheet(true) });
        composerRow();
        expect(screen.getByTestId('combat-alloc-hint')).toHaveTextContent("Combat is on, but your ability points aren't distributed yet.");
        expect(screen.queryByTestId('start-combat-button')).toBeNull();
    });

    it('treats a missing sheet as pending', () => {
        setCombat({ combatModeActive: true, combatSheet: undefined });
        composerRow();
        expect(screen.getByTestId('combat-alloc-hint')).toBeInTheDocument();
    });

    it('hides the notice once points are distributed and offers the Start combat icon button', () => {
        setCombat({ combatModeActive: true, combatSheet: sheet(false) });
        composerRow();
        expect(screen.queryByTestId('combat-alloc-hint')).toBeNull();
        const button = screen.getByRole('button', { name: 'Start combat' });
        expect(button).toHaveAttribute('data-testid', 'start-combat-button');
        expect(button).toHaveAttribute('title', 'Start an engine-run fight from the current scene');
    });

    it('renders nothing while combat is off', () => {
        setCombat({ combatModeActive: false, combatSheet: sheet(true) });
        const { container } = composerRow();
        expect(container).toBeEmptyDOMElement();
    });

    it('hides the button while a proposal or a session exists', () => {
        setCombat({ combatModeActive: true, combatSheet: sheet(false) });
        useAppStore.setState({ combatProposal: { id: 'p', messageId: 'm', combatants: [], reason: '', source: 'manual' } });
        const { container, rerender } = render(<StartCombatButton isStreaming={false} />);
        expect(container).toBeEmptyDOMElement();
        useAppStore.setState({ combatProposal: null, combatSession: { state: { outcome: null } } as never });
        rerender(<StartCombatButton isStreaming={false} />);
        expect(container).toBeEmptyDOMElement();
        useAppStore.setState({ combatSession: null });
    });

    it('opens the character sheet from the notice', () => {
        setCombat({ combatModeActive: true, combatSheet: sheet(true) });
        composerRow();
        fireEvent.click(screen.getByRole('button', { name: 'Open character sheet' }));
        expect(useAppStore.getState().pcPanelOpen).toBe(true);
    });
});
