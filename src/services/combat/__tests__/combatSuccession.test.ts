import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../../store/useAppStore';
import { cancelPendingSaves } from '../../../store/slices/campaignSlice';
import { bodyTag, completeSuccession, prepareSuccession, successionNoteText } from '../combatSuccession';
import { isRewindDeleteLocked, isSwipeLockedByCombat } from '../combatLocks';
import { renderCombatNotes } from '../combatTurnNotes';
import { settleCombatNotesOnCommit } from '../combatCommitHooks';
import { commitCharacterDraft } from '../../character/commitCharacterDraft';
import type { GameContext, InventoryItem, PlayerCharacter } from '../../../types';

const kira: PlayerCharacter = {
    id: 'pc-kira', name: 'Kira', aliases: '', appearance: 'scarred', faction: 'Wardens', storyRelevance: 'A wandering sword.',
    status: 'Alive', voice: '', personality: '', exampleOutput: '', isPC: true,
} as PlayerCharacter;

const sword: InventoryItem = {
    id: 'i1', name: 'Longsword', qty: 1, category: 'weapon', keywords: [], equipped: true, lastUsedScene: '001', importance: 5, notes: '', locationTag: 'inventory',
} as InventoryItem;

function seedFallen(): void {
    const base = useAppStore.getState().context;
    const context = {
        ...base,
        playerCharacter: kira,
        inventoryItems: [sword],
        characterProfileData: { ...base.characterProfileData, name: 'Kira', race: 'Elf', class: 'Ranger', level: 4, notes: 'Owes the guild.', skills: ['Tracking'], stats: { STR: 14 }, hp: { current: 1, max: 30 }, mp: { current: 2, max: 10 } },
        combatSheet: { abilities: { STR: 14, DEX: 16, CON: 12, INT: 10, WIS: 12, CHA: 8 }, budget: 'NORMAL', level: 3, needsAllocation: false },
        spellbook: { abilities: [{ id: 'a', name: 'Bolt', form: { id: 'projectile', augments: [] }, effects: [{ id: 'damage', augments: [] }], source: 'player' }], equippedIds: ['a'] },
        combatFallen: { name: 'Kira', pcId: 'pc-kira', mode: 'ironman', at: 10, stage: 'fallen' },
        combatAftermath: { id: 'n1', text: 'Kira died in this fight. The death is final.', createdAt: 10 },
    } as GameContext;
    useAppStore.setState({
        activeCampaignId: 'c1',
        context,
        playerCharacter: kira,
        inventoryItems: [sword],
        characterProfileData: context.characterProfileData,
        npcLedger: [],
        abilityProposal: { id: 'ap', messageId: 'm', ability: context.spellbook!.abilities[0] },
        combatSession: null,
        pcPanelOpen: false,
    });
}

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    seedFallen();
});

afterEach(() => {
    cancelPendingSaves();
    vi.unstubAllGlobals();
});

describe('succession after death', () => {
    it('locks rewind, delete, edit, continue and swipes while the death screen is pending', () => {
        expect(isRewindDeleteLocked({ role: 'assistant', content: '' } as never)).toBe(true);
        expect(isSwipeLockedByCombat('any-message')).toBe(true);
        useAppStore.getState().updateContext({ combatFallen: undefined });
        expect(isRewindDeleteLocked({ role: 'assistant', content: '' } as never)).toBe(false);
        expect(isSwipeLockedByCombat('any-message')).toBe(false);
    });

    it('preserves the dead character in the ledger without isPC, relocates the items and resets the sheet', () => {
        expect(prepareSuccession()).toBe(true);
        const s = useAppStore.getState();
        const dead = s.npcLedger.find(n => n.id === 'pc-kira');
        expect(dead).toMatchObject({ name: 'Kira', condition: 'dead', status: 'Deceased', agencyLocked: true, appearance: 'scarred' });
        expect(dead?.isPC).toBeUndefined();
        expect(dead?.storyRelevance).toContain('Elf Ranger, level 4');
        expect(s.context.playerCharacter).toBeNull();
        expect(s.inventoryItems).toEqual([expect.objectContaining({ name: 'Longsword', locationTag: 'Kira\'s body', equipped: false })]);
        expect(s.context.characterProfileData).toMatchObject({ name: '', race: '', class: '', notes: '', skills: [], stats: {} });
        expect(s.context.characterProfileData.mp).toBeUndefined();
        expect(s.context.combatSheet?.needsAllocation).toBe(true);
        expect(s.context.spellbook).toEqual({ abilities: [], equippedIds: [] });
        expect(s.abilityProposal).toBeNull();
        expect(s.context.combatFallen?.stage).toBe('creating');
        expect(prepareSuccession()).toBe(false);
        expect(useAppStore.getState().npcLedger.filter(n => n.id === 'pc-kira')).toHaveLength(1);
    });

    it('appends the new character\'s starting items instead of replacing the inventory', () => {
        prepareSuccession();
        const before = useAppStore.getState().inventoryItems;
        commitCharacterDraft(
            { draft: { name: 'Bren', answers: { 8: 'a lantern, rope' } } },
            {
                setPlayerCharacter: (pc) => useAppStore.getState().setPlayerCharacter(pc),
                setInventoryItems: (items) => useAppStore.getState().setInventoryItems(items),
                updateContext: (patch) => useAppStore.getState().updateContext(patch as never),
                characterProfileData: useAppStore.getState().characterProfileData,
                inventoryItems: before,
            },
        );
        const items = useAppStore.getState().inventoryItems;
        expect(items.map(i => i.name)).toEqual(['Longsword', 'a lantern', 'rope']);
        expect(items[0].locationTag).toBe('Kira\'s body');
    });

    it('completes once the new character exists and sends a one-turn succession note with the aftermath', () => {
        prepareSuccession();
        expect(completeSuccession()).toBe(false);
        useAppStore.getState().setPlayerCharacter({ ...kira, id: 'pc-bren', name: 'Bren' });
        expect(completeSuccession()).toBe(true);
        const ctx = useAppStore.getState().context;
        expect(ctx.combatFallen).toBeUndefined();
        const notes = renderCombatNotes(ctx);
        expect(notes).toContain('[COMBAT AFTERMATH]');
        expect(notes).toContain('[NEW PLAYER CHARACTER]');
        expect(notes).toContain('The player now plays Bren');
        settleCombatNotesOnCommit({ messageId: 'gm-next', messageTimestamp: Date.now() + 1000, sceneStakes: 'calm' as never });
        const after = useAppStore.getState().context;
        expect(after.combatSuccession).toBeUndefined();
        expect(after.combatAftermath).toBeUndefined();
    });

    it('names the body tag safely', () => {
        expect(bodyTag('Kira "the Blade"')).toBe('Kira the Blade\'s body');
        expect(bodyTag('x'.repeat(80)).length).toBeLessThanOrEqual(60);
        expect(successionNoteText({ name: 'Kira', mode: 'ironman', at: 1, stage: 'creating' }, 'Bren')).toContain('Do not treat Bren as Kira');
    });
});
