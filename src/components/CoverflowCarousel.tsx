import { useState, useRef } from 'react';
import { BookOpen, Pencil, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Campaign } from '../types';

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

export interface CoverflowCarouselProps {
    campaigns: Campaign[];
    activeIdx: number;
    onActiveChange: (idx: number) => void;
    onSelect: (campaign: Campaign) => void;
    onEdit: (campaign: Campaign) => void;
    onDelete: (id: string) => void;
    onNew: () => void;
}

export function CoverflowCarousel({
    campaigns, activeIdx, onActiveChange, onSelect, onEdit, onDelete, onNew,
}: CoverflowCarouselProps) {
    const touchStartX = useRef(0);

    const navigate = (dir: number) => {
        if (campaigns.length === 0) return;
        const next = (activeIdx + dir + campaigns.length) % campaigns.length;
        onActiveChange(next);
    };

    const activeCampaign = campaigns[activeIdx] ?? null;

    if (campaigns.length === 0) {
        return <EmptyState onNew={onNew} />;
    }

    return (
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
                                onClick={() => { if (!isActive) onActiveChange(i); }}
                                onEdit={e => { e.stopPropagation(); onEdit(c); }}
                                onDelete={e => { e.stopPropagation(); onDelete(c.id); }}
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
                            onClick={() => onActiveChange(i)}
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
                    onClick={() => onSelect(activeCampaign)}
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
                onClick={onNew}
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
    );
}

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

                <div style={{
                    position: 'absolute', inset: 0,
                    background: 'linear-gradient(to top, rgba(8,6,18,0.97) 0%, rgba(8,6,18,0.55) 45%, rgba(8,6,18,0.1) 75%, transparent 100%)',
                    display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
                    padding: '20px 18px 18px', borderRadius: 8,
                }} >
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
                        <div style={{
                            fontFamily: "'EB Garamond', serif", fontStyle: 'italic',
                            fontSize: 12.5, color: 'rgba(200,185,160,0.7)', lineHeight: 1.55,
                        }}>
                            Click to enter this world
                        </div>
                    </div>
                </div>

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
