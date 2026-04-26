import { useState, useEffect } from 'react';
import { X, RotateCcw, Trash2, Save, Clock, Loader2, CheckSquare, Square } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { listBackups, createBackup, restoreBackup, deleteBackup } from '../store/campaignStore';
import { hydrateCampaign } from '../store/campaignHydrator';
import { cancelPendingSaves, flushAllPendingSaves } from '../store/slices/campaignSlice';
import type { BackupMeta } from '../types';
import { toast } from './Toast';

export function BackupModal() {
    const { backupModalOpen, toggleBackupModal, activeCampaignId } = useAppStore();
    const [backups, setBackups] = useState<BackupMeta[]>([]);
    const [loading, setLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [restoringTs, setRestoringTs] = useState<number | null>(null);
    const [selectedBackups, setSelectedBackups] = useState<Set<number>>(new Set());
    const [deletingBatch, setDeletingBatch] = useState(false);

    useEffect(() => {
        if (backupModalOpen && activeCampaignId) loadBackups();
    }, [backupModalOpen, activeCampaignId]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && backupModalOpen) {
                setSelectedBackups(new Set());
                toggleBackupModal();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [backupModalOpen, toggleBackupModal]);

    if (!backupModalOpen) return null;

    async function loadBackups() {
        if (!activeCampaignId) return;
        setLoading(true);
        const list = await listBackups(activeCampaignId);
        setBackups(list);
        setLoading(false);
    }

    async function handleCreateManual() {
        if (!activeCampaignId) return;
        setCreating(true);
        await flushAllPendingSaves();
        const result = await createBackup(activeCampaignId, { trigger: 'manual', label: 'Manual backup' });
        if (result?.skipped) {
            toast.info('No changes since last backup');
        } else if (result?.timestamp) {
            toast.success('Manual backup created');
            await loadBackups();
        } else {
            toast.error('Failed to create backup');
        }
        setCreating(false);
    }

    async function handleRestore(ts: number) {
        if (!activeCampaignId) return;
        const backup = backups.find(b => b.timestamp === ts);
        const label = backup ? new Date(backup.timestamp).toLocaleString() : String(ts);
        if (!window.confirm(`Restore from "${label}"?\n\nYour current state will be saved as a backup first.`)) return;

        setRestoringTs(ts);
        // Cancel any pending debounced saves so they don't overwrite the restored
        // files between the server copy and our client-side load below.
        cancelPendingSaves();
        const ok = await restoreBackup(activeCampaignId, ts);
        if (ok) {
            try {
                cancelPendingSaves();
                await hydrateCampaign(activeCampaignId);
                toast.success('Restored from backup');
                await loadBackups();
            } catch (err) {
                console.error('[Restore] Failed to reload state after restore:', err);
                toast.error('Restore failed — could not reload data');
            }
        } else {
            toast.error('Restore failed');
        }
        setRestoringTs(null);
    }

    async function handleDelete(ts: number) {
        if (!activeCampaignId) return;
        if (!window.confirm('Delete this backup permanently?')) return;
        const ok = await deleteBackup(activeCampaignId, ts);
        if (ok) {
            toast.success('Backup deleted');
            await loadBackups();
        } else {
            toast.error('Failed to delete backup');
        }
    }

    function toggleSelect(ts: number) {
        setSelectedBackups(prev => {
            const next = new Set(prev);
            if (next.has(ts)) next.delete(ts);
            else next.add(ts);
            return next;
        });
    }

    function toggleSelectAll() {
        if (selectedBackups.size === backups.length) {
            setSelectedBackups(new Set());
        } else {
            setSelectedBackups(new Set(backups.map(b => b.timestamp)));
        }
    }

    async function handleBatchDelete() {
        if (!activeCampaignId || selectedBackups.size === 0) return;
        const count = selectedBackups.size;
        if (!window.confirm(`Delete ${count} backup${count > 1 ? 's' : ''} permanently?`)) return;

        setDeletingBatch(true);
        let failed = 0;
        for (const ts of selectedBackups) {
            const ok = await deleteBackup(activeCampaignId, ts);
            if (!ok) failed++;
        }
        if (failed === 0) {
            toast.success(`Deleted ${count} backup${count > 1 ? 's' : ''}`);
        } else if (failed < count) {
            toast.error(`Deleted ${count - failed} of ${count} backups`);
        } else {
            toast.error('Failed to delete backups');
        }
        setSelectedBackups(new Set());
        await loadBackups();
        setDeletingBatch(false);
    }

    function triggerBadge(trigger: string) {
        const colors: Record<string, string> = {
            manual: 'bg-green-900/50 text-green-400',
            auto: 'bg-blue-900/50 text-blue-400',
            'pre-clear': 'bg-amber-900/50 text-amber-400',
            'pre-rollback': 'bg-amber-900/50 text-amber-400',
            'pre-delete-npc': 'bg-amber-900/50 text-amber-400',
            'pre-clear-archive': 'bg-amber-900/50 text-amber-400',
            'pre-delete-campaign': 'bg-amber-900/50 text-amber-400',
            'pre-restore': 'bg-purple-900/50 text-purple-400',
        };
        const color = colors[trigger] || 'bg-gray-700/50 text-gray-400';
        return (
            <span className={`text-xs px-2 py-0.5 rounded font-mono ${color}`}>
                {trigger}
            </span>
        );
    }

    return (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={() => { setSelectedBackups(new Set()); toggleBackupModal(); }}>
            <div
                className="bg-surface border border-border rounded-lg w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase">Backup Manager</h2>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleCreateManual}
                            disabled={creating}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-terminal/20 text-terminal rounded hover:bg-terminal/30 transition-colors text-xs font-semibold disabled:opacity-50"
                        >
                            {creating ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                            Create Backup
                        </button>
                        <button onClick={toggleBackupModal} className="text-text-dim hover:text-text transition-colors">
                            <X size={18} />
                        </button>
                    </div>
                </div>

                {/* Backup list */}
                <div className="flex-1 overflow-y-auto p-2">
                    {loading ? (
                        <div className="flex items-center justify-center py-12 text-text-dim">
                            <Loader2 size={20} className="animate-spin mr-2" />
                            Loading backups...
                        </div>
                    ) : backups.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 text-text-dim">
                            <Clock size={32} className="mb-3 opacity-30" />
                            <p className="text-sm">No backups yet</p>
                            <p className="text-xs opacity-60 mt-1">Click "Create Backup" to make your first backup</p>
                        </div>
                    ) : (
                        <div className="space-y-1">
                            {backups.map((b) => (
                                <div
                                    key={b.timestamp}
                                    className={`flex items-center gap-3 p-3 rounded transition-colors ${selectedBackups.has(b.timestamp) ? 'bg-white/10' : 'hover:bg-white/5'}`}
                                >
                                    <button
                                        onClick={() => toggleSelect(b.timestamp)}
                                        disabled={deletingBatch}
                                        className="shrink-0 text-text-dim hover:text-text transition-colors disabled:opacity-50"
                                    >
                                        {selectedBackups.has(b.timestamp)
                                            ? <CheckSquare size={16} className="text-terminal" />
                                            : <Square size={16} />
                                        }
                                    </button>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 mb-0.5">
                                            <span className="text-xs text-text-dim font-mono">
                                                {new Date(b.timestamp).toLocaleString()}
                                            </span>
                                            {triggerBadge(b.trigger)}
                                            {b.isAuto && (
                                                <span className="text-xs text-blue-400/60">auto</span>
                                            )}
                                        </div>
                                        {b.label && (
                                            <p className="text-xs text-text truncate">{b.label}</p>
                                        )}
                                        <p className="text-xs text-text-dim/60">
                                            {b.fileCount} files · {b.campaignName}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-1 shrink-0">
                                        <button
                                            onClick={() => handleRestore(b.timestamp)}
                                            disabled={restoringTs === b.timestamp}
                                            className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-terminal/20 text-terminal hover:bg-terminal/30 transition-colors disabled:opacity-50"
                                            title="Restore from this backup"
                                        >
                                            {restoringTs === b.timestamp ? (
                                                <Loader2 size={12} className="animate-spin" />
                                            ) : (
                                                <RotateCcw size={12} />
                                            )}
                                            Restore
                                        </button>
                                        <button
                                            onClick={() => handleDelete(b.timestamp)}
                                            className="p-1 text-text-dim hover:text-danger transition-colors"
                                            title="Delete this backup"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Footer info */}
                {backups.length > 0 && (
                    <div className="px-4 py-2 border-t border-border flex items-center justify-between text-xs text-text-dim/60">
                        <div className="flex items-center gap-3">
                            <button
                                onClick={toggleSelectAll}
                                disabled={deletingBatch}
                                className="flex items-center gap-1 hover:text-text transition-colors disabled:opacity-50"
                            >
                                {selectedBackups.size === backups.length
                                    ? <CheckSquare size={13} className="text-terminal" />
                                    : <Square size={13} />
                                }
                                {selectedBackups.size === backups.length ? 'Deselect All' : 'Select All'}
                            </button>
                            <span>
                                {backups.filter(b => b.isAuto).length} auto · {backups.filter(b => !b.isAuto).length} manual
                            </span>
                        </div>
                        {selectedBackups.size > 0 && (
                            <button
                                onClick={handleBatchDelete}
                                disabled={deletingBatch}
                                className="flex items-center gap-1.5 px-3 py-1 bg-danger/20 text-danger rounded hover:bg-danger/30 transition-colors font-semibold disabled:opacity-50"
                            >
                                {deletingBatch
                                    ? <Loader2 size={12} className="animate-spin" />
                                    : <Trash2 size={12} />
                                }
                                Delete Selected ({selectedBackups.size})
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
