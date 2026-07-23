import type { ArchiveChapter, ArchiveIndexEntry, SemanticFact, TimelineEvent, BackupMeta, BackupCreateResult } from '../../types';
import { getList, setList, k, computeHash, type SceneRecord } from './_helpers';
import { get as idbGet, set as idbSet } from 'idb-keyval';

export type BackupData = {
    scenes: SceneRecord[];
    index: ArchiveIndexEntry[];
    chapters: ArchiveChapter[];
    facts: SemanticFact[];
    timeline: TimelineEvent[];
    chatState: unknown;
};

export const backupStorage = {
    async create(cid: string, opts: { label?: string; trigger?: string; isAuto?: boolean }): Promise<BackupCreateResult> {
        const scenes: SceneRecord[] = await getList(k(cid, 'scenes'));
        if (scenes.length === 0) return { skipped: true };

        const index = await getList<ArchiveIndexEntry>(k(cid, 'archive_index'));
        const chapters = await getList<ArchiveChapter>(k(cid, 'chapters'));
        const facts = await getList<SemanticFact>(k(cid, 'facts'));
        const timeline = await getList<TimelineEvent>(k(cid, 'timeline'));
        const chatState = await idbGet(`state_${cid}`);

        const hash = computeHash(JSON.stringify({ scenes, index, chapters, facts, timeline, chatState }));
        const backups = await getList<{ timestamp: number; meta: BackupMeta; data: BackupData }>(k(cid, 'backups'));

        if (opts.isAuto) {
            const autoBackups = backups.filter(b => b.meta.isAuto && !b.meta.label?.trim()).sort((a, b) => b.timestamp - a.timestamp);
            if (autoBackups.length > 0 && autoBackups[0].meta.hash === hash) {
                return { skipped: true };
            }
        }

        const now = Date.now();
        const meta: BackupMeta = {
            timestamp: now,
            label: opts.label || '',
            trigger: opts.trigger || 'manual',
            hash,
            fileCount: scenes.length,
            isAuto: opts.isAuto || false,
            campaignName: '',
        };

        backups.push({ timestamp: now, meta, data: { scenes, index, chapters, facts, timeline, chatState } });

        if (opts.isAuto) {
            const autoBackups = backups.filter(b => b.meta.isAuto && !b.meta.label?.trim()).sort((a, b) => b.timestamp - a.timestamp);
            for (let i = 10; i < autoBackups.length; i++) {
                const idx = backups.findIndex(b => b.timestamp === autoBackups[i].timestamp);
                if (idx >= 0) backups.splice(idx, 1);
            }
        }

        await setList(k(cid, 'backups'), backups);
        return { skipped: false, timestamp: now, hash, fileCount: scenes.length };
    },

    async list(cid: string): Promise<BackupMeta[]> {
        const backups = await getList<{ timestamp: number; meta: BackupMeta }>(k(cid, 'backups'));
        return backups.map(b => b.meta).sort((a, b) => b.timestamp - a.timestamp);
    },

    async read(cid: string, ts: number): Promise<{ meta: BackupMeta; data: BackupData } | null> {
        const backups = await getList<{ timestamp: number; meta: BackupMeta; data: BackupData }>(k(cid, 'backups'));
        return backups.find(b => b.timestamp === ts) || null;
    },

    async restore(cid: string, ts: number): Promise<{ ok: boolean } | null> {
        const backups = await getList<{ timestamp: number; meta: BackupMeta; data: BackupData }>(k(cid, 'backups'));
        const target = backups.find(b => b.timestamp === ts);
        if (!target) return null;

        await backupStorage.create(cid, {
            label: `Pre-restore from ${new Date(ts).toLocaleString()}`,
            trigger: 'pre-restore',
            isAuto: false,
        }).catch(() => {});

        const d = target.data;
        if (d.scenes) await setList(k(cid, 'scenes'), d.scenes);
        if (d.index) await setList(k(cid, 'archive_index'), d.index);
        if (d.chapters) await setList(k(cid, 'chapters'), d.chapters);
        if (d.facts) await setList(k(cid, 'facts'), d.facts);
        if (d.timeline) await setList(k(cid, 'timeline'), d.timeline);
        if (d.chatState) await idbSet(`state_${cid}`, d.chatState);

        return { ok: true };
    },

    async delete(cid: string, ts: number): Promise<void> {
        const backups = await getList<{ timestamp: number; meta: BackupMeta; data: BackupData }>(k(cid, 'backups'));
        await setList(k(cid, 'backups'), backups.filter(b => b.timestamp !== ts));
    },
};
