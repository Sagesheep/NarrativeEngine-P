import { beforeEach, expect, it, vi } from 'vitest';
import type { GameContext, LocationEntry } from '../../../types';
const getState = vi.hoisted(() => vi.fn());
vi.mock('../../../store/useAppStore', () => ({ useAppStore: { getState } }));
import { applyStoryMovement } from '../applyStoryMovement';
import { buildMovementContract, parseStoryMovement } from '../storyMovement';
import { locationHeaderTrack } from '../tracks/sequential/locationHeaderTrack';
import type { SequentialTrackContext } from '../tracks/types';
import { proseForTTS } from '../../tts/proseStripper';
const place = (id: string): LocationEntry => ({ id, name: id, aliases: '', broadLocation: '', features: [], connections: [], description: '', source: 'manual', firstSeenScene: '1', lastSeenScene: '1' });
let state: ReturnType<typeof setup>;
function setup() {
    const state = { activeCampaignId: 'c', context: { currentPlaceId: 'a', worldDay: 5 } as GameContext,
        locationLedger: [place('a'), place('b')], addMessage: vi.fn(),
        updateContext: vi.fn((patch: Partial<GameContext>) => { state.context = { ...state.context, ...patch }; }),
        updateLocation: vi.fn((id: string, patch: Partial<LocationEntry>) => { state.locationLedger = state.locationLedger.map(p => p.id === id ? { ...p, ...patch } : p); }),
        addLocation: vi.fn((p: LocationEntry) => { state.locationLedger.push(p); }),
        setLocationLedger: vi.fn((ledger: LocationEntry[]) => { state.locationLedger = ledger; }),
    }; return state;
}
const tag = (value: unknown) => `<!-- MOVEMENT ${JSON.stringify(value)} -->`;
beforeEach(() => { state = setup(); getState.mockImplementation(() => state); });
it('validates malformed and duplicate updates, retaining them for commit but not speech', () => {
    expect(parseStoryMovement(tag({ action: 'teleport-anywhere' })).movement).toBeNull();
    expect(parseStoryMovement(tag({ action: 'stay' }) + tag({ action: 'continue' })).movement).toBeNull();
    expect(parseStoryMovement('<!-- MOVEMENT {').present).toBe(true);
    expect(proseForTTS('The fire crackles. ' + tag({ action: 'stay' }))).toBe('The fire crackles.');
});
it('camp and local features do not move the world position or spend a day', async () => {
    await applyStoryMovement(tag({ action: 'stay' }), 'c');
    await applyStoryMovement(tag({ action: 'local', feature: 'Kitchen' }), 'c');
    expect(state.context).toMatchObject({ currentPlaceId: 'a', currentFeature: 'Kitchen', worldDay: 5 });
    expect(state.locationLedger[0].features).toEqual(['Kitchen']);
    expect(state.addMessage).not.toHaveBeenCalled();
});
it('starts a real journey without the map only when a saved connection exists', async () => {
    await applyStoryMovement(tag({ action: 'depart', place: 'b' }), 'c');
    expect(state.context.currentPlaceId).toBe('a');
    state.locationLedger[0].connections = [{ toId: 'b', band: 'remote' }];
    await applyStoryMovement(tag({ action: 'depart', place: 'b' }), 'c');
    expect(state.context.travel).toMatchObject({ fromId: 'a', toId: 'b', leg: 1 });
    expect(state.context.worldDay).toBe(6);
});
it('rejects early arrival, then advances exactly one checkpoint on continue', async () => {
    state.context.travel = { fromId: 'a', toId: 'b', transitId: 'road', mode: 'foot', leg: 1, totalLegs: 4, agency: 'free' };
    await applyStoryMovement(tag({ action: 'arrive', place: 'b' }), 'c');
    expect(state.context.worldDay).toBe(5);
    await applyStoryMovement(tag({ action: 'continue' }), 'c');
    expect(state.context.travel?.leg).toBe(2);
    expect(state.context.worldDay).toBe(6);
    state.context.travel!.leg = 3;
    await applyStoryMovement(tag({ action: 'arrive', place: 'b' }), 'c');
    expect(state.context).toMatchObject({ currentPlaceId: 'b', travel: null, worldDay: 7 });
});
it('creates an initial scene but does not accept ordinary cross-place arrival', async () => {
    state.context.currentPlaceId = null;
    await applyStoryMovement(tag({ action: 'arrive', place: 'Unknown settlement', feature: 'Slum district' }), 'c');
    expect(state.addLocation).toHaveBeenCalledTimes(1);
    expect(state.context.currentFeature).toBe('Slum district');
    const at = state.context.currentPlaceId;
    await applyStoryMovement(tag({ action: 'arrive', place: 'b' }), 'c');
    expect(state.context.currentPlaceId).toBe(at);
});
it('newer manual map movement wins over a pending story reply', async () => {
    const old = { ...state.context };
    state.context = { ...state.context, currentPlaceId: 'b', worldDay: 6 };
    await locationHeaderTrack.run({ activeCampaignId: 'c', state: { context: old }, lastAssistantContent: tag({ action: 'relocate', place: 'a' }), callbacks: { updateContext: state.updateContext } } as unknown as SequentialTrackContext);
    expect(state.context.currentPlaceId).toBe('b');
    expect(state.updateContext).not.toHaveBeenCalled();
});
it('the ordinary next-chat payload includes the authoritative position and quiet-camp rules', () => {
    const block = buildMovementContract(state.context, state.locationLedger);
    expect(block).toContain('"id":"a"');
    expect(block).toContain('supersedes older chat');
    expect(block).toContain('do not advance travel');
});
