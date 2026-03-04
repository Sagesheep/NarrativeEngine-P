import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Play, Clock, BookOpen, Pencil } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import {
    listCampaigns, deleteCampaign, loadCampaignState,
    saveCampaign, saveCampaignState, saveLoreChunks, getLoreChunks,
    getNPCLedger, loadArchiveChunks
} from '../store/campaignStore';
import { chunkLoreFile } from '../services/loreChunker';
import type { Campaign } from '../types';

const DEFAULT_CONTEXT = {
    loreRaw: '',
    rulesRaw: '',
    canonState: '',
    headerIndex: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    characterProfile: '',
    canonStateActive: false,
    headerIndexActive: false,
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    surpriseEngineActive: true,
    worldEngineActive: true,
    diceFairnessActive: true,
};

const DEFAULT_CONDENSER = { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false };

export function CampaignHub() {
    useAppStore(); // state accessed via useAppStore.setState / useAppStore.getState
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

    // Modal state
    const [modalOpen, setModalOpen] = useState(false);
    const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);

    // Form state
    const [name, setName] = useState('');
    const [coverFile, setCoverFile] = useState<File | null>(null);
    const [coverPreview, setCoverPreview] = useState('');
    const [loreFile, setLoreFile] = useState<File | null>(null);
    const [loreName, setLoreName] = useState('');
    const [rulesFile, setRulesFile] = useState<File | null>(null);
    const [rulesName, setRulesName] = useState('');

    const refresh = useCallback(async () => {
        const list = await listCampaigns();
        setCampaigns(list);
    }, []);

    useEffect(() => {
        let mounted = true;
        listCampaigns().then(list => { if (mounted) setCampaigns(list); });
        return () => { mounted = false; };
    }, []);

    const resetForm = () => {
        setName('');
        setCoverFile(null);
        setCoverPreview('');
        setLoreFile(null);
        setLoreName('');
        setRulesFile(null);
        setRulesName('');
        setEditingCampaign(null);
    };

    const openCreate = () => {
        resetForm();
        setModalOpen(true);
    };

    const openEdit = (campaign: Campaign) => {
        setEditingCampaign(campaign);
        setName(campaign.name);
        setCoverPreview(campaign.coverImage || '');
        setLoreName('');
        setRulesName('');
        setLoreFile(null);
        setRulesFile(null);
        setCoverFile(null);
        setModalOpen(true);
    };

    const handleCoverChange = (file: File) => {
        setCoverFile(file);
        const reader = new FileReader();
        reader.onload = (e) => setCoverPreview(e.target?.result as string);
        reader.readAsDataURL(file);
    };

    const handleSave = async () => {
        if (!name.trim()) return;

        const isEdit = !!editingCampaign;
        const campaign: Campaign = isEdit
            ? { ...editingCampaign, name: name.trim(), lastPlayedAt: Date.now() }
            : {
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
                name: name.trim(),
                coverImage: '',
                createdAt: Date.now(),
                lastPlayedAt: Date.now(),
            };

        // Update cover if changed
        if (coverFile) {
            campaign.coverImage = coverPreview;
        } else if (isEdit) {
            campaign.coverImage = coverPreview; // Keep existing or cleared
        }

        await saveCampaign(campaign);

        // Process lore file if uploaded
        if (loreFile) {
            const loreText = await loreFile.text();
            const chunks = chunkLoreFile(loreText);
            await saveLoreChunks(campaign.id, chunks);
        }

        // Process rules file if uploaded (update campaign state)
        if (rulesFile) {
            const rulesRaw = await rulesFile.text();
            const existingState = await loadCampaignState(campaign.id);
            const ctx = existingState?.context ?? DEFAULT_CONTEXT;
            await saveCampaignState(campaign.id, {
                context: { ...ctx, rulesRaw },
                messages: existingState?.messages ?? [],
                condenser: existingState?.condenser ?? DEFAULT_CONDENSER,
            });
        }

        setModalOpen(false);
        resetForm();
        refresh();
    };

    const handleSelectCampaign = async (campaign: Campaign) => {
        const now = new Date().getTime();
        const updatedCampaign = { ...campaign, lastPlayedAt: now };
        await saveCampaign(updatedCampaign);

        // Load campaign state and flush into Zustand
        const state = await loadCampaignState(campaign.id);
        const chunks = await getLoreChunks(campaign.id);
        const npcs = await getNPCLedger(campaign.id);
        const archiveChunks = await loadArchiveChunks(campaign.id);

        // Batch-set all state at once to avoid partial renders
        useAppStore.setState({
            context: state?.context ?? DEFAULT_CONTEXT,
            messages: state?.messages ?? [],
            condenser: state?.condenser ?? DEFAULT_CONDENSER,
            loreChunks: chunks,
            npcLedger: npcs,
            archiveChunks,
            activeCampaignId: campaign.id,
        });
    };

    const handleDelete = async (id: string) => {
        await deleteCampaign(id);
        setConfirmDelete(null);
        refresh();
    };

    const timeAgo = (ts: number) => {
        const now = new Date().getTime();
        const diff = now - ts;
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        const days = Math.floor(hrs / 24);
        return `${days}d ago`;
    };

    return (
        <div className="flex flex-col items-center justify-center min-h-screen bg-void p-4 md:p-8">
            {/* Title */}
            <h1 className="text-terminal text-lg sm:text-2xl font-bold tracking-[0.2em] sm:tracking-[0.4em] uppercase glow-green mb-2">
                AI GM COCKPIT
            </h1>
            <p className="text-text-dim text-xs tracking-widest uppercase mb-6 sm:mb-10">
                SELECT CAMPAIGN
            </p>

            {/* Campaign Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6 max-w-4xl w-full mb-6 sm:mb-8">
                {campaigns.map((c) => (
                    <div
                        key={c.id}
                        className="group relative bg-surface border border-border rounded-lg overflow-hidden hover:border-terminal transition-all duration-300 cursor-pointer"
                        onClick={() => handleSelectCampaign(c)}
                    >
                        {/* Cover Image */}
                        <div className="h-36 bg-void-lighter flex items-center justify-center overflow-hidden">
                            {c.coverImage ? (
                                <img src={c.coverImage} alt={c.name} className="w-full h-full object-cover opacity-80 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500" />
                            ) : (
                                <BookOpen size={32} className="text-text-dim group-hover:text-terminal transition-colors" />
                            )}
                        </div>

                        {/* Info */}
                        <div className="p-4">
                            <h2 className="text-text-primary font-bold text-sm uppercase tracking-wider group-hover:text-terminal transition-colors">
                                {c.name}
                            </h2>
                            <div className="flex items-center gap-1 mt-2 text-text-dim text-xs">
                                <Clock size={10} />
                                <span>{timeAgo(c.lastPlayedAt)}</span>
                            </div>
                        </div>

                        {/* Play overlay */}
                        <div className="absolute inset-0 bg-terminal/5 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                            <Play size={40} className="text-terminal glow-green opacity-0 group-hover:opacity-80 transition-opacity" />
                        </div>

                        {/* Edit button */}
                        <button
                            onClick={(e) => { e.stopPropagation(); openEdit(c); }}
                            className="absolute top-2 left-2 p-1.5 rounded bg-void/80 text-text-dim hover:text-terminal opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                            title="Edit campaign"
                        >
                            <Pencil size={14} />
                        </button>

                        {/* Delete button */}
                        <button
                            onClick={(e) => { e.stopPropagation(); setConfirmDelete(c.id); }}
                            className="absolute top-2 right-2 p-1.5 rounded bg-void/80 text-text-dim hover:text-danger opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                            title="Delete campaign"
                        >
                            <Trash2 size={14} />
                        </button>
                    </div>
                ))}

                {/* New Campaign Card */}
                <button
                    onClick={openCreate}
                    className="bg-surface border border-dashed border-border rounded-lg h-56 flex flex-col items-center justify-center gap-3 hover:border-terminal hover:bg-void-lighter transition-all duration-300 group"
                >
                    <Plus size={28} className="text-text-dim group-hover:text-terminal transition-colors" />
                    <span className="text-text-dim text-xs uppercase tracking-widest group-hover:text-terminal transition-colors">
                        New Campaign
                    </span>
                </button>
            </div>

            {/* Delete Confirmation */}
            {confirmDelete && (
                <div className="fixed inset-0 bg-ember/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setConfirmDelete(null)}>
                    <div className="bg-surface border border-danger rounded-lg p-6 max-w-sm" onClick={(e) => e.stopPropagation()}>
                        <p className="text-text-primary text-sm mb-4">Delete this campaign? All data (chat, lore, saves) will be lost.</p>
                        <div className="flex gap-3 justify-end">
                            <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 text-xs text-text-dim hover:text-text-primary border border-border rounded transition-colors">
                                Cancel
                            </button>
                            <button onClick={() => handleDelete(confirmDelete)} className="px-4 py-2 text-xs text-void bg-danger rounded hover:brightness-110 transition-colors font-bold">
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Create / Edit Campaign Modal */}
            {modalOpen && (
                <div className="fixed inset-0 bg-ember/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => { setModalOpen(false); resetForm(); }}>
                    <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
                        <h2 className="text-terminal text-sm font-bold tracking-widest uppercase mb-6">
                            {editingCampaign ? 'Edit Campaign' : 'New Campaign'}
                        </h2>

                        {/* Campaign Name */}
                        <label className="block text-text-dim text-xs uppercase tracking-wider mb-1">Campaign Name</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Fantasy — Ash's Story"
                            className="w-full bg-void border border-border rounded px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/50 mb-4"
                            autoFocus
                        />

                        {/* Cover Image */}
                        <label className="block text-text-dim text-xs uppercase tracking-wider mb-1">Cover Image</label>
                        <div className="mb-4">
                            {coverPreview ? (
                                <div className="relative h-28 rounded overflow-hidden border border-border">
                                    <img src={coverPreview} alt="Cover" className="w-full h-full object-cover" />
                                    <button onClick={() => { setCoverFile(null); setCoverPreview(''); }}
                                        className="absolute top-1 right-1 bg-void/80 text-danger p-1 rounded">
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            ) : (
                                <label className="flex items-center justify-center h-20 border border-dashed border-border rounded cursor-pointer hover:border-terminal transition-colors">
                                    <span className="text-text-dim text-xs">Click or drop image</span>
                                    <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && handleCoverChange(e.target.files[0])} />
                                </label>
                            )}
                        </div>

                        {/* World Lore */}
                        <label className="block text-text-dim text-xs uppercase tracking-wider mb-1">
                            World Lore (.md) {editingCampaign && <span className="text-text-dim/50 normal-case">— re-upload to replace</span>}
                        </label>
                        <label className="flex items-center gap-2 px-3 py-2 bg-void border border-border rounded cursor-pointer hover:border-terminal transition-colors mb-1">
                            <BookOpen size={14} className="text-text-dim" />
                            <span className="text-sm text-text-dim">{loreName || 'Choose file...'}</span>
                            <input type="file" accept=".md,.txt" className="hidden" onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) { setLoreFile(f); setLoreName(f.name); }
                            }} />
                        </label>
                        <p className="text-text-dim text-xs mb-4 opacity-60">Split into chunks by ### headers for dynamic retrieval</p>

                        {/* Rules */}
                        <label className="block text-text-dim text-xs uppercase tracking-wider mb-1">
                            Rules (.md) {editingCampaign && <span className="text-text-dim/50 normal-case">— re-upload to replace</span>}
                        </label>
                        <label className="flex items-center gap-2 px-3 py-2 bg-void border border-border rounded cursor-pointer hover:border-terminal transition-colors mb-6">
                            <BookOpen size={14} className="text-text-dim" />
                            <span className="text-sm text-text-dim">{rulesName || 'Choose file...'}</span>
                            <input type="file" accept=".md,.txt" className="hidden" onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) { setRulesFile(f); setRulesName(f.name); }
                            }} />
                        </label>

                        {/* Actions */}
                        <div className="flex gap-3 justify-end">
                            <button onClick={() => { setModalOpen(false); resetForm(); }} className="px-4 py-2 text-xs text-text-dim hover:text-text-primary border border-border rounded transition-colors">
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={!name.trim()}
                                className="px-4 py-2 text-xs text-void bg-terminal rounded font-bold hover:brightness-110 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                                {editingCampaign ? 'Save Changes' : 'Create & Enter'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
