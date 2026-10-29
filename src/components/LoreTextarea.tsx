import { useState, useRef, useCallback } from 'react';
import { Sparkles, Wand, Loader2 } from 'lucide-react';
import { formatLoreText, expandLoreText, AuxNotConfiguredError } from '../services/lore/worldLoreAI';
import { toast } from './Toast';

type LoreTextareaProps = {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    rows?: number;
    category: string;
    className?: string;
    minRows?: number;
};

export function LoreTextarea({ value, onChange, placeholder, rows, category, className, minRows }: LoreTextareaProps) {
    const [loading, setLoading] = useState<'format' | 'expand' | null>(null);
    const undoRef = useRef<string | null>(null);
    const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const handleAI = useCallback(async (mode: 'format' | 'expand') => {
        const trimmed = value.trim();
        if (!trimmed) {
            toast.info('Write something first, then use AI assist.');
            return;
        }

        setLoading(mode);
        undoRef.current = value;

        try {
            const fn = mode === 'format' ? formatLoreText : expandLoreText;
            const result = await fn(trimmed, category);
            onChange(result);

            if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
            toast.success(`Text ${mode === 'format' ? 'formatted' : 'expanded'}. Undo available for 8s.`);

            undoTimerRef.current = setTimeout(() => {
                undoRef.current = null;
            }, 8000);
        } catch (err) {
            if (err instanceof AuxNotConfiguredError) {
                toast.error('Configure Auxiliary AI in Settings first.');
            } else {
                toast.error(err instanceof Error ? err.message : 'AI request failed.');
            }
        } finally {
            setLoading(null);
        }
    }, [value, category, onChange]);

    const handleUndo = useCallback(() => {
        if (undoRef.current !== null) {
            onChange(undoRef.current);
            undoRef.current = null;
            if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
            toast.info('Undone.');
        }
    }, [onChange]);

    const isDisabled = loading !== null;
    const showUndo = undoRef.current !== null;

    return (
        <div className="relative">
            <textarea
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                rows={rows}
                className={className}
                style={minRows ? { minHeight: `${minRows * 1.5}em` } : undefined}
            />
            <div className="absolute top-1.5 right-1.5 flex items-center gap-1">
                {showUndo && (
                    <button
                        onClick={handleUndo}
                        className="px-1.5 py-0.5 text-[9px] uppercase tracking-wider bg-amber-600/20 text-amber-400 border border-amber-600/30 hover:bg-amber-600/30 transition-colors rounded-sm"
                        title="Undo last AI change"
                    >
                        Undo
                    </button>
                )}
                <button
                    onClick={() => handleAI('format')}
                    disabled={isDisabled}
                    className={`p-1 rounded transition-colors ${
                        isDisabled
                            ? 'text-text-dim/30 cursor-not-allowed'
                            : 'text-text-dim hover:text-terminal hover:bg-terminal/10'
                    }`}
                    title="Format: clean up grammar and organization"
                >
                    {loading === 'format' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                </button>
                <button
                    onClick={() => handleAI('expand')}
                    disabled={isDisabled}
                    className={`p-1 rounded transition-colors ${
                        isDisabled
                            ? 'text-text-dim/30 cursor-not-allowed'
                            : 'text-text-dim hover:text-terminal hover:bg-terminal/10'
                    }`}
                    title="Expand: flesh out bullet points into prose"
                >
                    {loading === 'expand' ? <Loader2 size={13} className="animate-spin" /> : <Wand size={13} />}
                </button>
            </div>
        </div>
    );
}