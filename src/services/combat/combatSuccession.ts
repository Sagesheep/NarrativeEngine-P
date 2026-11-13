import { createDefaultSheet } from '@narrative/engine';
import { useAppStore } from '../../store/useAppStore';
import { debouncedSaveCampaignState } from '../../store/slices/campaignSlice';
import { DEFAULT_CHARACTER_PROFILE, emptySpellbook, normalizeInventoryItem } from '../../types';
import type { CharacterProfile, CombatFallen, InventoryItem, NPCEntry, PlayerCharacter } from '../../types';
import { makeCombatNote } from './combatTurnNotes';

export const BODY_TAG_MAX = 60;

export function bodyTag(name: string): string {
    const clean = name.replace(/["[\]\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim() || 'The fallen';
    return `${clean}'s body`.slice(0, BODY_TAG_MAX);
}

function lifeSummary(profile: CharacterProfile | undefined): string {
    if (!profile) return '';
    const who = [profile.race?.trim(), profile.class?.trim()].filter(Boolean).join(' ');
    const level = Number.isFinite(profile.level) ? `level ${profile.level}` : '';
    const parts = [who, level].filter(Boolean).join(', ');
    return parts ? `In life: ${parts}.` : '';
}

export function deadRecord(pc: PlayerCharacter, profile: CharacterProfile | undefined): NPCEntry {
    const summary = lifeSummary(profile);
    const story = [pc.storyRelevance?.trim(), summary, 'Formerly the player character; died in battle.'].filter(Boolean).join('\n');
    const record: NPCEntry = {
        ...pc,
        condition: 'dead',
        status: 'Deceased',
        agencyLocked: true,
        tier: 'recurring',
        storyRelevance: story,
    };
    delete record.isPC;
    return record;
}

export function relocateItems(items: readonly InventoryItem[], tag: string): InventoryItem[] {
    return items.map(item => normalizeInventoryItem({ ...item, locationTag: tag, equipped: false }));
}

export function prepareSuccession(): boolean {
    const store = useAppStore.getState();
    const fallen = store.context.combatFallen;
    if (!fallen || fallen.stage !== 'fallen') return false;
    const pc = store.context.playerCharacter ?? store.playerCharacter ?? null;
    const profile = store.context.characterProfileData;
    const tag = bodyTag(fallen.name);
    const items = relocateItems(store.context.inventoryItems ?? store.inventoryItems ?? [], tag);
    store.setPlayerCharacter(null);
    if (pc) {
        const dead = deadRecord(pc, profile);
        if (!useAppStore.getState().npcLedger.some(n => n.id === dead.id)) useAppStore.getState().addNPC(dead);
    }
    const live = useAppStore.getState();
    live.setInventoryItems(items);
    live.setCharacterProfileData({ ...DEFAULT_CHARACTER_PROFILE, hp: { ...DEFAULT_CHARACTER_PROFILE.hp }, stats: {}, skills: [], abilities: [], traits: [] });
    live.setAbilityProposal(null);
    live.setAbilityEditDraft(null);
    const next: CombatFallen = { ...fallen, stage: 'creating' };
    live.updateContext({
        combatSheet: createDefaultSheet(),
        spellbook: emptySpellbook(),
        characterProfile: { identity: {}, activeTraits: [] },
        creationDraft: null,
        combatFallen: next,
    });
    debouncedSaveCampaignState();
    return true;
}

export function successionNoteText(fallen: CombatFallen, newName: string): string {
    const name = newName.trim() || 'a new character';
    return [
        `${fallen.name} died in battle. The death is final: ${fallen.name} is now a dead person in the world record, and everything they carried lies with their body ("${bodyTag(fallen.name)}").`,
        `The player now plays ${name}, a different person.`,
        `Continue the story from ${name}'s point of view. Do not treat ${name} as ${fallen.name}, and do not bring ${fallen.name} back.`,
    ].join(' ');
}

export function completeSuccession(): boolean {
    const store = useAppStore.getState();
    const fallen = store.context.combatFallen;
    const pc = store.context.playerCharacter ?? store.playerCharacter;
    if (!fallen || fallen.stage !== 'creating' || !pc) return false;
    store.updateContext({
        combatFallen: undefined,
        combatSuccession: makeCombatNote(successionNoteText(fallen, pc.name)),
    });
    debouncedSaveCampaignState();
    return true;
}
