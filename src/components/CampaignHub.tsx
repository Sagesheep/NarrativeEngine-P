import { useState, useEffect, useCallback } from 'react';
import { Settings } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { GameContext } from '../types';
import {
    listCampaigns, deleteCampaign, loadCampaignState,
    saveCampaign, getLoreChunks,
    getNPCLedger, loadArchiveIndex, loadTimeline, loadEntities
} from '../store/campaignStore';
import { API_BASE as API } from '../lib/apiBase';
import { DEFAULT_CONTEXT, DEFAULT_CONDENSER } from '../services/campaignInit';
import type { Campaign } from '../types';
import { useCampaignForm } from './hooks/useCampaignForm';
import { CampaignFormModal } from './CampaignFormModal';
import { CoverflowCarousel } from './CoverflowCarousel';

export function CampaignHub() {
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [activeIdx, setActiveIdx] = useState(0);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
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
        const updatedCampaign = { ...campaign, lastPlayedAt: Date.now() };
        await saveCampaign(updatedCampaign);
        const [state, chunks, npcs, archiveIndex, timeline, entities] = await Promise.all([
            loadCampaignState(campaign.id), getLoreChunks(campaign.id),
            getNPCLedger(campaign.id), loadArchiveIndex(campaign.id), loadTimeline(campaign.id),
            loadEntities(campaign.id),
        ]);
        useAppStore.setState({
            context: { ...DEFAULT_CONTEXT, ...(state?.context ?? {}) } as GameContext,
            messages: state?.messages ?? [],
            condenser: { ...(state?.condenser ?? DEFAULT_CONDENSER), isCondensing: false },
            loreChunks: chunks, npcLedger: npcs, archiveIndex, timeline, entities,
            activeCampaignId: campaign.id,
        });
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
                background: '#0E0D1A',
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
                background: 'radial-gradient(ellipse 70% 50% at 50% 65%, rgba(212,126,48,0.12) 0%, transparent 70%)',
            }} />

            {/* Settings button */}
            <button
                onClick={() => useAppStore.getState().toggleSettings()}
                title="Settings"
                style={{
                    position: 'absolute', top: 20, right: 20,
                    width: 36, height: 36, borderRadius: '50%',
                    border: '1px solid rgba(212,126,48,0.2)',
                    background: 'rgba(255,255,255,0.04)',
                    color: 'rgba(140,120,90,0.5)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'pointer', zIndex: 10, transition: 'all 0.2s',
                }}
                onMouseEnter={e => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(212,126,48,0.6)';
                    (e.currentTarget as HTMLButtonElement).style.color = '#D47E30';
                }}
                onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(212,126,48,0.2)';
                    (e.currentTarget as HTMLButtonElement).style.color = 'rgba(140,120,90,0.5)';
                }}
            >
                <Settings size={15} />
            </button>

            {/* Hero text */}
            <div style={{ textAlign: 'center', marginBottom: 44, position: 'relative', zIndex: 2 }}>
                <div style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10, letterSpacing: '0.4em',
                    textTransform: 'uppercase', color: 'rgba(212,126,48,0.65)',
                    marginBottom: 10,
                }}>
                    AI Game Master System
                </div>
                <h1 style={{
                    fontFamily: "'Cinzel', 'Times New Roman', serif",
                    fontSize: 36, fontWeight: 700,
                    color: '#E6DCC8', letterSpacing: '0.08em',
                    margin: '0 0 10px', lineHeight: 1,
                }}>
                    Narrative{' '}
                    <span style={{ color: '#D47E30' }}>Nexus</span>
                </h1>
                <p style={{
                    fontStyle: 'italic', fontSize: 15,
                    color: 'rgba(180,160,130,0.45)', letterSpacing: '0.02em',
                }}>
                    Choose your world. Shape its fate.
                </p>
                {/* Divider */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18, justifyContent: 'center' }}>
                    <div style={{ height: 1, width: 56, background: 'linear-gradient(to right, transparent, rgba(212,126,48,0.35))' }} />
                    <div style={{ width: 5, height: 5, background: '#D47E30', transform: 'rotate(45deg)', opacity: 0.6 }} />
                    <div style={{ height: 1, width: 56, background: 'linear-gradient(to left, transparent, rgba(212,126,48,0.35))' }} />
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
                onNew={openCreate}
            />

            {/* ── Delete Confirmation ── */}
            {confirmDelete && (
                <Backdrop onClick={() => setConfirmDelete(null)}>
                    <div
                        style={{
                            background: '#1A1525', border: '1px solid rgba(192,57,43,0.4)',
                            borderRadius: 6, padding: '28px 28px 24px', maxWidth: 340, width: '100%',
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        <p style={{ color: '#E6DCC8', fontSize: 14, marginBottom: 20, lineHeight: 1.6, fontFamily: "'EB Garamond', serif" }}>
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

// ── Small primitives (delete dialog) ──────────────────────────────────────────

function Backdrop({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
    return (
        <div
            onClick={onClick}
            style={{
                position: 'fixed', inset: 0, zIndex: 50,
                background: 'rgba(0,0,0,0.65)',
                backdropFilter: 'blur(4px)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '20px',
            }}
        >
            {children}
        </div>
    );
}

function GhostBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
    return (
        <button onClick={onClick} style={{
            padding: '8px 18px', fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em',
            color: 'rgba(140,120,90,0.6)', background: 'transparent',
            border: '1px solid rgba(212,126,48,0.15)', borderRadius: 3,
            cursor: 'pointer', transition: 'all 0.2s',
        }}>
            {children}
        </button>
    );
}

function DangerBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
    return (
        <button onClick={onClick} style={{
            padding: '8px 20px', fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.15em',
            textTransform: 'uppercase',
            color: '#0E0D1A', background: '#C0392B',
            border: '1px solid #C0392B',
            borderRadius: 3, cursor: 'pointer',
            transition: 'all 0.2s', fontWeight: 600,
        }}>
            {children}
        </button>
    );
}
