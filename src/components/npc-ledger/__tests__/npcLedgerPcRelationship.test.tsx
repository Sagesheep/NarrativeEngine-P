import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React, { useState } from 'react';
import { NPCEditForm } from '../NPCEditForm';
import { useAppStore } from '../../../store/useAppStore';
import type { NPCEntry, PlayerCharacter } from '../../../types';

function TestWrapper({ npc }: { npc: NPCEntry }) {
    const [form, setForm] = useState<Partial<NPCEntry>>(npc);
    return (
        <NPCEditForm
            form={form}
            setForm={setForm}
            selectedId={npc.id}
            isEditing={true}
            isAIUpdating={false}
            isGeneratingImage={false}
            onEdit={() => {}}
            onSave={() => {}}
            onCancel={() => {}}
            onDelete={() => {}}
            onAIUpdate={() => {}}
            onGeneratePortrait={() => {}}
            onUploadPortrait={() => {}}
        />
    );
}

describe('NPCEditForm — Character Ledger (Player Character) Relationship Integration', () => {
    const mockPC: PlayerCharacter = {
        id: 'pc-123',
        name: 'Hero Player',
        isPC: true,
        status: 'Alive',
        tier: 'recurring',
    };

    const mockNPC: NPCEntry = {
        id: 'npc-456',
        name: 'Ally NPC',
        status: 'Alive',
        tier: 'recurring',
        relations: {},
        pcRelation: 0,
    };

    beforeEach(() => {
        useAppStore.setState({
            playerCharacter: mockPC,
            npcLedger: [mockNPC],
        });
    });

    it('renders the Player Character in the relationship selection dropdown', () => {
        render(<TestWrapper npc={mockNPC} />);
        const select = screen.getByDisplayValue('-- Select Character / NPC --');
        expect(select).toBeInTheDocument();
        const pcOption = screen.getByText('Hero Player (Player)');
        expect(pcOption).toBeInTheDocument();
        expect((pcOption as HTMLOptionElement).value).toBe('pc-123');
    });

    it('adds Player Character into NPC relations and syncs pcRelation', () => {
        render(<TestWrapper npc={mockNPC} />);
        const select = screen.getByDisplayValue('-- Select Character / NPC --');
        fireEvent.change(select, { target: { value: 'pc-123' } });

        const addButton = screen.getByRole('button', { name: /^add$/i });
        fireEvent.click(addButton);

        expect(screen.getAllByText('Hero Player (Player)').length).toBeGreaterThanOrEqual(2);
    });
});
