import { useState, useEffect } from 'react';
import { X, RotateCcw, Trash2, Save, Clock, Loader2, CheckSquare, Square, Pencil, Check } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { listBackups, createBackup, restoreBackup, deleteBackup, updateBackup } from '../store/campaignStore';
import { hydrateCampaign } from '../store/campaignHydrator';
import { cancelPendingSaves, flushAllPendingSaves } from '../store/slices/campaignSlice';
import type { BackupMeta } from '../types';
import { toast } from './Toast';

export function BackupModal() {
    const { backupModalOpen, toggleBackupModal, activeCampaignId } = useAppStore();
    const [backups, setBackups] = useState<BackupMeta[]>([]);
    const [loading, setLoading] = useState(false);
    const [creating, setCreating] = useState(false);
    const [newBackupLabel, setNewBackupLabel] = useState('');
    const [editingTs, setEditingTs] = useState<number | null>(null);
    const [editingLabel, setEditingLabel] = useState('');
    const [restoringTs, setRestoringTs] = useState<number | null>(null);
    const [selectedBackups, setSelectedBackups] = useState<Set<number>>(new Set());
    const [deletingBatch, setDeletingBatch] = useState(false);

    useEffect(() => {
        if (backupModalOpen && activeCampaignId) loadBackups();
    }, [backupModalOpen, activeCampaignId]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && backupModalOpen) {
                if (editingTs !== null) {
                    setEditingTs(null);
                } else {
                    setSelectedBackups(new Set());
                    toggleBackupModal();
                }
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [backupModalOpen, toggleBackupModal, editingTs]);

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
        const customLabel = newBackupLabel.trim();
        const label = customLabel || 'Manual backup';
        const result = await createBackup(activeCampaignId, { trigger: 'manual', label });
        if (result?.skipped) {
            toast.info('No changes since last backup');
        } else if (result?.timestamp) {
            toast.success('Backup created');
            setNewBackupLabel('');
            await loadBackups();
        } else {
            toast.error('Failed to create backup');
        }
        setCreating(false);
    }

    function handleStartEdit(b: BackupMeta) {
        setEditingTs(b.timestamp);
        setEditingLabel(b.label || '');
    }

    async function handleSaveEdit(ts: number) {
        if (!activeCampaignId) return;
        const ok = await updateBackup(activeCampaignId, ts, editingLabel.trim());
        if (ok) {
            toast.success('Backup renamed');
            setEditingTs(null);
            await loadBackups();
        } else {
            toast.error('Failed to rename backup');
        }
    }

    async function handleRestore(ts: number) {
        if (!activeCampaignId) return;
        const backup = backups.find(b => b.timestamp === ts);
        const label = backup ? (backup.label || new Date(backup.timestamp).toLocaleString()) : String(ts);
        if (!window.confirm(`Restore from "${label}"?\n\nYour current state will be saved as a backup first.`)) return;

        setRestoringTs(ts);
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
                <div className="p-4 border-b border-border space-y-3">
                    <div className="flex items-center justify-between">
                        <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase">Backup Manager</h2>
                        <button onClick={toggleBackupModal} className="text-text-dim hover:text-text transition-colors">
                            <X size={18} />
                        </button>
                    </div>
                    <div className="flex items-center gap-2">
                        <input
                            type="text"
                            value={newBackupLabel}
                            onChange={(e) => setNewBackupLabel(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateManual(); }}
                            placeholder="Backup name / label (optional, e.g. Before Boss Fight)..."
                            className="flex-1 px-3 py-1.5 bg-background border border-border rounded text-xs text-text placeholder:text-text-dim/50 focus:outline-none focus:border-terminal"
                        />
                        <button
                            onClick={handleCreateManual}
                            disabled={creating}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-terminal/20 text-terminal rounded hover:bg-terminal/30 transition-colors text-xs font-semibold shrink-0 disabled:opacity-50"
                        >
                            {creating ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                            Create Backup
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
                            {backups.map((b) => {
                                const isNamedAuto = b.isAuto && !!b.label?.trim();
                                return (
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
                                                {isNamedAuto ? (
                                                    <span className="text-xs px-1.5 py-0.2 rounded bg-green-900/40 text-green-300 font-mono" title="Named backups are never auto-pruned">
                                                        named (protected)
                                                    </span>
                                                ) : b.isAuto ? (
                                                    <span className="text-xs text-blue-400/60">auto</span>
                                                ) : (
                                                    <span className="text-xs text-green-400/60">manual save</span>
                                                )}
                                            </div>
                                            {editingTs === b.timestamp ? (
                                                <div className="flex items-center gap-1.5 my-1">
                                                    <input
                                                        type="text"
                                                        value={editingLabel}
                                                        onChange={(e) => setEditingLabel(e.target.value)}
                                                        onKeyDown={(e) => {
                                                            if (e.key === 'Enter') handleSaveEdit(b.timestamp);
                                                            if (e.key === 'Escape') setEditingTs(null);
                                                        }}
                                                        placeholder="Name / label..."
                                                        className="flex-1 px-2 py-0.5 bg-background border border-border rounded text-xs text-text focus:outline-none focus:border-terminal"
                                                        autoFocus
                                                    />
                                                    <button
                                                        onClick={() => handleSaveEdit(b.timestamp)}
                                                        className="p-1 text-terminal hover:bg-terminal/20 rounded transition-colors"
                                                        title="Save name"
                                                    >
                                                        <Check size={14} />
                                                    </button>
                                                    <button
                                                        onClick={() => setEditingTs(null)}
                                                        className="p-1 text-text-dim hover:text-text rounded transition-colors"
                                                        title="Cancel"
                                                    >
                                                        <X size={14} />
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-1.5 group/label">
                                                    <p className="text-xs text-text truncate">
                                                        {b.label || <span className="italic text-text-dim/50">Unnamed backup</span>}
                                                    </p>
                                                    <button
                                                        onClick={() => handleStartEdit(b)}
                                                        className="opacity-0 group-hover/label:opacity-100 p-0.5 text-text-dim hover:text-terminal transition-opacity"
                                                        title="Rename backup (naming protects from auto-pruning)"
                                                    >
                                                        <Pencil size={12} />
                                                    </button>
                                                </div>
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
                                );
                            })}
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
                                {backups.filter(b => b.isAuto && !b.label?.trim()).length} auto · {backups.filter(b => !b.isAuto || !!b.label?.trim()).length} manual/named
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

