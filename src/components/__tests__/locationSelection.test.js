import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const { state } = vi.hoisted(() => ({ state: {} }));
vi.mock('../../store/useAppStore', () => ({ useAppStore: Object.assign(selector => selector(state), { getState: () => state }) }));
vi.mock('../Toast', () => ({ toast: { success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../../services/locationEnrich', () => ({ queueLocationEnrichment: vi.fn() }));
vi.mock('../../services/npc/manualAdd', () => ({ addNpcFromSelection: vi.fn() }));
vi.mock('../../services/scene-images/sceneImageContextGatherer', () => ({ buildSceneImageContextInput: vi.fn() }));
vi.mock('../../services/sceneImagesClient', () => ({ composeSceneImageAPI: vi.fn() }));
import { useSelectionActions } from '../chat/useSelectionActions';
const place = (id, name) => ({ id, name, aliases: '', features: [], connections: [], coordinates: { x: 40, y: 60 } });
beforeEach(() => {
    Object.assign(state, { activeCampaignId: 'c', context: { currentPlaceId: 'camp', currentFeature: 'Fire', worldDay: 7 },
        locationLedger: [place('camp', 'Camp')], updateContext: vi.fn(), updateLocation: vi.fn(),
        addLocation: vi.fn(entry => state.locationLedger.push(entry)), dismissLocationSuggestion: vi.fn() });
});
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); document.body.replaceChildren(); });
function addSelected(name) {
    const bubble = document.createElement('div');
    bubble.dataset.loreCheckable = 'true'; bubble.dataset.messageId = 'message';
    const prefix = 'Your quest will be in ';
    bubble.textContent = prefix + name + '.'; document.body.append(bubble);
    const range = document.createRange(); range.setStart(bubble.firstChild, prefix.length); range.setEnd(bubble.firstChild, prefix.length + name.length);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    const hook = renderHook(() => useSelectionActions());
    act(() => hook.result.current.handleAddPlace({ preventDefault() {} }));
    hook.unmount();
}
it('adding a quest destination never moves the party or copies its coordinates', () => {
    addSelected("Baldur's Gate");
    expect(state.addLocation).toHaveBeenCalledTimes(1);
    expect(state.locationLedger[1]).toMatchObject({ name: "Baldur's Gate" });
    expect(state.locationLedger[1].coordinates).toBeUndefined();
    expect(state.updateContext).not.toHaveBeenCalled();
    expect(state.context).toEqual({ currentPlaceId: 'camp', currentFeature: 'Fire', worldDay: 7 });
});
it('repeated mentions reuse the saved place and coordinates', () => {
    const destination = { ...place('gate', "Baldur's Gate"), coordinates: { x: 800, y: 900 } };
    state.locationLedger.push(destination);
    addSelected("Baldur's Gate"); addSelected("Baldur's Gate");
    expect(state.addLocation).not.toHaveBeenCalled();
    expect(state.updateContext).not.toHaveBeenCalled();
    expect(state.locationLedger[1]).toBe(destination);
    expect(destination.coordinates).toEqual({ x: 800, y: 900 });
});
it('adding a feature records it without changing the current feature', () => {
    addSelected('Kitchen');
    expect(state.updateLocation).toHaveBeenCalledWith('camp', expect.objectContaining({ features: ['Kitchen'] }));
    expect(state.updateContext).not.toHaveBeenCalled();
    expect(state.addLocation).not.toHaveBeenCalled();
});
