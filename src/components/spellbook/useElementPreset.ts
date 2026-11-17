import type { ElementPresetId } from '@narrative/engine';
import { useAppStore } from '../../store/useAppStore';
import { normalizeCombatConfig } from '../../types';

export function useElementPreset(): ElementPresetId {
    return useAppStore(s => normalizeCombatConfig(s.context?.combatConfig).combatElements);
}
