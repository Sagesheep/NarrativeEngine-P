import type { AppSettings, ArchiveChapter, ArchiveIndexEntry, ChatMessage, CondenserState, GameContext, NPCEntry, SemanticFact, BackupMeta } from '../types';

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
        },
        async fetchScenes(campaignId: string, sceneIds: string[]): Promise<{ sceneId: string; content: string }[]> {
            if (sceneIds.length === 0) return [];
            const idsParam = sceneIds.join(',');
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/scenes?ids=${idsParam}`);
            if (!res.ok) throw new Error('Failed to fetch scenes');
            return res.json();
        },
    },
    chapters: {
        async list(campaignId: string): Promise<ArchiveChapter[]> {
            const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters`);
            if (res.ok) return await res.json();
            return [];
        },
        async create(campaignId: string, body?: { title?: string }): Promise<ArchiveChapter | undefined> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body || {}),
                });
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Chapters] Failed to create:', err);
            }
            return undefined;
        },
        async update(campaignId: string, chapterId: string, body: Partial<ArchiveChapter>): Promise<ArchiveChapter | undefined> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/${chapterId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Chapters] Failed to update:', err);
            }
            return undefined;
        },
        async seal(campaignId: string, title?: string): Promise<{ sealedChapter: ArchiveChapter; newOpenChapter: ArchiveChapter } | undefined> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/seal`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title }),
                });
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Chapters] Failed to seal:', err);
            }
            return undefined;
        },
        async merge(campaignId: string, chapterIdA: string, chapterIdB: string): Promise<ArchiveChapter | undefined> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/merge`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chapterIdA, chapterIdB }),
                });
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Chapters] Failed to merge:', err);
            }
            return undefined;
        },
        async split(campaignId: string, chapterId: string, atSceneId: string): Promise<{ chapterA: ArchiveChapter, chapterB: ArchiveChapter } | undefined> {
            try {
                const res = await fetch(`${API}/campaigns/${campaignId}/archive/chapters/${chapterId}/split`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ atSceneId }),
                });
                if (res.ok) return await res.json();
            } catch (err) {
                console.warn('[Chapters] Failed to split:', err);
            }
            return undefined;
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
            const res = await fetch(`${API}/campaigns/${campaignId}/state`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(state),
            });
            if (!res.ok) console.warn('[State] Failed to save campaign state:', res.status);
        },
        async saveNPCs(campaignId: string, npcs: NPCEntry[]): Promise<void> {
            const res = await fetch(`${API}/campaigns/${campaignId}/npcs`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(npcs),
            });
            if (!res.ok) console.warn('[NPCs] Failed to save NPC ledger:', res.status);
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
    },
    backups: {
        async create(campaignId: string, opts: { label?: string; trigger?: string; isAuto?: boolean } = {}): Promise<any> {
            const res = await fetch(`${API}/campaigns/${campaignId}/backup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(opts),
            });
            if (res.ok) return await res.json();
            return undefined;
        },
        async list(campaignId: string): Promise<BackupMeta[]> {
            const res = await fetch(`${API}/campaigns/${campaignId}/backups`);
            if (res.ok) {
                const data = await res.json();
                return data.backups || [];
            }
            return [];
        },
        async restore(campaignId: string, timestamp: number): Promise<boolean> {
            const res = await fetch(`${API}/campaigns/${campaignId}/backups/${timestamp}/restore`, {
                method: 'POST',
            });
            return res.ok;
        },
        async remove(campaignId: string, timestamp: number): Promise<boolean> {
            const res = await fetch(`${API}/campaigns/${campaignId}/backups/${timestamp}`, {
                method: 'DELETE',
            });
            return res.ok;
        },
    },
};
