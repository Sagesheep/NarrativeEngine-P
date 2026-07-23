import type { PlayerCharacter, CharacterCreationDraft, NPCVisualProfile, InventoryItem, CharacterProfileState } from '../../types';
import { DEFAULT_VISUAL_PROFILE } from '../../types';
import { uid } from '../../utils/uid';

/**
 * WO-A2 §2.8 — commit the assembled draft into the live store.
 *
 * Nothing exists until this runs. One function, one code path, used by the
 * wizard AND by WO-C's "play as one of my cards" import. The caller passes
 * the resolved store setters so this stays pure + testable.
 *
 * §0 invariant: `personalityHex` and `traits` are written ONLY by the quiz
 * or the user's own hand. The converter (§2.7) is forbidden from emitting
 * them; this function does NOT synthesize them either. If `draft.hex` /
 * `draft.traits` are present (set by the quiz step), they are honored. If
 * not, they stay unset — a PC without a hex is a valid state.
 */

export type CommitInputs = {
    draft: CharacterCreationDraft;
    /** Personality hex from the quiz step (§2.6). Optional — Skip leaves this undefined. */
    hex?: import('../../types').PersonalityHex;
    /** Traits from the quiz step (§2.6). Optional. */
    traits?: string[];
};

export type CommitDeps = {
    setPlayerCharacter: (pc: PlayerCharacter | null) => void;
    setInventoryItems: (items: InventoryItem[]) => void;
    updateContext: (patch: Record<string, unknown>) => void;
    /** Current characterProfileData (read); seeded with name only. */
    characterProfileData?: Partial<{ name: string; level: number; hp: { current: number; max: number } }> | null;
};

const DEFAULT_HP = { current: 20, max: 20 };

/**
 * Assemble a `PlayerCharacter` record from a committed draft, WITHOUT writing
 * it anywhere. Exposed for tests and WO-C's "play as one of my cards" import
 * (which has its own store wiring but wants the same assembly rules).
 */
export function assemblePlayerCharacter(inputs: CommitInputs): PlayerCharacter {
    const { draft, hex, traits } = inputs;
    const visualProfile: NPCVisualProfile = { ...DEFAULT_VISUAL_PROFILE, ...(draft.visualProfile || {}) };

    const pc: PlayerCharacter = {
        id: uid(),
        name: (draft.name || '').trim(),
        aliases: '',
        appearance: draft.appearance || '',
        visualProfile,
        faction: draft.answers?.[3] || '',
        storyRelevance: draft.answers?.[2] || '',
        disposition: draft.answers?.[5] || '',
        status: 'Alive',
        goals: '',
        voice: draft.answers?.[6] || '',
        personality: '',
        exampleOutput: '',
        affinity: 50,
        isPC: true,
        populated: true,
        wants: { short: [], medium: [], long: draft.answers?.[7] || '' },
    };

    // §2.3 slot 4 → signatureKit.abilities + element. Free-text answer is
    // split into abilities (comma/pipe separated). Element is a single tag
    // pulled from a trailing " (element: fire)" if present.
    const slot4 = draft.answers?.[4] || '';
    if (slot4) {
        const elemMatch = slot4.match(/\(element:\s*([^)]+)\)/i);
        const element = elemMatch ? elemMatch[1].trim().slice(0, 20) : undefined;
        const stripped = slot4.replace(/\(element:\s*[^)]+\)/i, '').trim();
        const abilities = stripped.split(/[,|]/).map(s => s.trim()).filter(Boolean).slice(0, 8);
        if (abilities.length || element) {
            pc.signatureKit = { equipment: [], abilities, element };
        }
    }

    if (hex) pc.personalityHex = hex;
    if (traits && traits.length > 0) pc.traits = traits.slice(0, 5);

    return pc;
}

/**
 * Parse slot 8 (starting possessions, free text) into `InventoryItem[]`.
 * Comma/pipe/newline separated; each item becomes a `misc`-category row.
 */
export function parseStartingInventory(raw: string): InventoryItem[] {
    const names = (raw || '')
        .split(/[,|\n]/)
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 30);
    return names.map((name, i) => ({
        id: `pc_start_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        qty: 1,
        category: 'misc' as const,
        keywords: [],
        equipped: false,
        lastUsedScene: '000',
        importance: 5,
        notes: '',
        locationTag: 'inventory',
    }));
}

/**
 * Commit the draft. Writes `playerCharacter`, seeds `characterProfileData`
 * (name + level 1 + default hp), sets `inventoryItems` from slot 8, mirrors
 * the name into `characterProfile.identity.name`, and clears `creationDraft`.
 *
 * Note: `postTurnPipeline.ts:262` already auto-seeds `characterProfileData`
 * from the PC during play when the profile is inactive, so seed only what
 * play won't.
 */
export function commitCharacterDraft(inputs: CommitInputs, deps: CommitDeps): void {
    const pc = assemblePlayerCharacter(inputs);
    deps.setPlayerCharacter(pc);

    const existing = deps.characterProfileData || { name: '', race: '', class: '', level: 1, hp: { ...DEFAULT_HP } };
    deps.updateContext({
        characterProfileData: {
            ...existing,
            name: pc.name,
            level: existing.level ?? 1,
            hp: existing.hp ?? { ...DEFAULT_HP },
        } as never,
    });

    const startItems = parseStartingInventory(inputs.draft.answers?.[8] || '');
    if (startItems.length > 0) deps.setInventoryItems(startItems);

    const profile: CharacterProfileState = (deps as { context?: { characterProfile?: CharacterProfileState } }).context?.characterProfile
        ?? { identity: {}, activeTraits: [] };
    deps.updateContext({
        characterProfileActive: true,
        characterProfile: {
            ...profile,
            identity: { ...profile.identity, name: pc.name },
        },
    } as never);

    // Clear the draft (§2.8 step 5). The caller's `updateContext` is the
    // same path used above, so this rides the same dispatch.
    deps.updateContext({ creationDraft: null } as never);
}