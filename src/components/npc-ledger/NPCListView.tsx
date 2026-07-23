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

export function NPCListView({ npcLedger, selectedId, selectMode, checkedIds, onSelect, onToggleCheck, onDelete, onRestore }: Props) {
    const activeNpcs = npcLedger.filter(npc => !npc.archived);
    const archivedNpcs = npcLedger.filter(npc => npc.archived);

    return (
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {activeNpcs.length === 0 && archivedNpcs.length === 0 && (
                <p className="text-text-dim text-xs text-center p-4 italic opacity-50">No records found.</p>
            )}
            {activeNpcs.map(npc => {
                const isActive = selectedId === npc.id && !selectMode;
                const isChecked = checkedIds.has(npc.id);
                return (
                    <div
                        key={npc.id}
                        onClick={() => selectMode ? onToggleCheck(npc.id) : onSelect(npc)}
                        className={`flex items-center justify-between p-3 cursor-pointer border-l-2 transition-all group ${isActive ? 'border-terminal bg-terminal/5' : isChecked ? 'border-terminal/40 bg-terminal/5' : 'border-transparent hover:bg-surface'}`}
                    >
                        <div className="flex items-center gap-2 truncate flex-1 min-w-0">
                            {selectMode ? (
                                <div className="shrink-0 text-terminal">
                                    {isChecked
                                        ? <CheckSquare size={14} />
                                        : <Square size={14} className="text-text-dim" />}
                                </div>
                            ) : (
                                <User size={14} className={`shrink-0 ${isActive ? 'text-terminal' : 'text-text-dim'}`} />
                            )}
                            <div className="truncate min-w-0">
                                <p className={`text-sm font-bold truncate ${isActive ? 'text-terminal glow-green-sm' : 'text-text-primary'}`}>
                                    {npc.name}
                                </p>
                                <div className="flex items-center gap-1 text-[10px] mt-0.5 text-text-dim truncate">
                                    {npc.faction && npc.faction.split(/[,;/]/).map(f => f.trim()).filter(Boolean).map((fac, idx) => (
                                        <span key={idx} className="bg-terminal/10 text-terminal px-1 rounded uppercase shrink-0">
                                            {fac}
                                        </span>
                                    ))}
                                    {npc.aliases && <span className="truncate">{npc.aliases}</span>}
                                </div>
                            </div>
                        </div>
                        {!selectMode && (
                            <button
                                onClick={(e) => onDelete(npc.id, e)}
                                className="p-1.5 text-text-dim hover:text-danger hover:bg-danger/10 rounded transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100 shrink-0"
                            >
                                <Trash2 size={12} />
                            </button>
                        )}
                    </div>
                );
            })}
            {archivedNpcs.length > 0 && (
                <>
                    <div className="text-[10px] text-text-dim uppercase tracking-wider mt-3 mb-1 pl-3">Archived</div>
                    {archivedNpcs.map(npc => {
                        const isChecked = checkedIds.has(npc.id);
                        return (
                            <div
                                key={npc.id}
                                onClick={() => selectMode ? onToggleCheck(npc.id) : onSelect(npc)}
                                className={`flex items-center justify-between p-3 cursor-pointer border-l-2 transition-all group opacity-50 hover:opacity-80 ${isChecked ? 'border-terminal/40 bg-terminal/5' : 'border-transparent hover:bg-surface'}`}
                            >
                                <div className="flex items-center gap-2 truncate flex-1 min-w-0">
                                    {selectMode ? (
                                        <div className="shrink-0 text-terminal">
                                            {isChecked
                                                ? <CheckSquare size={14} />
                                                : <Square size={14} className="text-text-dim" />}
                                        </div>
                                    ) : (
                                        <User size={14} className="shrink-0 text-text-dim" />
                                    )}
                                    <div className="truncate min-w-0">
                                        <p className="text-sm font-bold truncate text-text-dim line-through">
                                            {npc.name}
                                        </p>
                                        <div className="flex items-center gap-1 text-[10px] mt-0.5 text-text-dim/60 truncate">
                                            {npc.archivedReason && <span>{npc.archivedReason}</span>}
                                        </div>
                                    </div>
                                </div>
                                {!selectMode && onRestore && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onRestore(npc.id); }}
                                        className="p-1.5 text-text-dim hover:text-terminal hover:bg-terminal/10 rounded transition-colors opacity-100 sm:opacity-0 sm:group-hover:opacity-100 shrink-0"
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
