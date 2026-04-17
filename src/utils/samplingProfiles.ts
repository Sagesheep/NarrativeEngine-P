import type { SamplingConfig } from '../types';

export type SamplingProfile = {
    id: string;
    name: string;
    description: string;
    tags: ('cloud' | 'local')[];
    params: SamplingConfig;
};

export const SAMPLING_PROFILES: SamplingProfile[] = [
    {
        id: 'default',
        name: 'Default (Balanced)',
        description: 'Sensible defaults for general use',
        tags: ['cloud', 'local'],
        params: { temperature: 0.7, top_p: 0.9 },
    },
    {
        id: 'deepseek-v3.2',
        name: 'DeepSeek V3.2',
        description: 'Official: temp 1.0, top_p 0.95',
        tags: ['cloud'],
        params: { temperature: 1.0, top_p: 0.95 },
    },
    {
        id: 'gemma4-31b',
        name: 'Gemma 4 31B',
        description: 'Official: temp 1.0, top_p 0.95, top_k 64',
        tags: ['cloud'],
        params: { temperature: 1.0, top_p: 0.95, top_k: 64 },
    },
    {
        id: 'glm-5.1',
        name: 'GLM 5.1',
        description: 'Official: temp 1.0',
        tags: ['cloud'],
        params: { temperature: 1.0 },
    },
    {
        id: 'kimi-k2.5-thinking',
        name: 'Kimi K2.5 Thinking',
        description: 'Official: temp 1.0, top_p 0.95',
        tags: ['cloud'],
        params: { temperature: 1.0, top_p: 0.95 },
    },
    {
        id: 'kimi-k2.5-instant',
        name: 'Kimi K2.5 Instant',
        description: 'Official: temp 0.6, top_p 0.95',
        tags: ['cloud'],
        params: { temperature: 0.6, top_p: 0.95 },
    },
    {
        id: 'creative-writing',
        name: 'Creative Writing (Local)',
        description: 'High creativity, min_p + DRY repetition control',
        tags: ['local'],
        params: {
            temperature: 1.25,
            min_p: 0.075,
            top_p: 1.0,
            top_k: 0,
            dry_multiplier: 0.8,
            dry_base: 1.75,
            dry_allowed_length: 2,
        },
    },
    {
        id: 'deterministic',
        name: 'Deterministic',
        description: 'Near-deterministic output for structured tasks',
        tags: ['cloud', 'local'],
        params: { temperature: 0.1 },
    },
];

export const SAMPLING_FIELDS: {
    key: keyof SamplingConfig;
    label: string;
    min: number;
    max: number;
    step: number;
    cloud: boolean;
}[] = [
    { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.05, cloud: true },
    { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.01, cloud: true },
    { key: 'top_k', label: 'Top K', min: 0, max: 200, step: 1, cloud: false },
    { key: 'min_p', label: 'Min P', min: 0, max: 1, step: 0.01, cloud: false },
    { key: 'frequency_penalty', label: 'Freq Penalty', min: -2, max: 2, step: 0.05, cloud: true },
    { key: 'presence_penalty', label: 'Pres Penalty', min: -2, max: 2, step: 0.05, cloud: true },
    { key: 'repetition_penalty', label: 'Rep Penalty', min: 1, max: 2, step: 0.05, cloud: false },
    { key: 'dry_multiplier', label: 'DRY Mult', min: 0, max: 2, step: 0.05, cloud: false },
    { key: 'dry_base', label: 'DRY Base', min: 1, max: 4, step: 0.05, cloud: false },
    { key: 'dry_allowed_length', label: 'DRY Length', min: 1, max: 10, step: 1, cloud: false },
];
