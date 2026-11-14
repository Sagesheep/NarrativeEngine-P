import {
    BUILTIN_ATTACK_ID, BUILTIN_DASH_ID, BUILTIN_DEFEND_ID, BUILTIN_HELP_ID, BUILTIN_JUMP_ID, BUILTIN_SHOVE_ID, BUILTIN_THROW_ID,
} from '@narrative/engine';
import type { TranslationKey } from '../../i18n/locales/en';

export const BASIC_NAME_KEYS: Readonly<Record<string, TranslationKey>> = {
    [BUILTIN_ATTACK_ID]: 'combat.panel.attack',
    [BUILTIN_DEFEND_ID]: 'combat.panel.defend',
    [BUILTIN_DASH_ID]: 'combat.panel.dash',
    [BUILTIN_SHOVE_ID]: 'combat.panel.shove',
    [BUILTIN_JUMP_ID]: 'combat.panel.jump',
    [BUILTIN_THROW_ID]: 'combat.panel.throw',
    [BUILTIN_HELP_ID]: 'combat.panel.help',
};

export const BASIC_HOTKEYS: Readonly<Record<string, string>> = {
    [BUILTIN_ATTACK_ID]: 'A',
    [BUILTIN_DEFEND_ID]: 'D',
    [BUILTIN_DASH_ID]: 'R',
    [BUILTIN_SHOVE_ID]: 'S',
    [BUILTIN_JUMP_ID]: 'J',
    [BUILTIN_THROW_ID]: 'T',
    [BUILTIN_HELP_ID]: 'H',
};

export const MORE_ACTION_IDS: readonly string[] = [BUILTIN_DASH_ID, BUILTIN_SHOVE_ID, BUILTIN_JUMP_ID, BUILTIN_THROW_ID, BUILTIN_HELP_ID];

export function basicNameKey(id: string): TranslationKey {
    return BASIC_NAME_KEYS[id] ?? 'combat.panel.attack';
}
