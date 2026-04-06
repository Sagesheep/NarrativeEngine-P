import type { AppSettings, ArchiveIndexEntry, ChatMessage, CondenserState, GameContext, NPCEntry, SemanticFact } from '../types';

const API = '/api';

export const api = {
    archive: {
        async append(campaignId: string, userText: string, assistantText: string): Promise<{ sceneId: string } | undefined> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/archive`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userContent: userText, assistantContent: assistantText }),
                });
                if (res.ok) {
                    return await res.json();
                }
            } catch (err) {
                console.warn('[Archive] Failed to append:', err);
            }
            return undefined;
        },
        async getIndex(campaignId: string): Promise<ArchiveIndexEntry[]> {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/index`);
            if (res.ok) return await res.json();
            return [];
        },
        async deleteFrom(campaignId: string, sceneId: string): Promise<void> {
            await fetch(`${API}/campaigns/${campaignId}/archive/scenes-from/${sceneId}`, {
                method: 'DELETE'
            });
        },
        async clear(campaignId: string): Promise<void> {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive`, { method: 'DELETE' });
            if (!res.ok) throw new Error('Failed to clear archive');
        },
        async open(campaignId: string): Promise<void> {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/open`);
            if (!res.ok) {
                const data = await res.json();
                console.warn('[Archive]', data.error || 'Failed to open');
            }
        }
    },
    facts: {
        async get(campaignId: string): Promise<SemanticFact[]> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/facts`);
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Facts] Failed to fetch:', err);
            }
            return [];
        },
    },
    campaigns: {
        async saveState(campaignId: string, state: { context: GameContext; messages: ChatMessage[]; condenser: CondenserState }): Promise<void> {
            await fetch(`${API}/campaigns/${campaignId}/state`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(state),
            });
        },
        async saveNPCs(campaignId: string, npcs: NPCEntry[]): Promise<void> {
            await fetch(`${API}/campaigns/${campaignId}/npcs`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(npcs),
            });
        }
    },
    settings: {
        async get(): Promise<any> {
            const res = await fetch(`${API}/settings`);
            if (!res.ok) throw new Error('Failed to load settings');
            return await res.json();
        },
        async save(settings: AppSettings, activeCampaignId: string | null): Promise<void> {
            await fetch(`${API}/settings`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ settings, activeCampaignId }),
            });
        }
    }
};
