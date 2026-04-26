import { useState, useEffect, useCallback, useRef } from 'react';
import { Settings, Upload, Loader2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import {
    listCampaigns, deleteCampaign, saveCampaign, exportCampaign, importCampaign,
} from '../store/campaignStore';
import { hydrateCampaign } from '../store/campaignHydrator';
import { API_BASE as API } from '../lib/apiBase';
import { backgroundQueue } from '../services/backgroundQueue';
import type { Campaign } from '../types';
import { useCampaignForm } from './hooks/useCampaignForm';
import { CampaignFormModal } from './CampaignFormModal';
import { CoverflowCarousel } from './CoverflowCarousel';
import { Backdrop } from './primitives/Backdrop';
import { GhostBtn, DangerBtn } from './primitives/Buttons';

export function CampaignHub() {
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [activeIdx, setActiveIdx] = useState(0);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const [isExporting, setIsExporting] = useState<string | null>(null);
    const [isImporting, setIsImporting] = useState(false);
    const importInputRef = useRef<HTMLInputElement>(null);
    const [modalOpen, setModalOpen] = useState(false);
    const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);

    const refresh = useCallback(async () => {
        const list = await listCampaigns();
        const valid = list.filter(c => c && c.id && c.name && c.id !== 'undefined');
        setCampaigns(valid);
        setActiveIdx(prev => Math.min(prev, Math.max(valid.length - 1, 0)));
    }, []);

    const form = useCampaignForm({
        editingCampaign,
        setEditingCampaign,
        onDone: () => { setModalOpen(false); refresh(); },
    });

    useEffect(() => {
        let mounted = true;
        listCampaigns().then(list => {
            if (mounted) {
                const valid = list.filter(c => c && c.id && c.name && c.id !== 'undefined');
                setCampaigns(valid);
            }
        });
        return () => { mounted = false; };
    }, []);

    const openCreate = () => { form.openCreate(); setModalOpen(true); };

    const openEdit = (campaign: Campaign) => {
        form.openEdit(campaign);
        setModalOpen(true);
    };

    const handleSelectCampaign = async (campaign: Campaign) => {
        backgroundQueue.clear('Campaign switch to ' + campaign.id);
        const updatedCampaign = { ...campaign, lastPlayedAt: Date.now() };
        await saveCampaign(updatedCampaign);
        await hydrateCampaign(campaign.id);
    };

    const handleExport = async (id: string) => {
        setIsExporting(id);
        try { await exportCampaign(id); }
        catch (e) { console.error('[Export]', e); alert('Export failed'); }
        finally { setIsExporting(null); }
    };

    const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        e.target.value = '';
        setIsImporting(true);
        try {
            const bundle = JSON.parse(await file.text());
            const result = await importCampaign(bundle);
            await refresh();
            alert(`"${result.name}" imported — search index rebuilding in background`);
        } catch (err) {
            console.error('[Import]', err);
            alert('Import failed — invalid campaign file');
        } finally {
            setIsImporting(false);
        }
    };

    const handleDelete = async (id: string) => {
        fetch(`${API}/campaigns/${id}/backup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger: 'pre-delete-campaign', label: 'Auto-backup before deletion' }),
        }).catch(() => {});

        await deleteCampaign(id);
        setConfirmDelete(null);
        refresh();
    };

    return (
        <div
            style={{
                minHeight: '100vh',
                background: 'var(--color-void)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '40px 20px',
                position: 'relative',
                overflow: 'hidden',
                fontFamily: "'EB Garamond', Georgia, serif",
            }}
        >
            {/* Ambient glow */}
            <div style={{
                position: 'absolute', inset: 0, pointerEvents: 'none',
                background: 'radial-gradient(ellipse 70% 50% at 50% 65%, rgba(106,159,212,0.10) 0%, transparent 70%)',
            }} />

            <input ref={importInputRef} type="file" accept=".campaign,.json" style={{ display: 'none' }} onChange={handleImportFile} />

            {/* Import button */}
            <button
                onClick={() => importInputRef.current?.click()}
                disabled={isImporting}
                title="Import Campaign"
                style={{
                    position: 'absolute', top: 20, left: 20,
                    width: 36, height: 36, borderRadius: '50%',
                    border: '1px solid rgba(106,159,212,0.25)',
                    background: 'rgba(255,255,255,0.04)',
                    color: 'rgba(107,107,107,0.5)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: isImporting ? 'default' : 'pointer', zIndex: 10,
                    opacity: isImporting ? 0.5 : 1,
                    transition: 'all 0.2s',
                }}
                onMouseEnter={e => {
                    if (!isImporting) {
                        (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(106,159,212,0.65)';
                        (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-terminal)';
                    }
                }}
                onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(106,159,212,0.25)';
                    (e.currentTarget as HTMLButtonElement).style.color = 'rgba(107,107,107,0.5)';
                }}
            >
                {isImporting ? <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Upload size={15} />}
            </button>

            {/* Settings button */}
            <button
                onClick={() => useAppStore.getState().toggleSettings()}
                title="Settings"
                style={{
                    position: 'absolute', top: 20, right: 20,
                    width: 36, height: 36, borderRadius: '50%',
                    border: '1px solid rgba(106,159,212,0.25)',
                    background: 'rgba(255,255,255,0.04)',
                    color: 'rgba(107,107,107,0.5)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', zIndex: 10, transition: 'all 0.2s',
                }}
                onMouseEnter={e => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(106,159,212,0.65)';
                    (e.currentTarget as HTMLButtonElement).style.color = 'var(--color-terminal)';
                }}
                onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(106,159,212,0.25)';
                    (e.currentTarget as HTMLButtonElement).style.color = 'rgba(107,107,107,0.5)';
                }}
            >
                <Settings size={15} />
            </button>

            {/* Hero text */}
            <div style={{ textAlign: 'center', marginBottom: 44, position: 'relative', zIndex: 2 }}>
                <div style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10, letterSpacing: '0.4em',
                    textTransform: 'uppercase', color: 'rgba(106,159,212,0.65)',
                    marginBottom: 10,
                }}>
                    AI Game Master System
                </div>
                <h1 style={{
                    fontFamily: "'Cinzel', 'Times New Roman', serif",
                    fontSize: 36, fontWeight: 700,
                    color: 'var(--color-text-primary)', letterSpacing: '0.08em',
                    margin: '0 0 10px', lineHeight: 1,
                }}>
                    Narrative{' '}
                    <span style={{ color: 'var(--color-terminal)' }}>Nexus</span>
                </h1>
                <p style={{
                    fontStyle: 'italic', fontSize: 15,
                    color: 'rgba(107,107,107,0.55)', letterSpacing: '0.02em',
                }}>
                    Choose your world. Shape its fate.
                </p>
                {/* Divider */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18, justifyContent: 'center' }}>
                    <div style={{ height: 1, width: 56, background: 'linear-gradient(to right, transparent, rgba(106,159,212,0.35))' }} />
                    <div style={{ width: 5, height: 5, background: 'var(--color-terminal)', transform: 'rotate(45deg)', opacity: 0.6 }} />
                    <div style={{ height: 1, width: 56, background: 'linear-gradient(to left, transparent, rgba(106,159,212,0.35))' }} />
                </div>
            </div>

            {/* ── Coverflow Carousel ── */}
            <CoverflowCarousel
                campaigns={campaigns}
                activeIdx={activeIdx}
                onActiveChange={setActiveIdx}
                onSelect={handleSelectCampaign}
                onEdit={openEdit}
                onDelete={id => setConfirmDelete(id)}
                onExport={handleExport}
                exportingId={isExporting}
                onNew={openCreate}
            />

            {/* ── Delete Confirmation ── */}
            {confirmDelete && (
                <Backdrop onClick={() => setConfirmDelete(null)}>
                    <div
                        style={{
                            background: 'var(--color-surface)', border: '1px solid rgba(192,57,43,0.4)',
                            borderRadius: 6, padding: '28px 28px 24px', maxWidth: 340, width: '100%',
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        <p style={{ color: 'var(--color-text-primary)', fontSize: 14, marginBottom: 20, lineHeight: 1.6, fontFamily: "'EB Garamond', serif" }}>
                            Delete this campaign? All data — chat history, lore, saves — will be lost forever.
                        </p>
                        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                            <GhostBtn onClick={() => setConfirmDelete(null)}>Cancel</GhostBtn>
                            <DangerBtn onClick={() => handleDelete(confirmDelete)}>Delete</DangerBtn>
                        </div>
                    </div>
                </Backdrop>
            )}

            {/* ── Create / Edit Modal ── */}
            {modalOpen && (
                <CampaignFormModal
                    editingCampaign={form.editingCampaign}
                    name={form.name}
                    setName={form.setName}
                    coverPreview={form.coverPreview}
                    handleCoverChange={form.handleCoverChange}
                    clearCover={form.clearCover}
                    loreName={form.loreName}
                    setLoreFile={form.setLoreFile}
                    setLoreName={form.setLoreName}
                    rulesName={form.rulesName}
                    setRulesFile={form.setRulesFile}
                    setRulesName={form.setRulesName}
                    handleSave={form.handleSave}
                    resetForm={form.resetForm}
                    onClose={() => setModalOpen(false)}
                />
            )}
        </div>
    );
}
