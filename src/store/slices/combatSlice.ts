import type { StateCreator } from 'zustand';
import type { CombatProposal, CombatSession, CombatTableRecord } from '../../types';
import { createDebouncedSave } from '../../services/tables/genericAccessor';
import { combatTableDescriptor } from '../../services/tables/combatTable';

export type CombatSlice = {
    combatSession: CombatSession | null;
    combatProposal: CombatProposal | null;
    combatBusy: boolean;
    setCombatSession: (s: CombatSession | null) => void;
    setCombatProposal: (p: CombatProposal | null) => void;
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
        combatBusy: false,
        setCombatSession: (session) => {
            set({ combatSession: session });
            combatTableSave({ session });
        },
        setCombatProposal: (proposal) => set({ combatProposal: proposal }),
        setCombatBusy: (busy) => set({ combatBusy: busy }),
        resetCombat: () => {
            set({ combatSession: null, combatProposal: null, combatBusy: false });
            combatTableSave({ session: null });
        },
    };
};
