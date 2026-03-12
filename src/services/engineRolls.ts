import type { GameContext } from '../types';
import { 
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES, 
    DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES, 
    DEFAULT_WORLD_WHAT, DEFAULT_WORLD_WHERE, 
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHY 
} from '../store/useAppStore';

export type EngineRollResult = {
    appendToInput: string;
    updatedDCs: {
        surpriseDC: number;
        encounterDC: number;
        worldEventDC: number;
    };
};

export function rollEngines(context: GameContext): EngineRollResult {
    let newSurpriseDC = context.surpriseDC ?? 95;
    let newEncounterDC = context.encounterDC ?? 198;
    let newWorldDC = context.worldEventDC ?? 498;
    let appendToInput = '';

    // Tier 1: Surprise Engine (Color/Ambient)
    if (context.surpriseEngineActive !== false) {
        const roll = Math.floor(Math.random() * 100) + 1;
        if (roll >= newSurpriseDC) {
            const typesList = context.surpriseConfig?.types || DEFAULT_SURPRISE_TYPES;
            const tonesList = context.surpriseConfig?.tones || DEFAULT_SURPRISE_TONES;
            const type = typesList[Math.floor(Math.random() * typesList.length)];
            const tone = tonesList[Math.floor(Math.random() * tonesList.length)];

            appendToInput += `\n[SURPRISE EVENT: ${type} (${tone})]`;
            newSurpriseDC = context.surpriseConfig?.initialDC || 95;
            console.log(`[Surprise Engine] Triggered! Type: ${type}, Tone: ${tone}. Resetting DC to ${newSurpriseDC}`);
        } else {
            console.log(`[Surprise Engine] Roll: ${roll} < DC: ${newSurpriseDC}. Decreasing DC.`);
            newSurpriseDC = Math.max(5, newSurpriseDC - (context.surpriseConfig?.dcReduction || 3));
        }
    }

    // Tier 2: Encounter Engine (Challenges/Hooks)
    if (context.encounterEngineActive !== false) {
        const roll = Math.floor(Math.random() * 200) + 1;
        if (roll >= newEncounterDC) {
            const typesList = context.encounterConfig?.types || DEFAULT_ENCOUNTER_TYPES;
            const tonesList = context.encounterConfig?.tones || DEFAULT_ENCOUNTER_TONES;
            const type = typesList[Math.floor(Math.random() * typesList.length)];
            const tone = tonesList[Math.floor(Math.random() * tonesList.length)];

            appendToInput += `\n[ENCOUNTER EVENT: ${type} (${tone})]`;
            newEncounterDC = context.encounterConfig?.initialDC || 198;
            console.log(`[Encounter Engine] Triggered! Type: ${type}, Tone: ${tone}. Resetting DC to ${newEncounterDC}`);
        } else {
            console.log(`[Encounter Engine] Roll: ${roll} < DC: ${newEncounterDC}. Decreasing DC.`);
            newEncounterDC = Math.max(5, newEncounterDC - (context.encounterConfig?.dcReduction || 2));
        }
    }

    // Tier 3: World Engine (Seismic/Global)
    if (context.worldEngineActive !== false) {
        const worldRoll = Math.floor(Math.random() * 500) + 1;
        if (worldRoll >= newWorldDC) {
            const cfg = context.worldEventConfig || { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] };
            const hasCustomTags = cfg.who && cfg.who.length >= 3 &&
                cfg.where && cfg.where.length >= 3 &&
                cfg.why && cfg.why.length >= 3 &&
                cfg.what && cfg.what.length >= 3;

            const tag = hasCustomTags
                ? `[WORLD_EVENT: ${cfg.who![Math.floor(Math.random() * cfg.who!.length)]} ${cfg.what![Math.floor(Math.random() * cfg.what!.length)]} ${cfg.why![Math.floor(Math.random() * cfg.why!.length)]} ${cfg.where![Math.floor(Math.random() * cfg.where!.length)]}]`
                : `[WORLD_EVENT: ${DEFAULT_WORLD_WHO[Math.floor(Math.random() * DEFAULT_WORLD_WHO.length)]} ${DEFAULT_WORLD_WHAT[Math.floor(Math.random() * DEFAULT_WORLD_WHAT.length)]} ${DEFAULT_WORLD_WHY[Math.floor(Math.random() * DEFAULT_WORLD_WHY.length)]} ${DEFAULT_WORLD_WHERE[Math.floor(Math.random() * DEFAULT_WORLD_WHERE.length)]}]`;

            appendToInput += `\n${tag}`;
            newWorldDC = cfg.initialDC || 498;
            console.log(`[World Engine] Triggered! Tag: ${tag}. Resetting DC to ${newWorldDC}`);
        } else {
            console.log(`[World Engine] Roll: ${worldRoll} < DC: ${newWorldDC}. Decreasing DC.`);
            newWorldDC = Math.max(5, newWorldDC - (context.worldEventConfig?.dcReduction || 2));
        }
    }

    return {
        appendToInput,
        updatedDCs: {
            surpriseDC: newSurpriseDC,
            encounterDC: newEncounterDC,
            worldEventDC: newWorldDC
        }
    };
}

export function rollDiceFairness(context: GameContext): string {
    if (context.diceFairnessActive === false) return '';

    const getOutcomeWord = (rollResult: number) => {
        const config = context.diceConfig || {
            catastrophe: 2,
            failure: 6,
            success: 15,
            triumph: 19,
            crit: 20
        };
        if (rollResult <= config.catastrophe) return "Catastrophe";
        if (rollResult <= config.failure) return "Failure";
        if (rollResult <= config.success) return "Success";
        if (rollResult <= config.triumph) return "Triumph";
        return "Narrative Boon";
    };

    const generatePool = () => {
        const rolls = [
            Math.floor(Math.random() * 20) + 1,
            Math.floor(Math.random() * 20) + 1,
            Math.floor(Math.random() * 20) + 1
        ].sort((a, b) => a - b);
        return `Disadvantage: ${getOutcomeWord(rolls[0])}, Normal: ${getOutcomeWord(rolls[1])}, Advantage: ${getOutcomeWord(rolls[2])}`;
    };

    return `\n[DICE OUTCOMES: COMBAT=(${generatePool()}) | PERCEPTION=(${generatePool()}) | STEALTH=(${generatePool()}) | SOCIAL=(${generatePool()}) | MOVEMENT=(${generatePool()}) | KNOWLEDGE=(${generatePool()}) | MUNDANE=(Narrative Boon)]`;
}
