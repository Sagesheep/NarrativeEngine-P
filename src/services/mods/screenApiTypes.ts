import type { ValidatedModTable } from './modTypes';

export const SCREEN_API_CAPABILITIES = ['table.read', 'table.write', 'theme', 'resize', 'campaign.read', 'file.download'] as const;
export type ScreenApiCapability = (typeof SCREEN_API_CAPABILITIES)[number];

export const MAX_INBOUND_MESSAGES = 1000;
export const MIN_SCREEN_HEIGHT_PX = 120;
export const MAX_SCREEN_HEIGHT_PX = 1200;
export const MAX_SCREEN_DOWNLOAD_CHARS = 10_000_000;
export const SCREEN_CAMPAIGN_RESOURCES = ['characters', 'character-sheet', 'inventory', 'recent-play'] as const;
export type ScreenCampaignResource = (typeof SCREEN_CAMPAIGN_RESOURCES)[number];

export const SCREEN_THEME = {
    version: 1,
    colors: {
        background: '#10131a',
        surface: '#181d27',
        border: '#3b4658',
        text: '#e7ebf2',
        muted: '#9aa6b8',
        accent: '#a78bfa',
        danger: '#f87171',
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

export type ScreenTheme = typeof SCREEN_THEME;

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
    readonly resource?: string;
    readonly filename?: string;
    readonly content?: string;
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
    if (value.resource !== undefined && typeof value.resource !== 'string') return false;
    if (value.filename !== undefined && typeof value.filename !== 'string') return false;
    if (value.content !== undefined && typeof value.content !== 'string') return false;
    return true;
}
