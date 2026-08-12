import { ScrollText, Settings2, Sparkles } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { PayloadTraceView } from '../PayloadTraceView';
import { SceneNoteEditor } from '../SceneNoteEditor';
import { countTokens } from '../../services/infrastructure/tokenizer';
import { DEFAULT_RULES } from '../../services/rules/defaultRules';
import { ScreenSection } from '../primitives/ScreenSection';

export function RulesTab({ onOpenManager }: { onOpenManager?: () => void }) {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const settings = useAppStore((s) => s.settings);

    const rulesBudgetPct = settings.rulesBudgetPct ?? 0.10;
    const contextLimit = settings.contextLimit || 8192;
    const rulesBudget = Math.floor(contextLimit * rulesBudgetPct);
    const threshold = Math.floor(rulesBudget * 1.2);
    const tokenCount = countTokens(context.rulesRaw);
    const ragActive = tokenCount > threshold;
    const usingDefaults = !context.rulesRaw;

    return (
        // Shape A — Editor. The screen is one large text field plus the
        // metadata that describes it. A 90vh lightbox means a fixed `rows={6}`
        // textarea is a ~150px porthole with 5k tokens scrolling through it.
        // The column lets the field grow to fill the height, and the metadata
        // pins to the bottom of the field — not below the fold.
        <div className="flex flex-col h-full space-y-4">
            <ScreenSection
                icon={ScrollText}
                label="Rules / Mechanics"
                rightSlot={
                    usingDefaults ? (
                        <button
                            onClick={() => updateContext({ rulesRaw: DEFAULT_RULES })}
                            className="flex items-center gap-1 text-[11px] text-terminal hover:text-text-primary transition-colors font-bold uppercase tracking-wider bg-terminal/10 hover:bg-terminal/20 px-1.5 py-0.5 rounded-sm border border-terminal/20"
                            title="Load AI GM OS v4.0 as a starting point"
                        >
                            <Sparkles size={9} />
                            Load v4.0 Example
                        </button>
                    ) : undefined
                }
            />
            {usingDefaults && (
                <p className="text-[12px] text-terminal/80 -mt-2">
                    Using built-in default rules. Paste your own below to override.
                </p>
            )}

            {/* The textarea fills available height. `flex-1 min-h-0` on the
                wrapper lets the field expand; `resize-y` keeps the user's
                manual drag. The metadata row pins to the bottom of the field
                (inside the same column, not below the fold). */}
            <div className="flex-1 min-h-0 flex flex-col">
                <textarea
                    value={context.rulesRaw}
                    onChange={(e) => updateContext({ rulesRaw: e.target.value })}
                    placeholder="Paste game rules, mechanics, character stats..."
                    className="flex-1 min-h-[12rem] w-full bg-void border border-border px-3 py-2 text-xs text-text-primary placeholder:text-text-dim/40 font-mono resize-y outline-none focus:border-terminal transition-colors"
                />
                <div className="flex items-center justify-between mt-1 text-[12px] font-mono text-text-dim">
                    <span>{tokenCount.toLocaleString()} tok</span>
                    <span className={ragActive ? 'text-terminal font-bold' : 'text-text-dim/60'}>
                        {ragActive ? 'RAG active' : 'verbatim'}
                    </span>
                </div>
                {ragActive && (
                    <div className="mt-1.5 flex items-center justify-between border border-terminal/20 bg-terminal/5 px-2 py-1 rounded-sm text-[11px]">
                        <span className="text-terminal-dim">
                            Budget: {rulesBudget} tok/turn
                        </span>
                        {onOpenManager && (
                            <button
                                onClick={onOpenManager}
                                className="flex items-center gap-1 text-terminal hover:text-text-primary transition-colors font-bold uppercase tracking-wider bg-terminal/10 px-1.5 py-0.5 rounded-sm"
                            >
                                <Settings2 size={10} />
                                Manage
                            </button>
                        )}
                    </div>
                )}
            </div>

            <div className="pt-4 border-t border-border/50">
                <SceneNoteEditor />
            </div>

            {settings.debugMode && (
                <div className="pt-4 border-t border-border">
                    <ScreenSection label="Diagnostics" tone="terminal" />
                    <PayloadTraceView />
                </div>
            )}
        </div>
    );
}