import type { ValidatedModTable } from './modTypes';

export const SCREEN_API_CAPABILITIES = ['table.read', 'table.write', 'theme', 'resize'] as const;
export type ScreenApiCapability = (typeof SCREEN_API_CAPABILITIES)[number];

export const MAX_INBOUND_MESSAGES = 1000;
export const MIN_SCREEN_HEIGHT_PX = 120;
export const MAX_SCREEN_HEIGHT_PX = 1200;

export interface ScreenTheme {
    readonly version: 2;
    readonly mode: 'light' | 'dark';
    readonly colors: {
        readonly background: string;
        readonly surface: string;
        readonly border: string;
        readonly text: string;
        readonly muted: string;
        readonly accent: string;
        readonly danger: string;
        readonly hover: string;
        readonly active: string;
        readonly focus: string;
        readonly selected: string;
        readonly disabled: string;
    };
    readonly fontSizes: {
        readonly small: string;
        readonly body: string;
        readonly heading: string;
    };
    readonly radii: {
        readonly small: string;
        readonly medium: string;
    };
}

export const DARK_SCREEN_THEME: ScreenTheme = {
    version: 2,
    mode: 'dark',
    colors: {
        background: '#141519',
        surface: '#1C1E23',
        border: '#363A44',
        text: '#EBEBEB',
        muted: '#909090',
        accent: '#A78BFA',
        danger: '#E05555',
        hover: 'rgba(255, 255, 255, 0.05)',
        active: 'rgba(255, 255, 255, 0.10)',
        focus: '#A78BFA',
        selected: 'rgba(167, 139, 250, 0.15)',
        disabled: 'rgba(235, 235, 235, 0.38)',
    },
    fontSizes: {
        small: '11px',
        body: '13px',
        heading: '16px',
    },
    radii: {
        small: '4px',
        medium: '8px',
    },
} as const;

export const LIGHT_SCREEN_THEME: ScreenTheme = {
    version: 2,
    mode: 'light',
    colors: {
        background: '#FAFAF8',
        surface: '#F0EFED',
        border: '#DEDEDE',
        text: '#1A1A1A',
        muted: '#6B6B6B',
        accent: '#6D28D9',
        danger: '#C0392B',
        hover: 'rgba(0, 0, 0, 0.05)',
        active: 'rgba(0, 0, 0, 0.10)',
        focus: '#6D28D9',
        selected: 'rgba(109, 40, 217, 0.15)',
        disabled: 'rgba(26, 26, 26, 0.38)',
    },
    fontSizes: {
        small: '11px',
        body: '13px',
        heading: '16px',
    },
    radii: {
        small: '4px',
        medium: '8px',
    },
} as const;

export function getAppThemeMode(): 'light' | 'dark' {
    if (typeof document !== 'undefined') {
        const attr = document.documentElement.getAttribute('data-theme');
        if (attr === 'dark' || attr === 'light') return attr;
        if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
            return 'dark';
        }
    }
    return 'dark';
}

export function resolveScreenTheme(mode?: 'light' | 'dark'): ScreenTheme {
    const activeMode = mode ?? getAppThemeMode();
    return activeMode === 'light' ? LIGHT_SCREEN_THEME : DARK_SCREEN_THEME;
}

export const SCREEN_THEME: ScreenTheme = DARK_SCREEN_THEME;

export interface ScreenApiInitMessage {
    readonly __screenInit: true;
    readonly nonce: string;
    readonly theme: ScreenTheme;
}

export interface ScreenApiRequest {
    readonly __screenRequest: true;
    readonly id: number;
    readonly nonce: string;
    readonly capability: string;
    readonly table?: string;
    readonly value?: unknown;
    readonly height?: number;
}

export interface ScreenApiResponse {
    readonly __screenResponse: true;
    readonly id: number;
    readonly nonce: string;
    readonly ok: boolean;
    readonly result?: unknown;
    readonly error?: string;
}

export interface ScreenFaultMessage {
    readonly __screenFault: true;
    readonly nonce: string;
    readonly kind: 'load' | 'threw' | 'crashed' | 'denied' | 'flood' | 'malformed';
    readonly message: string;
}

export type ScreenTableReadResult = unknown;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function isStructuredCloneSafe(value: unknown, seen = new WeakSet<object>()): boolean {
    if (value === null) return true;
    if (typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);

    if (Array.isArray(value)) return value.every((item) => isStructuredCloneSafe(item, seen));
    if (!isPlainRecord(value)) return false;
    return Object.entries(value).every(([key, item]) => key.length > 0 && isStructuredCloneSafe(item, seen));
}

export function tableDefault(table: ValidatedModTable): unknown {
    return table.recordShape === 'array' ? [] : null;
}

export function tableAcceptsValue(table: ValidatedModTable, value: unknown): boolean {
    if (!isStructuredCloneSafe(value)) return false;
    if (table.recordShape === 'array') return Array.isArray(value);
    return isPlainRecord(value);
}

export function isScreenApiRequest(value: unknown): value is ScreenApiRequest {
    if (!isPlainRecord(value)) return false;
    if (value.__screenRequest !== true) return false;
    if (typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id <= 0) return false;
    if (typeof value.nonce !== 'string' || value.nonce.length === 0) return false;
    if (typeof value.capability !== 'string' || value.capability.length === 0) return false;
    if (value.table !== undefined && typeof value.table !== 'string') return false;
    if (value.height !== undefined && (typeof value.height !== 'number' || !Number.isFinite(value.height))) return false;
    if (value.value !== undefined && !isStructuredCloneSafe(value.value)) return false;
    return true;
}
