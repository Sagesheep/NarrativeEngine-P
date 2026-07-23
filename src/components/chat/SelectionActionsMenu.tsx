import { Loader2, BookCheck, Pin, Replace, UserPlus, MapPin, Image } from 'lucide-react';
import { useSelectionActions, stripMarkdown } from './useSelectionActions';

/**
 * Floating toolbar over text selected in a message bubble: Lore Check,
 * Pin Memory, Rename, Add NPC, Add Place, Generate Scene Image.
 */
export function SelectionActionsMenu() {
    const {
        loreSel,
        npcAdding,
        selectionMenuRef,
        selectionMenuPosition,
        handleLoreCheck,
        handlePinSelection,
        handleRenameSelection,
        handleAddNpc,
        handleAddPlace,
        handleGenerateSceneImage,
    } = useSelectionActions();

    if (!selectionMenuPosition || !loreSel) return null;

    return (
        <div
            ref={selectionMenuRef}
            role="toolbar"
            aria-label="Selected text actions"
            className="fixed z-[120] max-w-[calc(100vw-24px)] rounded-md border border-terminal/80 bg-void-darker/95 p-2 shadow-2xl backdrop-blur-md"
            style={{ left: selectionMenuPosition.left, top: selectionMenuPosition.top }}
        >
            <div className="mb-1.5 max-w-[300px] truncate px-1 text-[9px] uppercase tracking-widest text-text-primary/90">
                Selected: {stripMarkdown(loreSel.text)}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
                <button
                    onMouseDown={handleGenerateSceneImage}
                    onTouchStart={handleGenerateSceneImage}
                    className="flex items-center gap-1.5 rounded-sm border border-cyan-500/80 bg-cyan-950/40 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-cyan-300 transition-colors hover:border-cyan-400 hover:bg-cyan-500/20 hover:text-white"
                >
                    <Image size={13} /> Scene Image
                </button>
                <button
                    onMouseDown={handleLoreCheck}
                    onTouchStart={handleLoreCheck}
                    className="flex items-center gap-1.5 rounded-sm border border-terminal/60 bg-void-lighter/95 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-terminal transition-colors hover:border-terminal hover:bg-terminal/15 hover:text-text-primary"
                >
                    <BookCheck size={13} /> Lore Check
                </button>
                <button
                    onMouseDown={handlePinSelection}
                    onTouchStart={handlePinSelection}
                    className="flex items-center gap-1.5 rounded-sm border border-terminal/60 bg-void-lighter/95 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-terminal transition-colors hover:border-terminal hover:bg-terminal/15 hover:text-text-primary"
                >
                    <Pin size={13} /> Pin Memory
                </button>
                <button
                    onMouseDown={handleRenameSelection}
                    onTouchStart={handleRenameSelection}
                    className="flex items-center gap-1.5 rounded-sm border border-terminal/60 bg-void-lighter/95 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-terminal transition-colors hover:border-terminal hover:bg-terminal/15 hover:text-text-primary"
                >
                    <Replace size={13} /> Rename
                </button>
                <button
                    onMouseDown={handleAddNpc}
                    onTouchStart={handleAddNpc}
                    disabled={npcAdding}
                    className="flex items-center gap-1.5 rounded-sm border border-terminal/60 bg-void-lighter/95 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-terminal transition-colors hover:border-terminal hover:bg-terminal/15 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {npcAdding ? <Loader2 size={13} className="animate-spin" /> : <UserPlus size={13} />} Add NPC
                </button>
                <button
                    onMouseDown={handleAddPlace}
                    onTouchStart={handleAddPlace}
                    className="flex items-center gap-1.5 rounded-sm border border-terminal/60 bg-void-lighter/95 px-2.5 py-1.5 text-[10px] uppercase tracking-wider text-terminal transition-colors hover:border-terminal hover:bg-terminal/15 hover:text-text-primary"
                >
                    <MapPin size={13} /> Add Place
                </button>
            </div>
        </div>
    );
}
