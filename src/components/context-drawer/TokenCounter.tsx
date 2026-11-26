export function TokenCounter({ text, limit }: { text: string; limit: number }) {
    const chars = text.length;
    const tokens = Math.ceil(chars / 4);
    const pct = Math.min((chars / limit) * 100, 100);
    const isOver = chars > limit;

    return (
        <div className="flex items-center gap-2 mt-1">
            <div className="flex-1 h-1 bg-void-lighter">
                <div
                    className={`h-full transition-all duration-300 ${isOver ? 'bg-danger' : 'bg-terminal-dim'}`}
                    style={{ width: `${pct}%` }}
                />
            </div>
            <span className={`text-[12px] font-mono ${isOver ? 'text-danger' : 'text-text-dim'}`}>
                {chars.toLocaleString()} chars · ~{tokens.toLocaleString()} tok
            </span>
        </div>
    );
}
