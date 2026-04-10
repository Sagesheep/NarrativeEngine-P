import { useState, useEffect, useCallback, useRef } from 'react';
import { Trash2, BookOpen, Pencil, Settings, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { GameContext } from '../types';
import {
    listCampaigns, deleteCampaign, loadCampaignState,
    saveCampaign, saveCampaignState, saveLoreChunks, getLoreChunks,
    getNPCLedger, loadArchiveIndex, saveNPCLedger, loadTimeline, loadEntities
} from '../store/campaignStore';
import { chunkLoreFile } from '../services/loreChunker';
import { API_BASE as API } from '../lib/apiBase';
import { extractEngineSeeds } from '../services/loreEngineSeeder';
import { parseNPCsFromLore } from '../services/loreNPCParser';
import {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT
} from '../store/slices/settingsSlice';
import { dedupeNPCLedger } from '../store/slices/campaignSlice';
import type { Campaign, EngineSeed } from '../types';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CONTEXT = {
    loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '',
    starter: '', continuePrompt: '', inventory: '', characterProfile: '',
    surpriseDC: 95, encounterDC: 198, worldEventDC: 498,
    canonStateActive: false, headerIndexActive: false, starterActive: false,
    continuePromptActive: false, inventoryActive: false, characterProfileActive: false,
    surpriseEngineActive: true, encounterEngineActive: true, worldEngineActive: true,
    diceFairnessActive: true, sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 3,
    worldVibe: '', enemyPlayerActive: false, neutralPlayerActive: false, allyPlayerActive: false,
    enemyPlayerPrompt: '', neutralPlayerPrompt: '', allyPlayerPrompt: '',
    interventionChance: 25, enemyCooldown: 2, neutralCooldown: 2, allyCooldown: 2,
    interventionQueue: [] as ('enemy' | 'neutral' | 'ally')[],
    worldEventConfig: { initialDC: 498, dcReduction: 2, who: [] as string[], where: [] as string[], why: [] as string[], what: [] as string[] },
};

const DEFAULT_CONDENSER = { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false };

// ─── Coverflow Card Positions ─────────────────────────────────────────────────

interface SlotStyle {
    x: number;
    rotateY: number;
    scale: number;
    zIndex: number;
    opacity: number;
    blur: number;
}

function getSlotStyle(offset: number): SlotStyle {
    const abs = Math.abs(offset);
    if (abs === 0) return { x: 0,             rotateY: 0,             scale: 1,    zIndex: 100, opacity: 1,    blur: 0 };
    if (abs === 1) return { x: offset * 230,   rotateY: -offset * 42, scale: 0.82, zIndex: 50,  opacity: 0.75, blur: 0 };
    if (abs === 2) return { x: offset * 290,   rotateY: -offset * 52, scale: 0.68, zIndex: 10,  opacity: 0.35, blur: 1 };
    return             { x: offset * 320,   rotateY: -offset * 60, scale: 0.55, zIndex: 0,   opacity: 0,    blur: 2 };
}

function timeAgo(ts: number | undefined): string {
    if (!ts) return 'Never played';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function CampaignHub() {
    const [campaigns, setCampaigns] = useState<Campaign[]>([]);
    const [activeIdx, setActiveIdx] = useState(0);
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
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

    // Touch/swipe
    const touchStartX = useRef(0);

    const refresh = useCallback(async () => {
        const list = await listCampaigns();
        const valid = list.filter(c => c && c.id && c.name && c.id !== 'undefined');
        setCampaigns(valid);
        setActiveIdx(prev => Math.min(prev, Math.max(valid.length - 1, 0)));
    }, []);

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

    const resetForm = () => {
        setName(''); setCoverFile(null); setCoverPreview('');
        setLoreFile(null); setLoreName('');
        setRulesFile(null); setRulesName('');
        setEditingCampaign(null);
    };

    const openCreate = () => { resetForm(); setModalOpen(true); };

    const openEdit = (campaign: Campaign) => {
        setEditingCampaign(campaign);
        setName(campaign.name);
        setCoverPreview(campaign.coverImage || '');
        setLoreName(''); setRulesName('');
        setLoreFile(null); setRulesFile(null); setCoverFile(null);
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
                name: name.trim(), coverImage: '',
                createdAt: Date.now(), lastPlayedAt: Date.now(),
            };

        if (coverFile) campaign.coverImage = coverPreview;
        else if (isEdit) campaign.coverImage = coverPreview;

        await saveCampaign(campaign);

        let seeds: EngineSeed | null = null;
        if (loreFile) {
            const loreText = await loreFile.text();
            const chunks = chunkLoreFile(loreText);
            await saveLoreChunks(campaign.id, chunks);
            const parsedNPCs = parseNPCsFromLore(chunks);
            if (parsedNPCs.length > 0) {
                const existingNPCs = await getNPCLedger(campaign.id);
                await saveNPCLedger(campaign.id, dedupeNPCLedger([...existingNPCs, ...parsedNPCs]));
            }
            seeds = extractEngineSeeds(chunks);
        }

        const existingState = await loadCampaignState(campaign.id);
        if (!existingState || rulesFile || seeds) {
            const ctx = { ...DEFAULT_CONTEXT, ...(existingState?.context ?? {}) } as GameContext;
            if (rulesFile) ctx.rulesRaw = await rulesFile.text();
            if (seeds) {
                ctx.surpriseConfig = {
                    ...ctx.surpriseConfig, initialDC: ctx.surpriseConfig?.initialDC ?? 95,
                    dcReduction: ctx.surpriseConfig?.dcReduction ?? 3,
                    types: seeds.surpriseTypes.length > 0 ? seeds.surpriseTypes : [...DEFAULT_SURPRISE_TYPES],
                    tones: seeds.surpriseTones.length > 0 ? seeds.surpriseTones : [...DEFAULT_SURPRISE_TONES],
                };
                ctx.encounterConfig = {
                    ...ctx.encounterConfig, initialDC: ctx.encounterConfig?.initialDC ?? 198,
                    dcReduction: ctx.encounterConfig?.dcReduction ?? 2,
                    types: seeds.encounterTypes.length > 0 ? seeds.encounterTypes : [...DEFAULT_ENCOUNTER_TYPES],
                    tones: seeds.encounterTones.length > 0 ? seeds.encounterTones : [...DEFAULT_ENCOUNTER_TONES],
                };
                ctx.worldEventConfig = {
                    ...ctx.worldEventConfig, initialDC: ctx.worldEventConfig?.initialDC ?? 498,
                    dcReduction: ctx.worldEventConfig?.dcReduction ?? 2,
                    who: seeds.worldWho.length > 0 ? seeds.worldWho : [...DEFAULT_WORLD_WHO],
                    where: seeds.worldWhere.length > 0 ? seeds.worldWhere : [...DEFAULT_WORLD_WHERE],
                    why: seeds.worldWhy.length > 0 ? seeds.worldWhy : [...DEFAULT_WORLD_WHY],
                    what: seeds.worldWhat.length > 0 ? seeds.worldWhat : [...DEFAULT_WORLD_WHAT],
                };
            }
            await saveCampaignState(campaign.id, {
                context: { ...DEFAULT_CONTEXT, ...ctx }, messages: existingState?.messages ?? [],
                condenser: { ...(existingState?.condenser ?? DEFAULT_CONDENSER), isCondensing: false },
            });
        }

        setModalOpen(false);
        resetForm();
        refresh();
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

    const navigate = (dir: number) => {
        if (campaigns.length === 0) return;
        setActiveIdx(prev => (prev + dir + campaigns.length) % campaigns.length);
    };

    const activeCampaign = campaigns[activeIdx] ?? null;

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

            {/* ── Coverflow Stage ── */}
            {campaigns.length === 0 ? (
                <EmptyState onNew={openCreate} />
            ) : (
                <>
                    <div
                        style={{
                            position: 'relative', width: '100%', height: 360,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            perspective: '1200px', zIndex: 2,
                        }}
                        onTouchStart={e => { touchStartX.current = e.touches[0].clientX; }}
                        onTouchEnd={e => {
                            const dx = e.changedTouches[0].clientX - touchStartX.current;
                            if (Math.abs(dx) > 40) navigate(dx < 0 ? 1 : -1);
                        }}
                    >
                        {/* Render cards back-to-front so active is on top */}
                        {[...campaigns]
                            .map((c, i) => ({ c, i, offset: i - activeIdx }))
                            .sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset))
                            .map(({ c, i, offset }) => {
                                const s = getSlotStyle(offset);
                                const isActive = i === activeIdx;
                                return (
                                    <CoverCard
                                        key={c.id}
                                        campaign={c}
                                        isActive={isActive}
                                        slotStyle={s}
                                        onClick={() => { if (!isActive) setActiveIdx(i); }}
                                        onEdit={e => { e.stopPropagation(); openEdit(c); }}
                                        onDelete={e => { e.stopPropagation(); setConfirmDelete(c.id); }}
                                    />
                                );
                            })
                        }
                    </div>

                    {/* Nav */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 24, marginTop: 32, position: 'relative', zIndex: 2 }}>
                        <NavBtn onClick={() => navigate(-1)} disabled={campaigns.length <= 1}>
                            <ChevronLeft size={16} />
                        </NavBtn>

                        <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                            {campaigns.map((_, i) => (
                                <div
                                    key={i}
                                    onClick={() => setActiveIdx(i)}
                                    style={{
                                        height: 5, cursor: 'pointer',
                                        width: i === activeIdx ? 18 : 5,
                                        borderRadius: i === activeIdx ? 3 : '50%',
                                        background: i === activeIdx ? '#D47E30' : 'rgba(212,126,48,0.25)',
                                        transition: 'all 0.3s ease',
                                    }}
                                />
                            ))}
                        </div>

                        <NavBtn onClick={() => navigate(1)} disabled={campaigns.length <= 1}>
                            <ChevronRight size={16} />
                        </NavBtn>
                    </div>

                    {/* Enter button */}
                    {activeCampaign && (
                        <button
                            onClick={() => handleSelectCampaign(activeCampaign)}
                            style={{
                                marginTop: 28, zIndex: 2, position: 'relative',
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: 10, letterSpacing: '0.3em',
                                textTransform: 'uppercase', color: '#D47E30',
                                background: 'transparent',
                                border: '1px solid rgba(212,126,48,0.35)',
                                borderRadius: 3, padding: '11px 32px',
                                cursor: 'pointer', transition: 'all 0.25s',
                            }}
                            onMouseEnter={e => {
                                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(212,126,48,0.1)';
                                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(212,126,48,0.7)';
                            }}
                            onMouseLeave={e => {
                                (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(212,126,48,0.35)';
                            }}
                        >
                            Enter — {activeCampaign.name}
                        </button>
                    )}

                    {/* New campaign ghost link */}
                    <div
                        onClick={openCreate}
                        style={{
                            marginTop: 16, zIndex: 2, position: 'relative',
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 9, letterSpacing: '0.22em',
                            textTransform: 'uppercase',
                            color: 'rgba(140,120,90,0.4)',
                            cursor: 'pointer', transition: 'color 0.2s',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.color = 'rgba(212,126,48,0.6)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.color = 'rgba(140,120,90,0.4)'; }}
                    >
                        + New Campaign
                    </div>
                </>
            )}

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
                <Backdrop onClick={() => { setModalOpen(false); resetForm(); }}>
                    <div
                        style={{
                            background: '#1A1525', border: '1px solid rgba(212,126,48,0.2)',
                            borderRadius: 6, padding: '28px', width: '100%', maxWidth: 420,
                            maxHeight: '90vh', overflowY: 'auto',
                        }}
                        onClick={e => e.stopPropagation()}
                    >
                        <h2 style={{
                            fontFamily: "'Cinzel', serif", fontSize: 13,
                            letterSpacing: '0.2em', textTransform: 'uppercase',
                            color: '#D47E30', marginBottom: 24,
                        }}>
                            {editingCampaign ? 'Edit Campaign' : 'New Campaign'}
                        </h2>

                        <ModalLabel>Campaign Name</ModalLabel>
                        <input
                            type="text" value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="e.g. Iron Crown Chronicles"
                            autoFocus
                            style={{
                                width: '100%', background: '#0E0D1A',
                                border: '1px solid rgba(212,126,48,0.2)',
                                borderRadius: 4, padding: '9px 12px',
                                fontSize: 13, color: '#E6DCC8',
                                fontFamily: "'EB Garamond', serif",
                                marginBottom: 20, outline: 'none',
                                boxSizing: 'border-box',
                            }}
                        />

                        <ModalLabel>Cover Image</ModalLabel>
                        <div style={{ marginBottom: 20 }}>
                            {coverPreview ? (
                                <div style={{ position: 'relative', height: 110, borderRadius: 4, overflow: 'hidden', border: '1px solid rgba(212,126,48,0.2)' }}>
                                    <img src={coverPreview} alt="Cover" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                    <button
                                        onClick={() => { setCoverFile(null); setCoverPreview(''); }}
                                        style={{
                                            position: 'absolute', top: 6, right: 6,
                                            background: 'rgba(14,13,26,0.85)', border: '1px solid rgba(192,57,43,0.4)',
                                            borderRadius: 3, color: '#C0392B', padding: '3px 6px', cursor: 'pointer', fontSize: 10,
                                        }}
                                    >
                                        <Trash2 size={11} />
                                    </button>
                                </div>
                            ) : (
                                <label style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    height: 72, border: '1px dashed rgba(212,126,48,0.25)',
                                    borderRadius: 4, cursor: 'pointer',
                                    color: 'rgba(140,120,90,0.5)', fontSize: 12,
                                    fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.1em',
                                    transition: 'border-color 0.2s, color 0.2s',
                                }}>
                                    Click to upload image
                                    <input type="file" accept="image/*" style={{ display: 'none' }}
                                        onChange={e => e.target.files?.[0] && handleCoverChange(e.target.files[0])} />
                                </label>
                            )}
                        </div>

                        <ModalLabel>
                            World Lore (.md){editingCampaign && <span style={{ color: 'rgba(140,120,90,0.4)', fontWeight: 400, marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>— re-upload to replace</span>}
                        </ModalLabel>
                        <FilePickerRow icon={<BookOpen size={13} />} label={loreName || 'Choose file…'} accept=".md,.txt"
                            onChange={f => { setLoreFile(f); setLoreName(f.name); }} />
                        <p style={{ color: 'rgba(140,120,90,0.45)', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", marginBottom: 20, marginTop: 6 }}>
                            Split by ### headers for dynamic RAG retrieval
                        </p>

                        <ModalLabel>
                            Rules (.md){editingCampaign && <span style={{ color: 'rgba(140,120,90,0.4)', fontWeight: 400, marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>— re-upload to replace</span>}
                        </ModalLabel>
                        <FilePickerRow icon={<BookOpen size={13} />} label={rulesName || 'Choose file…'} accept=".md,.txt"
                            onChange={f => { setRulesFile(f); setRulesName(f.name); }} />

                        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 28 }}>
                            <GhostBtn onClick={() => { setModalOpen(false); resetForm(); }}>Cancel</GhostBtn>
                            <PrimaryBtn onClick={handleSave} disabled={!name.trim()}>
                                {editingCampaign ? 'Save Changes' : 'Create & Enter'}
                            </PrimaryBtn>
                        </div>
                    </div>
                </Backdrop>
            )}
        </div>
    );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function CoverCard({ campaign, isActive, slotStyle, onClick, onEdit, onDelete }: {
    campaign: Campaign;
    isActive: boolean;
    slotStyle: SlotStyle;
    onClick: () => void;
    onEdit: (e: React.MouseEvent) => void;
    onDelete: (e: React.MouseEvent) => void;
}) {
    const [hovered, setHovered] = useState(false);

    return (
        <div
            onClick={onClick}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={{
                position: 'absolute',
                width: 200, height: 300,
                transform: `translateX(${slotStyle.x}px) rotateY(${slotStyle.rotateY}deg) scale(${slotStyle.scale})`,
                opacity: slotStyle.opacity,
                zIndex: slotStyle.zIndex,
                filter: slotStyle.blur > 0 ? `blur(${slotStyle.blur}px)` : 'none',
                transition: 'transform 0.5s cubic-bezier(0.4,0,0.2,1), opacity 0.5s ease, filter 0.5s ease',
                cursor: isActive ? 'default' : 'pointer',
                transformStyle: 'preserve-3d',
            }}
        >
            <div style={{
                width: '100%', height: '100%', borderRadius: 8, overflow: 'hidden',
                position: 'relative',
                boxShadow: isActive
                    ? '0 0 0 1px rgba(212,126,48,0.45), 0 24px 80px rgba(0,0,0,0.7), 0 4px 20px rgba(212,126,48,0.15)'
                    : '0 20px 60px rgba(0,0,0,0.6), 0 4px 16px rgba(0,0,0,0.4)',
                transition: 'box-shadow 0.4s ease',
            }}>
                {/* Cover image or placeholder */}
                {campaign.coverImage ? (
                    <img
                        src={campaign.coverImage} alt={campaign.name}
                        style={{
                            width: '100%', height: '100%', objectFit: 'cover', display: 'block',
                            transition: 'transform 0.5s ease',
                            transform: isActive && hovered ? 'scale(1.04)' : 'scale(1)',
                        }}
                    />
                ) : (
                    <div style={{
                        width: '100%', height: '100%', background: '#1A1525',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                        <BookOpen size={40} style={{ color: '#D47E30', opacity: 0.15 }} />
                    </div>
                )}

                {/* Gradient overlay */}
                <div style={{
                    position: 'absolute', inset: 0,
                    background: 'linear-gradient(to top, rgba(8,6,18,0.97) 0%, rgba(8,6,18,0.55) 45%, rgba(8,6,18,0.1) 75%, transparent 100%)',
                    display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
                    padding: '20px 18px 18px', borderRadius: 8,
                }} >
                    {/* Content fades in only when active */}
                    <div style={{
                        opacity: isActive ? 1 : 0,
                        transform: isActive ? 'translateY(0)' : 'translateY(6px)',
                        transition: 'opacity 0.4s ease 0.15s, transform 0.4s ease 0.15s',
                    }}>
                        <div style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 8.5, letterSpacing: '0.2em',
                            textTransform: 'uppercase', color: '#D47E30',
                            marginBottom: 7, opacity: 0.85,
                        }}>
                            {timeAgo(campaign.lastPlayedAt)}
                        </div>
                        <div style={{
                            fontFamily: "'Cinzel', serif", fontSize: 14,
                            fontWeight: 600, color: '#F0E8D8',
                            lineHeight: 1.25, marginBottom: 8, letterSpacing: '0.03em',
                        }}>
                            {campaign.name}
                        </div>
                        {/* Genre tag placeholder — campaigns don't have genre field, show last-played */}
                        <div style={{
                            fontFamily: "'EB Garamond', serif", fontStyle: 'italic',
                            fontSize: 12.5, color: 'rgba(200,185,160,0.7)', lineHeight: 1.55,
                        }}>
                            Click to enter this world
                        </div>
                    </div>
                </div>

                {/* Edit / Delete — only on active card hover */}
                {isActive && (
                    <div style={{
                        position: 'absolute', top: 10, right: 10,
                        display: 'flex', gap: 5,
                        opacity: hovered ? 1 : 0,
                        transition: 'opacity 0.2s ease',
                    }}>
                        <ActionBtn onClick={onEdit} title="Edit"><Pencil size={11} /></ActionBtn>
                        <ActionBtn onClick={onDelete} title="Delete" danger><Trash2 size={11} /></ActionBtn>
                    </div>
                )}
            </div>
        </div>
    );
}

function EmptyState({ onNew }: { onNew: () => void }) {
    return (
        <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
            padding: '48px 24px', zIndex: 2, position: 'relative',
        }}>
            <div style={{
                width: 72, height: 72, borderRadius: '50%',
                border: '1px dashed rgba(212,126,48,0.3)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'rgba(212,126,48,0.35)',
            }}>
                <BookOpen size={28} />
            </div>
            <p style={{
                color: 'rgba(180,160,130,0.4)', fontStyle: 'italic', fontSize: 15,
                textAlign: 'center', maxWidth: 260,
            }}>
                No campaigns yet. Begin your first chronicle.
            </p>
            <button
                onClick={onNew}
                style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10, letterSpacing: '0.3em',
                    textTransform: 'uppercase', color: '#D47E30',
                    background: 'transparent',
                    border: '1px solid rgba(212,126,48,0.35)',
                    borderRadius: 3, padding: '11px 32px',
                    cursor: 'pointer', marginTop: 8,
                }}
            >
                + New Campaign
            </button>
        </div>
    );
}

// ── Small reusable primitives ─────────────────────────────────────────────────

function NavBtn({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
    return (
        <button
            onClick={onClick} disabled={disabled}
            style={{
                width: 38, height: 38, borderRadius: '50%',
                border: '1px solid rgba(212,126,48,0.25)',
                background: 'rgba(255,255,255,0.04)',
                color: disabled ? 'rgba(212,126,48,0.2)' : 'rgba(212,126,48,0.6)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: disabled ? 'default' : 'pointer',
                transition: 'all 0.2s',
            }}
        >
            {children}
        </button>
    );
}

function ActionBtn({ onClick, title, danger, children }: {
    onClick: (e: React.MouseEvent) => void;
    title: string;
    danger?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            onClick={onClick} title={title}
            style={{
                width: 26, height: 26, borderRadius: 3,
                background: 'rgba(14,13,26,0.85)',
                border: `1px solid ${danger ? 'rgba(192,57,43,0.3)' : 'rgba(212,126,48,0.2)'}`,
                color: danger ? '#C0392B' : 'rgba(180,160,130,0.6)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', backdropFilter: 'blur(4px)',
            }}
        >
            {children}
        </button>
    );
}

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

function ModalLabel({ children }: { children: React.ReactNode }) {
    return (
        <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9, letterSpacing: '0.25em',
            textTransform: 'uppercase', color: 'rgba(140,120,90,0.6)',
            marginBottom: 8,
        }}>
            {children}
        </div>
    );
}

function FilePickerRow({ icon, label, accept, onChange }: {
    icon: React.ReactNode;
    label: string;
    accept: string;
    onChange: (f: File) => void;
}) {
    return (
        <label style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '9px 12px', background: '#0E0D1A',
            border: '1px solid rgba(212,126,48,0.2)', borderRadius: 4,
            cursor: 'pointer', transition: 'border-color 0.2s',
        }}>
            <span style={{ color: 'rgba(140,120,90,0.5)' }}>{icon}</span>
            <span style={{ fontSize: 12, color: 'rgba(140,120,90,0.55)', fontFamily: "'JetBrains Mono', monospace" }}>
                {label}
            </span>
            <input type="file" accept={accept} style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) onChange(f); }} />
        </label>
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

function PrimaryBtn({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
    return (
        <button onClick={onClick} disabled={disabled} style={{
            padding: '8px 20px', fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.15em',
            textTransform: 'uppercase',
            color: disabled ? 'rgba(212,126,48,0.3)' : '#0E0D1A',
            background: disabled ? 'transparent' : '#D47E30',
            border: `1px solid ${disabled ? 'rgba(212,126,48,0.2)' : '#D47E30'}`,
            borderRadius: 3, cursor: disabled ? 'not-allowed' : 'pointer',
            transition: 'all 0.2s', fontWeight: 600,
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
