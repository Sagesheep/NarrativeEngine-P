import type { ElementPresetId } from '@narrative/engine';
import { useAppStore } from '../../store/useAppStore';
import { normalizeCombatConfig } from '../../types';
import { setElementPresetSource } from '../turn/toolHandlers';

export function activeElementPreset(): ElementPresetId {
    return normalizeCombatConfig(useAppStore.getState().context?.combatConfig).combatElements;
}

export function installElementPresetSource(): void {
    setElementPresetSource(activeElementPreset);
}
