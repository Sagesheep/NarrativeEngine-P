import { useMemo } from 'react';
import type React from 'react';
import { useAppStore } from '../store/useAppStore';
import { useShallow } from 'zustand/react/shallow';
import { countTokens } from '../services/infrastructure/tokenizer';
import { DEFAULT_RULES } from '../services/rules/defaultRules';
import {
    minifyBookkeepingStub,
} from '../services/turn/contextMinifier';
import { countRegisterTokens } from '../services/campaign-state/divergenceRegister';

export function TokenGauge() {
    const { context, settings, condenser, inventoryItems, characterProfileData, divergenceRegister } = useAppStore(
        useShallow(s => ({
            context: s.context,
            settings: s.settings,
            condenser: s.condenser,
            inventoryItems: s.inventoryItems ?? s.context.inventoryItems ?? [],
            characterProfileData: s.characterProfileData ?? s.context.characterProfileData ?? null,
            divergenceRegister: s.divergenceRegister,
        }))
    );
    const messages = useAppStore(s => s.messages);

    const legacyProfile = context.characterProfileActive && context.characterProfile ? context.characterProfile : '';
    const legacyInventory = context.inventoryActive && context.inventory ? context.inventory : '';

    const systemText = useMemo(() => {
        const parts: string[] = [];
        if (context.loreRaw) parts.push(context.loreRaw);
        if (context.rulesRaw || DEFAULT_RULES) parts.push(context.rulesRaw || DEFAULT_RULES);
        if (context.canonStateActive && context.canonState) parts.push(context.canonState);
        if (context.headerIndexActive && context.headerIndex) parts.push(context.headerIndex);
        if (context.starterActive && context.starter) parts.push(context.starter);
        if (context.continuePromptActive && context.continuePrompt) parts.push(context.continuePrompt);

        if (context.smartBookkeepingActive && characterProfileData) {
            const stub = minifyBookkeepingStub(characterProfileData, inventoryItems || []);
            if (stub) parts.push(`[CHARACTER]\n${stub}`);
        } else if (legacyProfile) {
            parts.push(`[CHARACTER PROFILE]\n${legacyProfile}`);
        }

        if (!context.smartBookkeepingActive && legacyInventory) {
            parts.push(`[PLAYER INVENTORY]\n${legacyInventory}`);
        }

        return parts.join('\n\n');
    }, [context, characterProfileData, inventoryItems, legacyProfile, legacyInventory]);

    const systemTokens = useMemo(() => countTokens(systemText), [systemText]);

    const registerTokens = useMemo(() => {
        if (!divergenceRegister || divergenceRegister.entries.length === 0) return 0;
        return countRegisterTokens(divergenceRegister);
    }, [divergenceRegister]);

    const adjustedSystemTokens = systemTokens + registerTokens;

    const historyText = useMemo(() => {
        const activeMessages = (condenser.condensedUpToIndex !== undefined && condenser.condensedUpToIndex >= 0)
            ? messages.slice(condenser.condensedUpToIndex + 1)
            : messages;
        return activeMessages.map((m) => m.content || '').join('');
    }, [messages, condenser.condensedUpToIndex]);

    const historyTokens = useMemo(() => countTokens(historyText), [historyText]);

    const total = settings.contextLimit;
    const remaining = Math.max(0, total - adjustedSystemTokens - historyTokens);




    // Beta UI renders the same three numbers as one proportional bar. The bar is
    // `display:none` in the classic UI (see beta.css) rather than conditional on
    // the flag, so this component never has to read settings and the classic DOM
    // gains nothing but an inert span.
    const usedPct = total > 0 ? Math.min(100, ((adjustedSystemTokens + historyTokens) / total) * 100) : 0;
    const sysPct = total > 0 ? Math.min(100, (adjustedSystemTokens / total) * 100) : 0;
    const hisPct = Math.max(0, usedPct - sysPct);

    return (
        <div data-ui="gauge" className="flex items-center gap-2.5 shrink-0 px-3">
            <span
                data-ui="gauge-bar"
                title={`Context ${Math.round(usedPct)}% used — ${adjustedSystemTokens} system, ${historyTokens} history, ${remaining} free`}
                style={{ '--sys': `${sysPct}%`, '--his': `${hisPct}%` } as React.CSSProperties}
            >
                <i data-part="sys" /><i data-part="his" />
            </span>
            <span data-ui="gauge-pct">{Math.round(usedPct)}%</span>
            <span className="text-[10px] text-text-dim uppercase tracking-widest font-mono font-bold shrink-0">
                CTX
            </span>
            <div className="flex items-center gap-2 text-[10px] font-mono shrink-0">
                <span className="text-ember font-bold">SYS:{adjustedSystemTokens}{registerTokens > 0 ? <span className="text-amber-400 font-bold">(+{registerTokens})</span> : ''}</span>
                <span className="text-text-dim/40">|</span>
                <span className="text-ice font-bold">HIS:{historyTokens}</span>
                <span className="text-text-dim/40">|</span>
                <span className="text-text-dim font-bold">FREE:{remaining}</span>
            </div>
        </div>
    );
}
