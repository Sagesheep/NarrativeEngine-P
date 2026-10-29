import { Dices, Search, NotebookPen, Wrench } from 'lucide-react';
import type { ChatMessage } from '../../types';

type ToolCall = NonNullable<ChatMessage['tool_calls']>[number];

type Props = {
    toolCalls: ChatMessage['tool_calls'];
    /** Raw JSON/string result of the tool, resolved from the matching `tool` role message. */
    toolResult?: string;
};

function safeParse(raw: string | undefined): Record<string, unknown> {
    if (!raw) return {};
    try { return JSON.parse(raw) ?? {}; } catch { return {}; }
}

function DiceChip({ args, result }: { args: Record<string, unknown>; result: Record<string, unknown> }) {
    const dice = (result.dice ?? args.dice ?? '1d20') as string;
    const reason = (result.reason ?? args.reason ?? '') as string;
    const total = result.result;
    const tier = result.tier as string | undefined;
    return (
        <>
            <Dices size={11} className="text-amber-400 shrink-0" />
            <span className="text-amber-400/90 font-semibold">{dice}</span>
            {reason && <span className="text-text-dim/80 truncate">· {reason}</span>}
            {total !== undefined && (
                <span className="ml-auto flex items-center gap-1 shrink-0 tabular-nums">
                    <span className="text-text-primary font-bold">{String(total)}</span>
                    {tier && <span className="text-amber-400/70 uppercase">{tier}</span>}
                </span>
            )}
        </>
    );
}

function LoreChip({ args, result }: { args: Record<string, unknown>; result?: string }) {
    const query = (args.query ?? '') as string;
    const found = result ? !/^no relevant lore/i.test(result.trim()) : undefined;
    return (
        <>
            <Search size={11} className="text-ice shrink-0" />
            <span className="text-ice/90 font-semibold">Searched archives</span>
            {query && <span className="text-text-dim/80 truncate">· “{query}”</span>}
            {found !== undefined && (
                <span className={`ml-auto shrink-0 uppercase ${found ? 'text-emerald-500/80' : 'text-text-dim/60'}`}>
                    {found ? 'hit' : 'none'}
                </span>
            )}
        </>
    );
}

function NotebookChip({ args }: { args: Record<string, unknown> }) {
    const actions = Array.isArray(args.actions) ? args.actions as { op?: string }[] : [];
    const ops = actions.map(a => a.op).filter(Boolean) as string[];
    return (
        <>
            <NotebookPen size={11} className="text-terminal shrink-0" />
            <span className="text-terminal/90 font-semibold">Scene notes</span>
            {ops.length > 0 && <span className="text-text-dim/80 truncate">· {ops.join(', ')}</span>}
        </>
    );
}

function ChipBody({ call, toolResult }: { call: ToolCall; toolResult?: string }) {
    const name = call.function.name;
    const args = safeParse(call.function.arguments);
    if (name === 'roll_dice') return <DiceChip args={args} result={safeParse(toolResult)} />;
    if (name === 'query_campaign_lore') return <LoreChip args={args} result={toolResult} />;
    if (name === 'update_scene_notebook') return <NotebookChip args={args} />;
    return (
        <>
            <Wrench size={11} className="text-text-dim shrink-0" />
            <span className="text-text-dim font-semibold">{name}</span>
        </>
    );
}

/**
 * Tool-call chips (WO-11.6) — render dice rolls / lore lookups / notebook edits
 * as clean chips instead of raw system text. Desktop port of mobile's
 * ToolCallChips. The tool result is resolved by the caller (ChatArea maps
 * `tool_call_id` → the matching `tool` role message content) and passed in.
 */
export function ToolCallChips({ toolCalls, toolResult }: Props) {
    if (!toolCalls || toolCalls.length === 0) return null;
    return (
        <div className="flex flex-col gap-1 mb-2">
            {toolCalls.map(call => (
                <div
                    key={call.id}
                    className="flex items-center gap-1.5 px-2 py-1 rounded-sm bg-void-darker border border-border/60 text-[10px] tracking-wide font-mono"
                    title={`tool_call: ${call.function.name}`}
                >
                    <ChipBody call={call} toolResult={toolResult} />
                </div>
            ))}
        </div>
    );
}