import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAppStore } from '../../../store/useAppStore';
import { buildSceneImageContextInput } from '../sceneImageContextGatherer';

describe('sceneImageContextGatherer', () => {
    beforeEach(() => {
        useAppStore.setState({
            activeCampaignId: 'camp_test_1',
            messages: [
                { id: 'm1', role: 'user', content: 'Hello', timestamp: 100 },
                { id: 'm2', role: 'assistant', content: 'First narrative scene', timestamp: 101 },
                { id: 'm3', role: 'assistant', content: 'Second narrative scene with action', timestamp: 102 },
                { id: 'm4', role: 'assistant', content: 'Target selection message here', timestamp: 103 },
            ],
            context: {
                currentPlaceId: 'p1',
            } as any,
            locationLedger: [
                { id: 'p1', name: 'High Castle' } as any,
            ],
            npcLedger: [
                { id: 'n1', name: 'Garrick', lastSeenScene: '1' } as any,
            ],
        });
    });

    it('builds context input with active campaign, recent narrative, and present characters', () => {
        const input = buildSceneImageContextInput('m4', 'Target selection message', 0, 23);
        expect(input.campaignId).toBe('camp_test_1');
        expect(input.sourceMessageId).toBe('m4');
        expect(input.selectedText).toBe('Target selection message');
        expect(input.activeScene.location).toBe('High Castle');
        expect(input.presentCharacters).toContain('Garrick');
        expect(input.recentNarrative.length).toBe(2);
        expect(input.recentNarrative[0].text).toBe('First narrative scene');
        expect(input.recentNarrative[1].text).toBe('Second narrative scene with action');
    });
});
