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
    //
    // `auto-rows-max` is load-bearing. Without it the auto rows share out the container's
    // height instead of sizing to their content, so row height became (container / rowCount):
    // fine at 12 NPCs, 58px at 40, 18px at 97 — while the cards kept their aspect ratio and
    // overflowed, stacking on top of each other. `content-start` does not prevent this; it
    // compiles to `align-content: flex-start`, which grid does not honour here.
    return (
        <div className="flex-1 overflow-y-auto p-4 grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] auto-rows-max gap-3 content-start">
            {activeNpcs.length === 0 && archivedNpcs.length === 0 && (
                <p className="text-text-dim text-xs text-center p-4 italic opacity-50 col-span-full">No records found.</p>
            )}
            {activeNpcs.map(npc => {
                const isActive = selectedId === npc.id;
                const isChecked = checkedIds.has(npc.id);
                const factions = (npc.faction || '').split(/[,;/]/).map(f => f.trim()).filter(Boolean);
                return (
                    <div
                        key={npc.id}
                        onClick={() => selectMode ? onToggleCheck(npc.id) : onSelect(npc)}
                        title={npc.faction ? `${npc.name} — ${npc.faction}` : npc.name}
                        className={`relative rounded overflow-hidden cursor-pointer border group transition-all ${isActive ? 'border-terminal ring-1 ring-terminal shadow-[0_0_15px_rgba(0,255,0,0.15)]' : isChecked ? 'border-terminal/50 ring-1 ring-terminal/30' : 'border-border hover:border-terminal/50'}`}
                    >
                        {npc.portrait ? (
                            /* The aspect ratio MUST sit on an in-flow element. Putting it on the
                               card itself left the grid row sized from content — and with every
                               child absolute or percentage-height that is ~0, so rows collapsed
                               to 8px while cards painted 277px and stacked on top of each other.
                               Sizing the foreground image gives the row a real height.

                               Portraits are also not one shape: generated ones are 2:3, but
                               card-style images come back wide (2816x1536), so `object-contain`
                               keeps the whole picture and the blurred copy fills the letterbox. */
                            <>
                                <img
                                    src={npc.portrait}
                                    alt=""
                                    aria-hidden="true"
                                    className="absolute inset-0 w-full h-full object-cover scale-110 blur-md opacity-50"
                                />
                                <img
                                    src={npc.portrait}
                                    alt={npc.name}
                                    className="relative block w-full aspect-[2/3] object-contain transition-transform group-hover:scale-105"
                                />
                            </>
                        ) : (
                            <div className="w-full aspect-[2/3] bg-void-lighter flex flex-col items-center justify-center gap-2">
                                <User size={32} className="text-text-dim/30" />
                                <span className="text-[10px] text-text-dim/50 uppercase tracking-widest">No Portrait</span>
                            </div>
                        )}
                        {/* This overlay is bottom-anchored inside an overflow-hidden card, so it
                            grows upward: anything that can stack here will eventually push the
                            name out of the card. That is why the faction is ONE line that cannot
                            wrap — never a chip per faction (see #33). Full list is in the title. */}
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-void via-void/80 to-transparent p-3 pt-8">
                            <p className={`text-xs font-bold leading-tight line-clamp-2 break-words ${isActive ? 'text-terminal glow-green-sm' : 'text-text-primary'}`}>{npc.name}</p>
                            {factions.length > 0 && (
                                <p className="mt-0.5 text-[9px] uppercase tracking-wide text-terminal/80 truncate">
                                    {factions[0]}{factions.length > 1 ? ` +${factions.length - 1}` : ''}
                                </p>
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
                                className={`relative rounded overflow-hidden cursor-pointer border group transition-all opacity-40 hover:opacity-60 ${isChecked ? 'border-terminal/50 ring-1 ring-terminal/30' : 'border-border hover:border-terminal/50'}`}
                            >
                                {npc.portrait ? (
                                    <>
                                        <img src={npc.portrait} alt="" aria-hidden="true" className="absolute inset-0 w-full h-full object-cover scale-110 blur-md opacity-50" />
                                        <img src={npc.portrait} alt={npc.name} className="relative block w-full aspect-[2/3] object-contain" />
                                    </>
                                ) : (
                                    <div className="w-full aspect-[2/3] bg-void-lighter flex flex-col items-center justify-center gap-2">
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
