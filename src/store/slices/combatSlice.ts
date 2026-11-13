import type { StateCreator } from 'zustand';
import type { AbilityProposal, CombatProposal, CombatSession, CombatTableRecord, GlyphAbility } from '../../types';
import { createDebouncedSave } from '../../services/tables/genericAccessor';
import { combatTableDescriptor } from '../../services/tables/combatTable';

export type CombatSlice = {
    combatSession: CombatSession | null;
    combatProposal: CombatProposal | null;
    abilityProposal: AbilityProposal | null;
    abilityEditDraft: GlyphAbility | null;
    combatBusy: boolean;
    setCombatSession: (s: CombatSession | null) => void;
    setCombatProposal: (p: CombatProposal | null) => void;
    setAbilityProposal: (p: AbilityProposal | null) => void;
    setAbilityEditDraft: (a: GlyphAbility | null) => void;
    setCombatBusy: (busy: boolean) => void;
    resetCombat: () => void;
};

type CombatDeps = CombatSlice & { activeCampaignId: string | null };

let getCombatSaveState: (() => { activeCampaignId: string | null; field: CombatTableRecord }) | null = null;

export const combatTableSave = createDebouncedSave<CombatTableRecord>(combatTableDescriptor as never, () =>
    getCombatSaveState?.() ?? { activeCampaignId: null, field: { session: null } },
);

export const createCombatSlice: StateCreator<CombatDeps, [], [], CombatSlice> = (set, get) => {
    getCombatSaveState = () => {
        const s = get();
        return { activeCampaignId: s.activeCampaignId, field: { session: s.combatSession } };
    };

    return {
        combatSession: null,
        combatProposal: null,
        abilityProposal: null,
        abilityEditDraft: null,
        combatBusy: false,
        setCombatSession: (session) => {
            set({ combatSession: session });
            combatTableSave({ session });
        },
        setCombatProposal: (proposal) => set({ combatProposal: proposal }),
        setAbilityProposal: (proposal) => set({ abilityProposal: proposal }),
        setAbilityEditDraft: (draft) => set({ abilityEditDraft: draft }),
        setCombatBusy: (busy) => set({ combatBusy: busy }),
        resetCombat: () => {
            set({ combatSession: null, combatProposal: null, abilityProposal: null, abilityEditDraft: null, combatBusy: false });
            combatTableSave({ session: null });
        },
    };
};
