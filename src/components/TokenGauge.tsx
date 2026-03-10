import { useAppStore } from '../store/useAppStore';
import { countTokens } from '../services/tokenizer';
import { formatQuestDigest } from '../services/questTracker';

export function TokenGauge() {
    const { context, messages, settings, condenser } = useAppStore();

    const systemParts: string[] = [];
    if (context.loreRaw) systemParts.push(context.loreRaw);
    if (context.rulesRaw) systemParts.push(context.rulesRaw);
    if (context.canonStateActive && context.canonState) systemParts.push(context.canonState);
    if (context.headerIndexActive && context.headerIndex) systemParts.push(context.headerIndex);
    if (context.questLogActive && context.questLog?.length) {
        const questDigest = formatQuestDigest(context.questLog);
        if (questDigest) systemParts.push(questDigest);
    }
    if (context.starterActive && context.starter) systemParts.push(context.starter);
    if (context.continuePromptActive && context.continuePrompt) systemParts.push(context.continuePrompt);
    if (context.characterProfileActive && context.characterProfile) systemParts.push(`[CHARACTER PROFILE]\n${context.characterProfile}`);
    if (context.inventoryActive && context.inventory) systemParts.push(`[PLAYER INVENTORY]\n${context.inventory}`);
    if (condenser.condensedSummary) systemParts.push(condenser.condensedSummary);

    const systemText = systemParts.join('\n\n');
    const systemTokens = countTokens(systemText);

    const activeMessages = (condenser.condensedUpToIndex !== undefined && condenser.condensedUpToIndex >= 0)
        ? messages.slice(condenser.condensedUpToIndex + 1)
        : messages;

    const historyText = activeMessages.map((m) => m.content || '').join('');
    const historyTokens = countTokens(historyText);

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

