import { User, Trash2, CheckSquare, Square, RotateCcw } from 'lucide-react';
import type { NPCEntry } from '../../types';

type Props = {
    npcLedger: NPCEntry[];
    selectedId: string | null;
    selectMode: boolean;
    checkedIds: Set<string>;
    onSelect: (npc: NPCEntry) => void;
    onToggleCheck: (id: string) => void;
    onDelete: (id: string, e: React.MouseEvent) => void;
    onRestore?: (id: string) => void;
};

export function NPCGalleryView({ npcLedger, selectedId, selectMode, checkedIds, onSelect, onToggleCheck, onDelete, onRestore }: Props) {
    const activeNpcs = npcLedger.filter(npc => !npc.archived);
    const archivedNpcs = npcLedger.filter(npc => npc.archived);

    // Columns come from the container's real width, not the viewport: this grid lives in a
    // fixed-width sidebar, so viewport breakpoints made cards *narrower* on bigger screens.
    return (
        <div className="flex-1 overflow-y-auto p-4 grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3 content-start">
            {activeNpcs.length === 0 && archivedNpcs.length === 0 && (
                <p className="text-text-dim text-xs text-center p-4 italic opacity-50 col-span-full">No records found.</p>
            )}
            {activeNpcs.map(npc => {
                const isActive = selectedId === npc.id;
                const isChecked = checkedIds.has(npc.id);
                return (
                    <div
                        key={npc.id}
                        onClick={() => selectMode ? onToggleCheck(npc.id) : onSelect(npc)}
                        className={`relative aspect-[3/4] rounded overflow-hidden cursor-pointer border group transition-all ${isActive ? 'border-terminal ring-1 ring-terminal shadow-[0_0_15px_rgba(0,255,0,0.15)]' : isChecked ? 'border-terminal/50 ring-1 ring-terminal/30' : 'border-border hover:border-terminal/50'}`}
                    >
                        {npc.portrait ? (
                            <img src={npc.portrait} alt={npc.name} className="w-full h-full object-cover transition-transform group-hover:scale-105" />
                        ) : (
                            <div className="w-full h-full bg-void-lighter flex flex-col items-center justify-center gap-2">
                                <User size={32} className="text-text-dim/30" />
                                <span className="text-[10px] text-text-dim/50 uppercase tracking-widest">No Portrait</span>
                            </div>
                        )}
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-void via-void/80 to-transparent p-3 pt-8">
                            <p className={`text-xs font-bold leading-tight line-clamp-2 break-words ${isActive ? 'text-terminal glow-green-sm' : 'text-text-primary'}`}>{npc.name}</p>
                            {npc.faction && (
                                <div className="flex flex-wrap gap-1 mt-0.5">
                                    {npc.faction.split(/[,;/]/).map(f => f.trim()).filter(Boolean).map((fac, idx) => (
                                        <span key={idx} className="bg-terminal/10 text-terminal text-[9px] px-1 rounded uppercase truncate max-w-full">
                                            {fac}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                        {selectMode ? (
                            <div className="absolute top-2 left-2 p-1 bg-void/80 rounded" onClick={(e) => { e.stopPropagation(); onToggleCheck(npc.id); }}>
                                {isChecked ? <CheckSquare size={14} className="text-terminal" /> : <Square size={14} className="text-text-dim" />}
                            </div>
                        ) : (
                            <button
                                onClick={(e) => onDelete(npc.id, e)}
                                className="absolute top-2 right-2 p-1.5 bg-void/80 rounded text-text-dim hover:text-danger hover:bg-danger/20 transition-all opacity-0 group-hover:opacity-100 flex items-center justify-center"
                            >
                                <Trash2 size={12} />
                            </button>
                        )}
                    </div>
                );
            })}
            {archivedNpcs.length > 0 && (
                <>
                    <div className="col-span-full text-[10px] text-text-dim uppercase tracking-wider mt-2">Archived</div>
                    {archivedNpcs.map(npc => {
                        const isChecked = checkedIds.has(npc.id);
                        return (
                            <div
                                key={npc.id}
                                onClick={() => selectMode ? onToggleCheck(npc.id) : onSelect(npc)}
                                className={`relative aspect-[3/4] rounded overflow-hidden cursor-pointer border group transition-all opacity-40 hover:opacity-60 ${isChecked ? 'border-terminal/50 ring-1 ring-terminal/30' : 'border-border hover:border-terminal/50'}`}
                            >
                                {npc.portrait ? (
                                    <img src={npc.portrait} alt={npc.name} className="w-full h-full object-cover" />
                                ) : (
                                    <div className="w-full h-full bg-void-lighter flex flex-col items-center justify-center gap-2">
                                        <User size={32} className="text-text-dim/20" />
                                        <span className="text-[10px] text-text-dim/40 uppercase tracking-widest">Archived</span>
                                    </div>
                                )}
                                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-void via-void/80 to-transparent p-3 pt-8">
                                    <p className="text-xs font-bold leading-tight line-clamp-2 break-words text-text-dim line-through">{npc.name}</p>
                                </div>
                                {onRestore && !selectMode && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onRestore(npc.id); }}
                                        className="absolute top-2 right-2 p-1.5 bg-void/80 rounded text-text-dim hover:text-terminal hover:bg-terminal/20 transition-all opacity-0 group-hover:opacity-100 flex items-center justify-center"
                                        title="Restore NPC"
                                    >
                                        <RotateCcw size={12} />
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </>
            )}
        </div>
    );
}
