import { useState } from 'react';
import { ScrollText, Sparkles } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { PayloadTraceView } from '../PayloadTraceView';
import { SceneNoteEditor } from '../SceneNoteEditor';
import { countTokens } from '../../services/infrastructure/tokenizer';
import { DEFAULT_RULES } from '../../services/rules/defaultRules';
import { ScreenSection } from '../primitives/ScreenSection';
import { RulesManagerTab } from './RulesManagerTab';

type Mode = 'write' | 'retrieval';

/**
 * WO-screen-modernization §A-2 — RulesTab and RulesManagerTab are two halves of
 * one feature split across two nav entries. RulesTab WRITES `context.rulesRaw`
 * (the only editor in the app); RulesManagerTab chunks/keywords/indexes it for
 * RAG and never edits it. The link was conditional — the "Manage" button only
 * rendered when `ragActive`, so below the token threshold the screens looked
 * unrelated.
 *
 * They are now one destination with a segmented control in the section header:
 *
 *     [ Write | Retrieval ]
 *
 * `Write` is the prose editor; `Retrieval` is the chunk/keyword manager. The
 * nav drawer's `rules-mgr` entry is gone. `rulesRaw` itself is unchanged — it
 * has exactly one editor; it is the SCREEN SPLIT that was redundant.
 */
export function RulesTab() {
    const context = useAppStore((s) => s.context);
    const updateContext = useAppStore((s) => s.updateContext);
    const settings = useAppStore((s) => s.settings);

    const [mode, setMode] = useState<Mode>('write');

    const rulesBudgetPct = settings.rulesBudgetPct ?? 0.10;
    const contextLimit = settings.contextLimit || 8192;
    const rulesBudget = Math.floor(contextLimit * rulesBudgetPct);
    const threshold = Math.floor(rulesBudget * 1.2);
    const tokenCount = countTokens(context.rulesRaw);
    const ragActive = tokenCount > threshold;
    const usingDefaults = !context.rulesRaw;

    return (
        // Shape A — Editor. The screen root is a flex CHILD of the lightbox's
        // inner wrapper, NOT a percentage-height element. `h-full` against the
        // wrapper's auto height was a no-op (WO-screen-modernization §0-B); the
        // continuous flex chain (`flex-1 min-h-0 flex flex-col` here, matching
        // `flex-1 min-h-0 flex flex-col` on the wrapper) is what makes the
        // textarea actually fill the panel. Verified with getBoundingClientRect.
        <div className="flex-1 min-h-0 flex flex-col space-y-4">
            <ScreenSection
                icon={ScrollText}
                label="Rules / Mechanics"
                rightSlot={
                    <div className="flex items-center gap-2">
                        {/* WO-screen-modernization §A-2 — segmented control. Two
                            modes of one feature, not two nav entries. The
                            active segment mirrors the Memory tab's sub-tab
                            styling so the two editor surfaces read as kin. */}
                        <div className="flex items-center gap-0.5">
                            <button
                                type="button"
                                onClick={() => setMode('write')}
                                className={`flex items-center gap-0.5 text-[11px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded whitespace-nowrap transition-colors ${
                                    mode === 'write'
                                        ? 'text-terminal bg-terminal/10'
                                        : 'text-text-dim hover:text-text-primary'
                                }`}
                                aria-pressed={mode === 'write'}
                            >
                                Write
                            </button>
                            <button
                                type="button"
                                onClick={() => setMode('retrieval')}
                                className={`flex items-center gap-0.5 text-[11px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded whitespace-nowrap transition-colors ${
                                    mode === 'retrieval'
                                        ? 'text-terminal bg-terminal/10'
                                        : 'text-text-dim hover:text-text-primary'
                                }`}
                                aria-pressed={mode === 'retrieval'}
                            >
                                Retrieval
                            </button>
                        </div>
                        {mode === 'write' && usingDefaults && (
                            <button
                                onClick={() => updateContext({ rulesRaw: DEFAULT_RULES })}
                                className="flex items-center gap-1 text-[11px] text-terminal hover:text-text-primary transition-colors font-bold uppercase tracking-wider bg-terminal/10 hover:bg-terminal/20 px-1.5 py-0.5 rounded-sm border border-terminal/20"
                                title="Load AI GM OS v4.0 as a starting point"
                            >
                                <Sparkles size={9} />
                                Load v4.0 Example
                            </button>
                        )}
                    </div>
                }
            />

            {mode === 'retrieval' ? (
                // Retrieval mode — the chunk/keyword/index manager. Embedded
                // (no own ScreenSection header and no Back button); the
                // segmented control above is the only way out. `flex-1 min-h-0`
                // keeps it inside the same continuous flex chain so the manager's
                // own scroll container gets a real height.
                <div className="flex-1 min-h-0 flex flex-col">
                    <RulesManagerTab embedded />
                </div>
            ) : (
                <>
                    {usingDefaults && (
                        <p className="text-[12px] text-terminal/80 -mt-2">
                            Using built-in default rules. Paste your own below to override.
                        </p>
                    )}

                    {/* WO-screen-modernization §A-1 — asymmetric 2fr / 1fr at xl
                        and up, single column below. The dominant content is a
                        ~3,000-token prose document the user edits; narrow
                        columns make prose editing worse. The rules editor gets
                        both the height and the wide column; the scene note
                        (slider + short directive) and Diagnostics stack in the
                        right column and fill it honestly.

                        Below xl the layout is a flex column so the editor can
                        grow to fill (`flex-1 min-h-0`) while the scene note +
                        diagnostics take their natural height beneath it. At xl
                        and up it switches to a 2fr/1fr grid so both columns fill
                        the full panel height side by side. `min-h-0` on the grid
                        items overrides the default `min-height: auto` (min-content)
                        so the textarea's `flex-1` can actually shrink; the
                        textarea's own `min-h-[12rem]` is the user-facing floor. */}
                    <div className="flex-1 min-h-0 flex flex-col gap-4 xl:grid xl:grid-cols-[2fr_1fr] xl:gap-6">
                        {/* LEFT — Rules / Mechanics editor. Fills the full panel
                            height; token count and verbatim/RAG state pin to
                            the bottom of the field. */}
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
                                    <span className="text-terminal-dim">
                                        Threshold: {threshold.toLocaleString()} tok
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* RIGHT — Active Scene Note, then Diagnostics stacked
                            beneath it. Below xl it takes its natural height
                            beneath the editor (`shrink-0`); at xl it becomes a
                            grid item that fills the panel height, with the
                            scene note at its natural size and Diagnostics
                            filling the remainder. */}
                        <div className="shrink-0 xl:flex-1 xl:min-h-0 flex flex-col gap-4">
                            <div className="shrink-0">
                                <SceneNoteEditor />
                            </div>
                            {settings.debugMode && (
                                <div className="flex-1 min-h-0 pt-4 border-t border-border overflow-y-auto">
                                    <ScreenSection label="Diagnostics" tone="terminal" />
                                    <PayloadTraceView />
                                </div>
                            )}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}