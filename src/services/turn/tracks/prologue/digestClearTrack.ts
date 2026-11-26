import type { PostTurnTrack, PrologueTrackContext } from '../types';

export const digestClearTrack: PostTurnTrack<PrologueTrackContext> = {
    id: 'track.digest-clear',
    name: 'Digest Clear',
    description: "Clears the previous turn's agency and arc digests.",
    toggleable: false,
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: false,
    shouldRun: () => true,
    run: async (ctx: PrologueTrackContext): Promise<void> => {
        const { state, callbacks } = ctx;
        if (state.context.agencyDigest) {
            callbacks.updateContext({ agencyDigest: '' });
        }
        if (state.context.arcDigest) {
            callbacks.updateContext({ arcDigest: '' });
        }
    }
};
