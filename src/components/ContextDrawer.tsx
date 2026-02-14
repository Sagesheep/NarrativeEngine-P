import { useState } from 'react';
import { BookOpen, ScrollText, FileText, FileCode, Terminal, MessageSquare, ChevronDown, ChevronRight } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';

const LORE_LIMIT = 15000;
const RULES_LIMIT = 5000;

function TokenCounter({ text, limit }: { text: string; limit: number }) {
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
            <span className={`text-[10px] font-mono ${isOver ? 'text-danger' : 'text-text-dim'}`}>
                {chars.toLocaleString()} chars · ~{tokens.toLocaleString()} tok
            </span>
        </div>
    );
}

function Toggle({ active, onChange }: { active: boolean; onChange: () => void }) {
    return (
        <button
            onClick={(e) => { e.stopPropagation(); onChange(); }}
            className={`relative w-7 h-3.5 rounded-full transition-colors shrink-0 ${active ? 'bg-terminal' : 'bg-border'}`}
            title={active ? 'Active — will be appended' : 'Inactive — will not be appended'}
        >
            <div
                className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white transition-transform ${active ? 'translate-x-3.5' : 'translate-x-0.5'}`}
            />
        </button>
    );
}

function Section({ title, color, defaultOpen, children }: {
    title: string;
    color: string;
    defaultOpen: boolean;
    children: React.ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);

    return (
        <div className="border-b border-border last:border-b-0">
            <button
                onClick={() => setOpen(!open)}
                className={`w-full flex items-center gap-2 px-4 py-2.5 text-[11px] uppercase tracking-[0.2em] font-bold hover:bg-void-lighter transition-colors ${color}`}
            >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {title}
            </button>
            {open && (
                <div className="px-4 pb-4 pt-1 space-y-4">
                    {children}
                </div>
            )}
        </div>
    );
}

function TemplateField({ icon, label, color, value, onChange, placeholder, rows, active, onToggle, hint }: {
    icon: React.ReactNode;
    label: string;
    color: string;
    value: string;
    onChange: (val: string) => void;
    placeholder: string;
    rows: number;
    active: boolean;
    onToggle: () => void;
    hint?: string;
}) {
    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <label className={`flex items-center gap-2 text-[11px] uppercase tracking-wider ${color}`}>
                    {icon}
                    {label}
                </label>
                <Toggle active={active} onChange={onToggle} />
            </div>
            <textarea
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                rows={rows}
                className={`w-full bg-void border px-3 py-2 text-xs text-text-primary placeholder:text-text-dim/40 font-mono resize-y transition-opacity ${active ? 'border-border' : 'border-border/40 opacity-50'
                    }`}
            />
            {hint && (
                <p className="text-[9px] text-text-dim/50 mt-1">{hint}</p>
            )}
        </div>
    );
}

export function ContextDrawer() {
    const { context, updateContext, drawerOpen } = useAppStore();

    if (!drawerOpen) return null;

    return (
        <aside className="w-80 bg-surface border-r border-border flex flex-col shrink-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
                <h2 className="text-[11px] text-terminal uppercase tracking-[0.25em] font-bold glow-green">
                    ◆ CONTEXT BANK
                </h2>
            </div>

            <div className="flex-1 overflow-y-auto">
                {/* Context Section */}
                <Section title="◆ System Context" color="text-terminal glow-green" defaultOpen={true}>
                    {/* Lore */}
                    <div>
                        <label className="flex items-center gap-2 text-[11px] text-ember uppercase tracking-wider mb-2">
                            <BookOpen size={13} />
                            World Lore
                        </label>
                        <textarea
                            value={context.loreRaw}
                            onChange={(e) => updateContext({ loreRaw: e.target.value })}
                            placeholder="Paste world info, lore, setting details..."
                            rows={10}
                            className="w-full bg-void border border-border px-3 py-2 text-xs text-text-primary placeholder:text-text-dim/40 font-mono resize-y"
                        />
                        <TokenCounter text={context.loreRaw} limit={LORE_LIMIT} />
                    </div>

                    {/* Rules */}
                    <div>
                        <label className="flex items-center gap-2 text-[11px] text-ice uppercase tracking-wider mb-2">
                            <ScrollText size={13} />
                            Rules / Mechanics
                        </label>
                        <textarea
                            value={context.rulesRaw}
                            onChange={(e) => updateContext({ rulesRaw: e.target.value })}
                            placeholder="Paste game rules, mechanics, character stats..."
                            rows={6}
                            className="w-full bg-void border border-border px-3 py-2 text-xs text-text-primary placeholder:text-text-dim/40 font-mono resize-y"
                        />
                        <TokenCounter text={context.rulesRaw} limit={RULES_LIMIT} />
                    </div>
                </Section>

                {/* Templates Section */}
                <Section title="◇ Templates" color="text-text-dim" defaultOpen={false}>
                    <p className="text-[9px] text-text-dim/50 -mt-1 mb-2">
                        Toggle ON = appended to Save State output (top→bottom order)
                    </p>

                    <TemplateField
                        icon={<FileText size={13} />}
                        label="Save Format 1"
                        color="text-text-dim"
                        value={context.saveFormat1}
                        onChange={(v) => updateContext({ saveFormat1: v })}
                        placeholder="Paste save format template #1..."
                        rows={4}
                        active={context.saveFormat1Active}
                        onToggle={() => updateContext({ saveFormat1Active: !context.saveFormat1Active })}
                    />

                    <TemplateField
                        icon={<FileCode size={13} />}
                        label="Save Format 2"
                        color="text-text-dim"
                        value={context.saveFormat2}
                        onChange={(v) => updateContext({ saveFormat2: v })}
                        placeholder="Paste save format template #2..."
                        rows={4}
                        active={context.saveFormat2Active}
                        onToggle={() => updateContext({ saveFormat2Active: !context.saveFormat2Active })}
                    />

                    <TemplateField
                        icon={<MessageSquare size={13} />}
                        label="Save Instruction"
                        color="text-ember"
                        value={context.saveInstruction}
                        onChange={(v) => updateContext({ saveInstruction: v })}
                        placeholder="Additional instruction to include with save state..."
                        rows={3}
                        active={context.saveInstructionActive}
                        onToggle={() => updateContext({ saveInstructionActive: !context.saveInstructionActive })}
                    />

                    <TemplateField
                        icon={<Terminal size={13} />}
                        label="Save State Macro"
                        color="text-terminal"
                        value={context.saveStateMacro}
                        onChange={(v) => updateContext({ saveStateMacro: v })}
                        placeholder="Text inserted by the Save State button..."
                        rows={3}
                        active={context.saveStateMacroActive}
                        onToggle={() => updateContext({ saveStateMacroActive: !context.saveStateMacroActive })}
                        hint="↑ Core prompt — the [Save State] button builds from all active fields above"
                    />
                </Section>
            </div>
        </aside>
    );
}
