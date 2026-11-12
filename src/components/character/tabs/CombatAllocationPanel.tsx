import { useMemo, useState } from 'react';
import {
    ABILITY_KEYS, ARCHETYPE_KEYS, ARCHETYPE_PRESETS, PC_POINT_BUY,
    createDefaultSheet, deriveSheet, getPointCost, validateAllocation,
} from '@narrative/engine';
import { useAppStore } from '../../../store/useAppStore';
import { useTranslation } from '../../../i18n/useTranslation';
import { toast } from '../../Toast';
import { applyCombatSheet, commitCombatPatch } from '../../../services/combat/combatSheet';
import type { AbilityKey, AbilityScores, Archetype, CombatSheet } from '../../../types';

function signed(n: number): string {
    return n >= 0 ? `+${n}` : String(n);
}

function AllocationEditor({ sheet }: { sheet: CombatSheet }) {
    const { t } = useTranslation();
    const updateContext = useAppStore((s) => s.updateContext);
    const setCharacterProfileData = useAppStore((s) => s.setCharacterProfileData);
    const [abilities, setAbilities] = useState<AbilityScores>({ ...sheet.abilities });
    const [archetype, setArchetype] = useState<Archetype | undefined>(sheet.archetype);

    const cfg = PC_POINT_BUY[sheet.budget];
    const allocation = validateAllocation(abilities, sheet.budget);
    const derived = useMemo(() => deriveSheet({ ...sheet, abilities }), [sheet, abilities]);

    const canRaise = (key: AbilityKey): boolean => {
        const value = abilities[key];
        if (value >= cfg.max) return false;
        const delta = getPointCost(value + 1, sheet.budget) - getPointCost(value, sheet.budget);
        return allocation.pointsSpent + delta <= cfg.totalPoints;
    };

    const step = (key: AbilityKey, delta: 1 | -1) => {
        if (delta === 1 && !canRaise(key)) return;
        const value = abilities[key] + delta;
        if (value < cfg.min || value > cfg.max) return;
        setAbilities({ ...abilities, [key]: value });
        setArchetype(undefined);
    };

    const applyPreset = (key: Archetype) => {
        setAbilities({ ...ARCHETYPE_PRESETS[key] });
        setArchetype(key);
    };

    const reset = () => {
        setAbilities({ ...createDefaultSheet(sheet.budget).abilities });
        setArchetype(undefined);
    };

    const save = () => {
        if (!validateAllocation(abilities, sheet.budget).isValid) {
            toast.warning(t('combat.alloc.invalid'));
            return;
        }
        const nextSheet: CombatSheet = { ...sheet, abilities: { ...abilities }, needsAllocation: false };
        if (archetype) nextSheet.archetype = archetype;
        else delete nextSheet.archetype;
        const context = useAppStore.getState().context;
        commitCombatPatch({ updateContext, setCharacterProfileData }, applyCombatSheet(context, nextSheet));
        toast.success(t('combat.alloc.saved'));
    };

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between text-[11px]">
                <span className={allocation.pointsRemaining < 0 ? 'text-red-400' : 'text-terminal'} data-testid="combat-points-left">
                    {t('combat.alloc.remaining', { points: allocation.pointsRemaining })}
                </span>
                <button
                    onClick={reset}
                    className="px-2 py-1 text-[10px] uppercase tracking-wider rounded border bg-void border-border text-text-dim hover:border-text-primary"
                >
                    {t('combat.alloc.reset')}
                </button>
            </div>
            <div className="space-y-1">
                {ABILITY_KEYS.map((key) => {
                    const name = t(`combat.ability.${key}`);
                    return (
                        <div key={key} className="flex items-center gap-2">
                            <span className="text-[11px] font-mono text-text-primary w-10">{key}</span>
                            <span className="text-[10px] text-text-dim flex-1 truncate">{name}</span>
                            <button
                                aria-label={t('combat.alloc.lower.aria', { ability: name })}
                                onClick={() => step(key, -1)}
                                disabled={abilities[key] <= cfg.min}
                                className="w-6 h-6 rounded border border-border text-text-primary disabled:opacity-30"
                            >
                                -
                            </button>
                            <span className="w-8 text-center text-[12px] font-mono text-text-primary" data-testid={`combat-ability-${key}`}>{abilities[key]}</span>
                            <button
                                aria-label={t('combat.alloc.raise.aria', { ability: name })}
                                onClick={() => step(key, 1)}
                                disabled={!canRaise(key)}
                                className="w-6 h-6 rounded border border-border text-text-primary disabled:opacity-30"
                            >
                                +
                            </button>
                        </div>
                    );
                })}
            </div>
            <div>
                <div className="text-[9px] text-text-dim/60 uppercase tracking-wider mb-1">{t('combat.alloc.presets')}</div>
                <div className="flex flex-wrap gap-1">
                    {ARCHETYPE_KEYS.map((key) => (
                        <button
                            key={key}
                            onClick={() => applyPreset(key)}
                            className={`px-2 py-1 text-[10px] rounded border ${archetype === key ? 'border-terminal text-terminal' : 'border-border text-text-dim hover:border-text-primary'}`}
                        >
                            {t(`combat.archetype.${key}`)}
                        </button>
                    ))}
                </div>
            </div>
            <div className="grid grid-cols-4 gap-2 text-center text-[10px]" data-testid="combat-derived">
                <div><div className="text-text-dim/60">{t('combat.alloc.preview.level')}</div><div className="text-text-primary font-mono">{sheet.level}</div></div>
                <div><div className="text-text-dim/60">{t('combat.alloc.preview.hp')}</div><div className="text-text-primary font-mono" data-testid="combat-derived-hp">{derived.maxHp}</div></div>
                <div><div className="text-text-dim/60">{t('combat.alloc.preview.ac')}</div><div className="text-text-primary font-mono" data-testid="combat-derived-ac">{derived.ac}</div></div>
                <div><div className="text-text-dim/60">{t('combat.alloc.preview.proficiency')}</div><div className="text-text-primary font-mono">{signed(derived.proficiency)}</div></div>
            </div>
            <button
                onClick={save}
                disabled={!allocation.isValid}
                className="w-full px-3 py-1.5 bg-void border border-border hover:border-terminal text-text-primary text-[10px] uppercase tracking-wider rounded transition-colors disabled:opacity-50"
            >
                {t('combat.alloc.save')}
            </button>
        </div>
    );
}

export function CombatAllocationPanel() {
    const { t } = useTranslation();
    const combatModeActive = useAppStore((s) => s.context.combatModeActive === true);
    const storedSheet = useAppStore((s) => s.context.combatSheet);
    if (!combatModeActive) return null;
    const sheet = storedSheet ?? createDefaultSheet('NORMAL');
    const needsAllocation = !storedSheet || storedSheet.needsAllocation;
    const editorKey = JSON.stringify([sheet.abilities, sheet.archetype ?? '', sheet.budget, sheet.level]);
    return (
        <div className="pt-2" data-testid="combat-allocation">
            <h3 className="text-[11px] uppercase tracking-wider text-ember mb-2">{t('combat.alloc.title')}</h3>
            {needsAllocation && (
                <p role="status" className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5 mb-2">
                    {t('combat.alloc.prompt')}
                </p>
            )}
            <AllocationEditor key={editorKey} sheet={sheet} />
        </div>
    );
}
