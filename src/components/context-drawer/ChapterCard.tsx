import React, { memo, useState, useEffect, useRef } from 'react';
import { 
    ChevronDown, ChevronUp, Lock, Unlock, AlertCircle, 
    RefreshCcw, Edit2, Check, X, GitMerge, Scissors 
} from 'lucide-react';
import type { ArchiveChapter } from '../../types';

interface ChapterCardProps {
    chapter: ArchiveChapter;
    expanded: boolean;
    onToggle: () => void;
    onSeal: () => void;
    onRegenerate: () => void;
    onRename: (newTitle: string) => void;
    onMergeWithNext?: () => void;
    onSplit?: (atSceneId: string) => void;
    isNextAdjacent?: boolean;
}

export const ChapterCard = memo(function ChapterCard({
    chapter,
    expanded,
    onToggle,
    onSeal,
    onRegenerate,
    onRename,
    onMergeWithNext,
    onSplit,
    isNextAdjacent,
}: ChapterCardProps) {
    const [isEditing, setIsEditing] = useState(false);
    const [editTitle, setEditTitle] = useState(chapter.title);
    const [splitScene, setSplitScene] = useState('');
    const [showSplitInput, setShowSplitInput] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing]);

    const handleSaveRename = () => {
        if (editTitle.trim() && editTitle !== chapter.title) {
            onRename(editTitle.trim());
        }
        setIsEditing(false);
    };

    const handleCancelRename = () => {
        setEditTitle(chapter.title);
        setIsEditing(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') handleSaveRename();
        if (e.key === 'Escape') handleCancelRename();
    };

    const status = chapter.invalidated ? 'invalidated' : (chapter.sealedAt ? 'sealed' : 'open');
    
    const statusColors = {
        sealed: 'text-terminal border-terminal/30 bg-terminal/5',
        open: 'text-ember border-ember/30 bg-ember/5',
        invalidated: 'text-ice border-ice/30 bg-ice/5'
    };

    const statusIcons = {
        sealed: <Lock size={14} className="mr-1" />,
        open: <Unlock size={14} className="mr-1" />,
        invalidated: <AlertCircle size={14} className="mr-1" />
    };

    return (
        <div className={`border rounded-lg overflow-hidden transition-all duration-200 ${expanded ? 'border-border-bright bg-void-lighter' : 'border-border hover:border-border-bright bg-void'}`}>
            {/* Header */}
            <div className="p-3 cursor-pointer select-none" onClick={onToggle}>
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center flex-1 min-w-0" onClick={e => e.stopPropagation()}>
                        {isEditing ? (
                            <div className="flex items-center flex-1 mr-2">
                                <input
                                    ref={inputRef}
                                    type="text"
                                    className="bg-void-dark border border-terminal text-text-primary px-2 py-0.5 rounded w-full text-sm font-mono focus:outline-none"
                                    value={editTitle}
                                    onChange={e => setEditTitle(e.target.value)}
                                    onBlur={handleSaveRename}
                                    onKeyDown={handleKeyDown}
                                />
                            </div>
                        ) : (
                            <h3 className="font-mono font-bold text-text-primary truncate mr-2 flex items-center">
                                {chapter.title}
                                <button 
                                    onClick={() => setIsEditing(true)}
                                    className="ml-2 text-text-muted hover:text-terminal transition-colors"
                                >
                                    <Edit2 size={12} />
                                </button>
                            </h3>
                        )}
                    </div>
                    <div className={`px-2 py-0.5 rounded border text-[10px] font-bold uppercase flex items-center shrink-0 ${statusColors[status]}`}>
                        {statusIcons[status]}
                        {status.toUpperCase()}
                    </div>
                </div>

                <div className="flex items-center justify-between text-[11px] font-mono text-text-muted">
                    <div className="flex items-center space-x-3">
                        <span>SCENES {chapter.sceneRange[0]}–{chapter.sceneRange[1]}</span>
                        <span className="opacity-50">|</span>
                        <span>{chapter.sceneCount} SCENES</span>
                    </div>
                    {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
            </div>

            {/* Expandable Content */}
            {expanded && (
                <div className="p-3 pt-0 border-t border-border/50 text-sm">
                    <div className="space-y-4 pt-3">
                        {/* Summary */}
                        {chapter.summary ? (
                            <div className="space-y-1">
                                <label className="text-[10px] font-bold uppercase text-terminal/60 tracking-wider font-mono">Summary</label>
                                <p className="text-text-secondary leading-relaxed font-serif italic text-[13px] bg-void-dark/50 p-2 rounded border border-border/30">
                                    {chapter.summary}
                                </p>
                            </div>
                        ) : (
                            <div className="text-text-muted italic text-xs py-2">
                                No summary generated yet.
                            </div>
                        )}

                        {/* Metadata Grid */}
                        <div className="grid grid-cols-2 gap-3">
                            {chapter.npcs.length > 0 && (
                                <div className="space-y-1">
                                    <label className="text-[10px] font-bold uppercase text-ember/60 tracking-wider font-mono text-xs">NPCs</label>
                                    <div className="flex flex-wrap gap-1">
                                        {chapter.npcs.map(npc => (
                                            <span key={npc} className="px-1.5 py-0.5 rounded bg-ember/10 border border-ember/20 text-ember text-[10px] uppercase font-mono">
                                                {npc}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {chapter.themes.length > 0 && (
                                <div className="space-y-1">
                                    <label className="text-[10px] font-bold uppercase text-ice/60 tracking-wider font-mono text-xs">Themes</label>
                                    <div className="flex flex-wrap gap-1">
                                        {chapter.themes.map(theme => (
                                            <span key={theme} className="px-1.5 py-0.5 rounded bg-ice/10 border border-ice/20 text-ice text-[10px] uppercase font-mono">
                                                {theme}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Major Events */}
                        {chapter.majorEvents.length > 0 && (
                            <div className="space-y-1">
                                <label className="text-[10px] font-bold uppercase text-terminal/60 tracking-wider font-mono">Major Events</label>
                                <ul className="list-disc list-inside text-xs text-text-secondary space-y-0.5 pl-1">
                                    {chapter.majorEvents.map((event, i) => (
                                        <li key={i} className="truncate">{event}</li>
                                    ))}
                                </ul>
                            </div>
                        )}

                        {/* Actions Footer */}
                        <div className="pt-3 flex flex-wrap gap-2 border-t border-border/30 mt-4">
                            {status === 'open' && (
                                <button 
                                    onClick={onSeal}
                                    className="flex items-center space-x-1 px-3 py-1.5 rounded bg-ember text-void hover:bg-ember-bright transition-colors font-bold text-[11px] uppercase"
                                >
                                    <Lock size={12} />
                                    <span>Seal Chapter</span>
                                </button>
                            )}
                            
                            {(status === 'sealed' || status === 'invalidated') && (
                                <button 
                                    onClick={onRegenerate}
                                    className={`flex items-center space-x-1 px-3 py-1.5 rounded transition-colors font-bold text-[11px] uppercase ${
                                        status === 'invalidated' 
                                            ? 'bg-ice text-void hover:bg-ice-bright' 
                                            : 'bg-void-dark border border-border hover:border-terminal hover:text-terminal text-text-secondary'
                                    }`}
                                >
                                    <RefreshCcw size={12} />
                                    <span>{status === 'invalidated' ? 'Repair Summary' : 'Regenerate'}</span>
                                </button>
                            )}

                            {onSplit && (
                                <div className="relative">
                                    <button 
                                        onClick={() => setShowSplitInput(!showSplitInput)}
                                        className="flex items-center space-x-1 px-3 py-1.5 rounded bg-void-dark border border-border hover:border-terminal hover:text-terminal text-text-secondary transition-colors font-bold text-[11px] uppercase"
                                    >
                                        <Scissors size={12} />
                                        <span>Split</span>
                                    </button>
                                    
                                    {showSplitInput && (
                                        <div className="absolute bottom-full left-0 mb-2 p-2 bg-void-dark border border-border-bright rounded shadow-lg z-10 w-48">
                                            <p className="text-[10px] uppercase font-bold text-text-muted mb-1">Split at Scene ID:</p>
                                            <div className="flex gap-1">
                                                <input
                                                    type="text"
                                                    placeholder="e.g. 015"
                                                    className="bg-void border border-border text-text-primary px-2 py-1 rounded text-xs font-mono w-full focus:outline-none focus:border-terminal"
                                                    value={splitScene}
                                                    onChange={e => setSplitScene(e.target.value)}
                                                />
                                                <button 
                                                    onClick={() => {
                                                        if (splitScene) {
                                                            onSplit(splitScene);
                                                            setShowSplitInput(false);
                                                            setSplitScene('');
                                                        }
                                                    }}
                                                    className="p-1 bg-terminal text-void rounded hover:bg-terminal-bright"
                                                >
                                                    <Check size={14} />
                                                </button>
                                                <button 
                                                    onClick={() => setShowSplitInput(false)}
                                                    className="p-1 bg-void border border-border text-text-muted rounded hover:text-terminal"
                                                >
                                                    <X size={14} />
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {isNextAdjacent && onMergeWithNext && (
                                <button 
                                    onClick={onMergeWithNext}
                                    className="flex items-center space-x-1 px-3 py-1.5 rounded bg-void-dark border border-border hover:border-terminal hover:text-terminal text-text-secondary transition-colors font-bold text-[11px] uppercase"
                                >
                                    <GitMerge size={12} />
                                    <span>Merge with Next</span>
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
});
