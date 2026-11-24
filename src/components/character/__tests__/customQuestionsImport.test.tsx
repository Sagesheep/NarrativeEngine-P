import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AIGuidedCreationWizard } from '../AIGuidedCreationWizard';
import { useAppStore } from '../../../store/useAppStore';

const utility = { id: 'u', label: 'u', endpoint: 'http://model.test', apiKey: '', modelName: 'utility' };

describe('AI-Guided Creation — custom questions', () => {
    let previous: ReturnType<typeof useAppStore.getState>;

    beforeEach(() => {
        previous = useAppStore.getState();
        try { localStorage.clear(); } catch { /* none */ }
        useAppStore.setState({
            loreChunks: [],
            context: { ...previous.context, creationDraft: undefined },
            getActiveUtilityEndpoint: () => utility,
        });
    });

    afterEach(() => useAppStore.setState(previous, true));

    it('imports pasted questions straight into the answering form, even without lore', () => {
        render(<AIGuidedCreationWizard onCancel={vi.fn()} onCommit={vi.fn()} />);
        // No lore: the AI interview is hidden but the import path stays open.
        expect(screen.queryByRole('button', { name: 'Begin Interview' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Use my own questions/ }));

        fireEvent.change(screen.getByLabelText('Custom questions'), {
            target: { value: '# Ashfall questions\n1) Which ash-clan raised you?\n2. Which Warden do you answer to?' },
        });
        expect(screen.getByText('Which ash-clan raised you?')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /Use these questions/ }));

        expect(screen.getByText('2. Which ash-clan raised you?')).toBeTruthy();
        expect(screen.getByText('3. Which Warden do you answer to?')).toBeTruthy();
        // Unlisted questions keep the stock wording.
        expect(screen.getByText(/^4\. What can your character do\?/)).toBeTruthy();
        expect(useAppStore.getState().context.creationDraft?.questions?.[2]).toBe('Which ash-clan raised you?');
    });

    it('blocks Use until the input parses', () => {
        render(<AIGuidedCreationWizard onCancel={vi.fn()} onCommit={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: /Use my own questions/ }));
        fireEvent.change(screen.getByLabelText('Custom questions'), { target: { value: '  ' } });
        expect((screen.getByRole('button', { name: /Use these questions/ }) as HTMLButtonElement).disabled).toBe(true);
    });
});
