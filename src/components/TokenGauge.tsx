import { useAppStore } from '../store/useAppStore';

export function TokenGauge() {
    const { context, messages, settings, condenser } = useAppStore();

    const systemParts: string[] = [];
    if (context.loreRaw) systemParts.push(context.loreRaw);
    if (context.rulesRaw) systemParts.push(context.rulesRaw);
    if (context.saveFormat1Active && context.saveFormat1) systemParts.push(context.saveFormat1);
    if (context.saveFormat2Active && context.saveFormat2) systemParts.push(context.saveFormat2);
    if (context.saveInstructionActive && context.saveInstruction) systemParts.push(context.saveInstruction);
    if (context.saveStateMacroActive && context.saveStateMacro) systemParts.push(context.saveStateMacro);
    if (context.canonStateActive && context.canonState) systemParts.push(context.canonState);
    if (context.headerIndexActive && context.headerIndex) systemParts.push(context.headerIndex);
    if (context.starterActive && context.starter) systemParts.push(context.starter);
    if (context.continuePromptActive && context.continuePrompt) systemParts.push(context.continuePrompt);
    if (condenser.condensedSummary) systemParts.push(condenser.condensedSummary);
    const systemText = systemParts.join('\n\n');
    const systemTokens = Math.ceil(systemText.length / 4);

    const historyText = messages.map((m) => m.content).join('');
    const historyTokens = Math.ceil(historyText.length / 4);

    const total = settings.contextLimit;
    const remaining = Math.max(0, total - systemTokens - historyTokens);

    const pctSystem = Math.min((systemTokens / total) * 100, 100);
    const pctHistory = Math.min((historyTokens / total) * 100, 100 - pctSystem);
    const pctFree = 100 - pctSystem - pctHistory;

    return (
        <div className="flex items-center gap-3 flex-1 min-w-0 px-3">
            <span className="text-[10px] text-text-dim uppercase tracking-widest shrink-0">
                CTX
            </span>

            <div className="flex-1 h-3 bg-void-lighter border border-border relative overflow-hidden">
                <div
                    className="absolute inset-y-0 left-0 bg-ember transition-all duration-300"
                    style={{ width: `${pctSystem}%` }}
                />
                <div
                    className="absolute inset-y-0 bg-ice transition-all duration-300"
                    style={{ left: `${pctSystem}%`, width: `${pctHistory}%` }}
                />
                <div
                    className="absolute inset-y-0 bg-void-light transition-all duration-300"
                    style={{ left: `${pctSystem + pctHistory}%`, width: `${pctFree}%` }}
                />
            </div>

            <div className="flex gap-3 text-[10px] shrink-0">
                <span className="text-ember">SYS:{systemTokens}</span>
                <span className="text-ice">HIS:{historyTokens}</span>
                <span className="text-text-dim">FREE:{remaining}</span>
            </div>
        </div>
    );
}
