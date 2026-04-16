import { Trash2, BookOpen } from 'lucide-react';
import type { Campaign } from '../types';
import { Backdrop } from './primitives/Backdrop';
import { GhostBtn, PrimaryBtn } from './primitives/Buttons';

export interface CampaignFormModalProps {
    editingCampaign: Campaign | null;
    name: string;
    setName: (v: string) => void;
    coverPreview: string;
    handleCoverChange: (file: File) => void;
    clearCover: () => void;
    loreName: string;
    setLoreFile: (f: File) => void;
    setLoreName: (v: string) => void;
    rulesName: string;
    setRulesFile: (f: File) => void;
    setRulesName: (v: string) => void;
    handleSave: () => void;
    resetForm: () => void;
    onClose: () => void;
}

export function CampaignFormModal(props: CampaignFormModalProps) {
    const {
        editingCampaign, name, setName,
        coverPreview, handleCoverChange, clearCover,
        loreName, setLoreFile, setLoreName,
        rulesName, setRulesFile, setRulesName,
        handleSave, resetForm, onClose,
    } = props;

    const close = () => { onClose(); resetForm(); };

    return (
        <Backdrop onClick={close}>
            <div
                style={{
                    background: 'var(--color-surface)', border: '1px solid rgba(106,159,212,0.20)',
                    borderRadius: 6, padding: '28px', width: '100%', maxWidth: 420,
                    maxHeight: '90vh', overflowY: 'auto',
                }}
                onClick={e => e.stopPropagation()}
            >
                <h2 style={{
                    fontFamily: "'Cinzel', serif", fontSize: 13,
                    letterSpacing: '0.2em', textTransform: 'uppercase',
                    color: 'var(--color-terminal)', marginBottom: 24,
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
                        width: '100%', background: 'var(--color-void-lighter)',
                        border: '1px solid rgba(106,159,212,0.20)',
                        borderRadius: 4, padding: '9px 12px',
                        fontSize: 13, color: 'var(--color-text-primary)',
                        fontFamily: "'EB Garamond', serif",
                        marginBottom: 20, outline: 'none',
                        boxSizing: 'border-box',
                    }}
                />

                <ModalLabel>Cover Image</ModalLabel>
                <div style={{ marginBottom: 20 }}>
                    {coverPreview ? (
                        <div style={{ position: 'relative', height: 110, borderRadius: 4, overflow: 'hidden', border: '1px solid rgba(106,159,212,0.20)' }}>
                            <img src={coverPreview} alt="Cover" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                            <button
                                onClick={clearCover}
                                style={{
                                    position: 'absolute', top: 6, right: 6,
                                    background: 'rgba(0,0,0,0.70)', border: '1px solid rgba(192,57,43,0.4)',
                                    borderRadius: 3, color: 'var(--color-danger)', padding: '3px 6px', cursor: 'pointer', fontSize: 10,
                                }}
                            >
                                <Trash2 size={11} />
                            </button>
                        </div>
                    ) : (
                        <label style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            height: 72, border: '1px dashed rgba(106,159,212,0.25)',
                            borderRadius: 4, cursor: 'pointer',
                            color: 'rgba(107,107,107,0.55)', fontSize: 12,
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
                    World Lore (.md){editingCampaign && <span style={{ color: 'rgba(107,107,107,0.45)', fontWeight: 400, marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>— re-upload to replace</span>}
                </ModalLabel>
                <FilePickerRow icon={<BookOpen size={13} />} label={loreName || 'Choose file…'} accept=".md,.txt"
                    onChange={f => { setLoreFile(f); setLoreName(f.name); }} />
                <p style={{ color: 'rgba(107,107,107,0.50)', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", marginBottom: 20, marginTop: 6 }}>
                    Split by ### headers for dynamic RAG retrieval
                </p>

                <ModalLabel>
                    Rules (.md){editingCampaign && <span style={{ color: 'rgba(107,107,107,0.45)', fontWeight: 400, marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>— re-upload to replace</span>}
                </ModalLabel>
                <FilePickerRow icon={<BookOpen size={13} />} label={rulesName || 'Choose file…'} accept=".md,.txt"
                    onChange={f => { setRulesFile(f); setRulesName(f.name); }} />

                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 28 }}>
                    <GhostBtn onClick={close}>Cancel</GhostBtn>
                    <PrimaryBtn onClick={handleSave} disabled={!name.trim()}>
                        {editingCampaign ? 'Save Changes' : 'Create & Enter'}
                    </PrimaryBtn>
                </div>
            </div>
        </Backdrop>
    );
}

function ModalLabel({ children }: { children: React.ReactNode }) {
    return (
        <div style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9, letterSpacing: '0.25em',
            textTransform: 'uppercase', color: 'rgba(107,107,107,0.65)',
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
            padding: '9px 12px', background: 'var(--color-void-lighter)',
            border: '1px solid rgba(106,159,212,0.20)', borderRadius: 4,
            cursor: 'pointer', transition: 'border-color 0.2s',
        }}>
            <span style={{ color: 'rgba(107,107,107,0.55)' }}>{icon}</span>
            <span style={{ fontSize: 12, color: 'rgba(107,107,107,0.60)', fontFamily: "'JetBrains Mono', monospace" }}>
                {label}
            </span>
            <input type="file" accept={accept} style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) onChange(f); }} />
        </label>
    );
}
