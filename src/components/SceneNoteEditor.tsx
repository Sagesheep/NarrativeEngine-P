import React from 'react';
import { useAppStore } from '../store/useAppStore';
import { StickyNote, Trash2 } from 'lucide-react';

export const SceneNoteEditor: React.FC = () => {
    const { context, updateContext } = useAppStore();

    const handleClear = () => {
        updateContext({
            sceneNote: '',
            sceneNoteActive: false
        });
    };

    return (
        <div className="mt-2 space-y-2">
            <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-[11px] text-amber uppercase tracking-wider">
                    <StickyNote size={13} />
                    Active Scene Note
                </label>
                {context.sceneNote && (
                    <button
                        onClick={handleClear}
                        className="text-[9px] text-text-dim hover:text-red-400 flex items-center gap-1 uppercase transition-colors"
                        title="Clear scene note"
                    >
                        <Trash2 size={10} />
                        Clear
                    </button>
                )}
            </div>

            <div className="flex items-center gap-4 bg-void-lighter border border-border p-2 rounded">
                <div className="flex-1 flex flex-col gap-1">
                    <label className="text-[9px] text-text-dim uppercase tracking-wider">Injection Depth</label>
                    <input
                        type="range"
                        min="0"
                        max="20"
                        step="1"
                        value={context.sceneNoteDepth ?? 3}
                        onChange={(e) => updateContext({ sceneNoteDepth: parseInt(e.target.value) })}
                        className="w-full accent-amber cursor-pointer"
                    />
                </div>
                <div className="text-center min-w-[35px]">
                    <div className="text-xs font-bold text-amber">{context.sceneNoteDepth ?? 3}</div>
                    <div className="text-[8px] text-text-dim uppercase">msgs</div>
                </div>
            </div>

            <textarea
                value={context.sceneNote}
                onChange={(e) => updateContext({ sceneNote: e.target.value, sceneNoteActive: !!e.target.value })}
                placeholder="Add special instructions for the current scene (e.g., 'The air is thick with humidity', 'NPC is being unusually evasive')..."
                rows={4}
                className={`w-full bg-void border px-3 py-2 text-xs text-text-primary placeholder:text-text-dim/40 font-mono resize-y transition-all ${context.sceneNoteActive ? 'border-amber/50 shadow-[0_0_10px_rgba(245,158,11,0.05)]' : 'border-border'
                    }`}
            />

            <p className="text-[9px] text-text-dim/50 italic">
                {context.sceneNoteActive
                    ? "✓ Currently being injected after dynamic context."
                    : "No active note. Notes are injected at 'volatile_state' layer."}
            </p>
        </div>
    );
};
