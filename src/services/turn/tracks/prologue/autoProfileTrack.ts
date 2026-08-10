import type { PostTurnTrack, PrologueTrackContext } from '../types';
import type { CharacterProfile } from '../../../../types';

export const autoProfileTrack: PostTurnTrack<PrologueTrackContext> = {
    id: 'track.auto-profile',
    name: 'Auto-Enable Character Profile',
    description: 'Enables characterProfileActive for chat-made PCs.',
    toggleable: false,
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: false,
    shouldRun: () => true,
    run: async (ctx: PrologueTrackContext): Promise<void> => {
        const { state, callbacks, npcLedger } = ctx;
        if (state.context.characterProfileActive) return;

        // PC lives at `context.playerCharacter`. Defensive
        // fallback to a legacy `isPC` ledger row (post-migration this is empty).
        const pc = state.context.playerCharacter ?? npcLedger.find(n => n.isPC);
        if (!pc) return;

        const existing: CharacterProfile = state.context.characterProfileData || {
            name: '',
            race: '',
            class: '',
            level: 1,
            hp: { current: 20, max: 20 },
            stats: {},
            skills: [],
            abilities: [],
            traits: [],
            notes: ''
        };
        const seeded: CharacterProfile = {
            ...existing,
            name: existing.name || pc.name,
        };
        callbacks.updateContext({
            characterProfileActive: true,
            characterProfileData: seeded,
        });
        console.log(`[B3] Auto-enabled characterProfileActive; seeded characterProfileData.name from PC "${pc.name}"`);
    }
};
