import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CombatSettingsSection } from '../CombatSettingsSection';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { DEFAULT_COMBAT_CONFIG, migrateLegacyContext } from '../../../types';

function Harness() {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    return <CombatSettingsSection context={context} updateContext={updateContext} />;
}

describe('CombatSettingsSection', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
        const context = migrateLegacyContext({
            characterProfileData: {
                name: 'Ari', race: '', class: '', level: 1, hp: { current: 20, max: 20 },
                stats: { STR: 17 }, skills: [], abilities: [], traits: [], notes: '',
            },
        });
        useAppStore.setState({ context, characterProfileData: context.characterProfileData, activeCampaignId: null });
    });

    afterEach(() => {
        cancelPendingSaves();
        vi.unstubAllGlobals();
    });

    it('hides the settings while combat is off', () => {
        render(<Harness />);
        expect(screen.getByRole('button', { name: 'Toggle combat' })).toHaveAttribute('aria-pressed', 'false');
        expect(screen.queryByLabelText('Party control')).toBeNull();
    });

    it('turning combat on creates a default sheet that needs allocation and mirrors it', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        const s = useAppStore.getState();
        expect(s.context.combatModeActive).toBe(true);
        expect(s.context.combatSheet).toMatchObject({ needsAllocation: true, budget: 'NORMAL' });
        expect(s.characterProfileData.stats.STR).toBe(8);
        expect(screen.getByLabelText('Party control')).toHaveValue('engine');
    });

    it('turning combat off keeps the sheet', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        const sheet = useAppStore.getState().context.combatSheet;
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        expect(useAppStore.getState().context.combatModeActive).toBe(false);
        expect(useAppStore.getState().context.combatSheet).toEqual(sheet);
    });

    it('writes normalized settings', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        fireEvent.change(screen.getByLabelText('Defeat'), { target: { value: 'ironman' } });
        fireEvent.change(screen.getByLabelText('Narration'), { target: { value: 'round' } });
        fireEvent.click(screen.getByLabelText('Ask before a fight starts'));
        expect(useAppStore.getState().context.combatConfig).toEqual({
            ...DEFAULT_COMBAT_CONFIG, defeatMode: 'ironman', narrationCadence: 'round', confirmStart: false,
        });
    });

    it('shows the narration length beside the cadence, defaulting to standard, and saves it', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        const length = screen.getByLabelText('Narration length');
        expect(length).toHaveValue('standard');
        expect(Array.from((length as HTMLSelectElement).options).map(o => o.value)).toEqual(['brief', 'standard', 'rich']);
        fireEvent.change(length, { target: { value: 'rich' } });
        expect(useAppStore.getState().context.combatConfig).toEqual({ ...DEFAULT_COMBAT_CONFIG, narrationLength: 'rich' });
        expect(screen.getByLabelText('Narration length')).toHaveValue('rich');
    });

    it('explains that ability points are pending while combat is on, and opens the character sheet', () => {
        useAppStore.setState({ pcPanelOpen: false });
        render(<Harness />);
        expect(screen.queryByTestId('combat-alloc-note')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        expect(screen.getByTestId('combat-alloc-note')).toHaveTextContent("Combat is on, but your ability points aren't distributed yet.");
        fireEvent.click(screen.getByRole('button', { name: 'Open character sheet' }));
        expect(useAppStore.getState().pcPanelOpen).toBe(true);
    });

    it('shows no allocation note once the points are distributed', () => {
        render(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'Toggle combat' }));
        const sheet = useAppStore.getState().context.combatSheet!;
        act(() => useAppStore.getState().updateContext({ combatSheet: { ...sheet, needsAllocation: false } }));
        expect(screen.queryByTestId('combat-alloc-note')).toBeNull();
    });
});
