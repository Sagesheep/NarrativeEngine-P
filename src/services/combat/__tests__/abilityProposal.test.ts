import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyAction, buildPcCombatant, freshTurn } from '@narrative/engine';
import type { CombatState, Combatant } from '@narrative/engine';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { acceptAbilityProposal, dismissAbilityProposal, editAbilityProposal, liveAbilityProposal, stageAbilityProposal } from '../abilityProposal';
import { parseAbilityArgs } from '../abilityProposalArgs';
import { buildPcInput } from '../combatController';
import { isSwipeLockedByCombat } from '../combatLocks';
import { toggleEquipped, configOf } from '../spellbook';
import { migrateLegacyContext } from '../../../types';
import type { CombatSheet, GlyphAbility } from '../../../types';

const sheet: CombatSheet = { abilities: { STR: 10, DEX: 14, CON: 14, INT: 16, WIS: 10, CHA: 8 }, budget: 'NORMAL', level: 3, needsAllocation: false };

function seed() {
    const context = migrateLegacyContext({
        combatModeActive: true,
        combatSheet: sheet,
        characterProfileData: { name: 'Kira', race: '', class: '', level: 3, hp: { current: 25, max: 25 }, stats: {}, skills: [], abilities: [], traits: [], notes: '' },
    });
    useAppStore.setState({ context, characterProfileData: context.characterProfileData, activeCampaignId: 'camp', abilityProposal: null, abilityEditDraft: null, combatProposal: null, pcPanelOpen: false, spellbookOpen: false });
}

function proposed(): GlyphAbility {
    const parsed = parseAbilityArgs({ name: 'Frost lance', damageType: 'frost', form: 'projectile', effects: [{ effect: 'damage' }, { effect: 'slow' }] }, { maxChainLength: 6, maxSummons: 2 });
    if (!parsed.ok) throw new Error('invalid');
    return parsed.ability;
}

describe('AI-proposed abilities (acceptance 4)', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
        seed();
    });

    afterEach(() => {
        cancelPendingSaves();
        vi.unstubAllGlobals();
    });

    it('passes through confirmation into the spellbook and works in a fight', () => {
        stageAbilityProposal({ id: 'p1', messageId: 'gm-1', ability: proposed() });
        expect(useAppStore.getState().context.spellbook!.abilities).toHaveLength(0);
        expect(isSwipeLockedByCombat('gm-1')).toBe(true);
        expect(isSwipeLockedByCombat('gm-2')).toBe(false);
        const added = acceptAbilityProposal()!;
        expect(useAppStore.getState().abilityProposal).toBeNull();
        expect(isSwipeLockedByCombat('gm-1')).toBe(false);
        const store = useAppStore.getState();
        expect(store.context.spellbook!.abilities.map(a => [a.name, a.source])).toEqual([['Frost lance', 'ai']]);
        store.updateContext({ spellbook: toggleEquipped(store.context.spellbook!, added.id, configOf(store.context)) });
        const pc = { ...buildPcCombatant(buildPcInput(useAppStore.getState())!), position: { x: 1, y: 1 } };
        const foe: Combatant = {
            id: 'f', name: 'Bandit', side: 'enemy', controller: 'engine', tier: 'grunt',
            abilities: { STR: 10, DEX: 10, CON: 10, INT: 10, WIS: 10, CHA: 10 },
            maxHp: 50, hp: 50, ac: -50, attackBonus: 0, damage: { count: 1, sides: 4, bonus: 0, type: 'x' },
            initiative: 1, status: 'up', conditions: [], position: { x: 6, y: 1 }, range: 'close',
        };
        const base: CombatState = {
            id: 'f1', round: 1, order: ['pc', 'f'], turnIndex: 0, combatants: { pc, f: foe },
            rngSeed: 3, rngCursor: 0, eventSeq: 0, outcome: null, turnCount: 1,
            grid: { width: 10, height: 4, tiles: new Array(40).fill('floor') },
        };
        const r = applyAction({ ...base, turn: freshTurn(base, 'pc') }, { type: 'use_ability', actorId: 'pc', abilityId: added.id, aim: { x: 6, y: 1 } });
        const types = r.events.map(e => e.type);
        expect(types[0]).toBe('ability');
        expect(r.events.find(e => e.type === 'ability_attack')?.data.hit).toBe(true);
        expect(types).toContain('ability_damage');
        expect(r.state.combatants.f.conditions.map(c => c.id)).toContain('slowed');
        expect(r.state.combatants.pc.mp).toBe(16 - 3);
    });

    it('edit first opens the builder with the draft and stages nothing in the spellbook', () => {
        stageAbilityProposal({ id: 'p1', messageId: 'gm-1', ability: proposed() });
        editAbilityProposal();
        const store = useAppStore.getState();
        expect(store.abilityEditDraft?.name).toBe('Frost lance');
        expect(store.spellbookOpen).toBe(true);
        expect(store.abilityProposal).toBeNull();
        expect(store.context.spellbook!.abilities).toHaveLength(0);
    });

    it('dismiss leaves the spellbook alone, and a proposal from another campaign is ignored', () => {
        stageAbilityProposal({ id: 'p1', messageId: 'gm-1', ability: proposed() });
        dismissAbilityProposal();
        expect(useAppStore.getState().context.spellbook!.abilities).toHaveLength(0);
        stageAbilityProposal({ id: 'p2', messageId: 'gm-1', ability: proposed() });
        useAppStore.setState({ activeCampaignId: 'other' });
        expect(liveAbilityProposal()).toBeNull();
        expect(acceptAbilityProposal()).toBeNull();
    });
});
