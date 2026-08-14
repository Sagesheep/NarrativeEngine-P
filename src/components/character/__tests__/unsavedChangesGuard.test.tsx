import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CharacterLedgerModal } from '../CharacterLedgerModal';
import { useAppStore } from '../../../store/useAppStore';
import type { PlayerCharacter } from '../../../types';

vi.mock('../../hooks/useNpcPortraits', () => ({
    useNpcPortraits: () => ({
        isGeneratingImage: false,
        populating: null,
        generateForForm: vi.fn(),
        uploadForForm: vi.fn(),
        populateAll: vi.fn(),
    }),
}));

vi.mock('../Toast', () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const mockPC: PlayerCharacter = {
    id: 'pc-1',
    name: 'Aria',
    isPC: true,
    status: 'Alive',
    tier: 'recurring',
};

describe('CharacterLedgerModal — unsaved-changes close guard', () => {
    beforeEach(() => {
        useAppStore.setState({
            playerCharacter: mockPC,
            pcPanelOpen: true,
            togglePCPanel: () => useAppStore.setState({ pcPanelOpen: !useAppStore.getState().pcPanelOpen }),
            updatePlayerCharacter: vi.fn((patch) => {
                const cur = useAppStore.getState().playerCharacter;
                if (cur) useAppStore.setState({ playerCharacter: { ...cur, ...patch } });
            }),
            setPlayerCharacter: vi.fn((pc) => useAppStore.setState({ playerCharacter: pc })),
            updateContext: vi.fn(),
            setCharacterProfileData: vi.fn(),
            context: { characterProfile: { identity: {}, activeTraits: [] } },
            characterProfileData: null,
            npcLedger: [],
            divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
            chapters: [],
        } as Partial<ReturnType<typeof useAppStore.getState>>);
    });

    it('closes immediately via the X button when the sheet has no edits', async () => {
        const user = userEvent.setup();
        render(<CharacterLedgerModal />);
        expect(screen.getByRole('dialog', { name: 'Character Ledger' })).toBeInTheDocument();
        // ScreenLightbox names its close button "Close <title>", so the screen
        // is identifiable when several are open. Was a bare "Close".
        await user.click(screen.getByLabelText('Close Character Ledger'));
        expect(useAppStore.getState().pcPanelOpen).toBe(false);
    });

    it('prompts on backdrop click when the sheet has unsaved edits, and Discard closes', async () => {
        const user = userEvent.setup();
        render(<CharacterLedgerModal />);
        // Enter edit mode and mutate a field to make the form dirty.
        await user.click(screen.getByRole('button', { name: 'Edit Character' }));
        const nameInput = screen.getByPlaceholderText("Your character's name") as HTMLInputElement;
        await user.clear(nameInput);
        await user.type(nameInput, 'Aria Renamed');
        // Backdrop click should surface the guard, not close.
        const backdrop = screen.getByRole('dialog', { name: 'Character Ledger' });
        await user.click(backdrop);
        expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
        expect(useAppStore.getState().pcPanelOpen).toBe(true);
        // Discard -> closes, edits dropped. Target the guard's Discard button
        // via its unique "Lose edits, then close" helper text (the Sheet tab's
        // bottom Discard button has the same label "Discard Changes").
        await user.click(screen.getByText('Lose edits, then close').closest('button')!);
        expect(useAppStore.getState().pcPanelOpen).toBe(false);
        expect(useAppStore.getState().playerCharacter?.name).toBe('Aria');
    });

    it('prompts on Escape when the sheet has unsaved edits, and Save commits then closes', async () => {
        const user = userEvent.setup();
        render(<CharacterLedgerModal />);
        await user.click(screen.getByRole('button', { name: 'Edit Character' }));
        const nameInput = screen.getByPlaceholderText("Your character's name") as HTMLInputElement;
        await user.clear(nameInput);
        await user.type(nameInput, 'Aria Saved');
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.getByText('Unsaved Changes')).toBeInTheDocument();
        expect(useAppStore.getState().pcPanelOpen).toBe(true);
        // Target the guard's Save button via its "Commit edits, then close" helper.
        await user.click(screen.getByText('Commit edits, then close').closest('button')!);
        expect(useAppStore.getState().pcPanelOpen).toBe(false);
        expect(useAppStore.getState().playerCharacter?.name).toBe('Aria Saved');
    });

    it('Cancel in the guard returns to editing without closing', async () => {
        const user = userEvent.setup();
        render(<CharacterLedgerModal />);
        await user.click(screen.getByRole('button', { name: 'Edit Character' }));
        const nameInput = screen.getByPlaceholderText("Your character's name") as HTMLInputElement;
        await user.clear(nameInput);
        await user.type(nameInput, 'Aria Editing');
        const backdrop = screen.getByRole('dialog', { name: 'Character Ledger' });
        await user.click(backdrop);
        await user.click(screen.getByRole('button', { name: /Cancel \(keep editing\)/i }));
        expect(useAppStore.getState().pcPanelOpen).toBe(true);
        expect(screen.queryByText('Unsaved Changes')).not.toBeInTheDocument();
        expect((screen.getByPlaceholderText("Your character's name") as HTMLInputElement).value).toBe('Aria Editing');
    });
});