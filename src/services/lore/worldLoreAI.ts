import { llmCall } from '../../utils/llmCall';
import { useAppStore } from '../../store/useAppStore';

export class AuxNotConfiguredError extends Error {
    constructor() {
        super('Auxiliary AI is not configured. Open Settings and set an Auxiliary AI endpoint.');
        this.name = 'AuxNotConfiguredError';
    }
}

function getEndpointOrThrow() {
    const endpoint = useAppStore.getState().getActiveAuxiliaryEndpoint();
    if (!endpoint || !endpoint.endpoint) throw new AuxNotConfiguredError();
    return endpoint;
}

const FORMAT_SYSTEM_PREFIX = `You are an editor for a tabletop RPG world-building tool. The user has written rough notes for the section titled "{category}". Clean up the text: fix grammar, remove redundancies, tighten phrasing, and organize into clear paragraphs or bullet lists as appropriate. Preserve all factual content and proper nouns exactly. Do not add new ideas or invented details. Return only the cleaned text, no headers or meta-commentary.`;

const EXPAND_SYSTEM_PREFIX = `You are a creative writing assistant for a tabletop RPG world-building tool. The user has provided bullet points or rough notes for the section titled "{category}". Expand these into rich, evocative prose suitable for a campaign setting document. Add sensory details, tone-appropriate flavor, and logical connections — but do not contradict or omit any of the original points. Return only the expanded text, no headers or meta-commentary.`;

export async function formatLoreText(text: string, category: string): Promise<string> {
    const endpoint = getEndpointOrThrow();
    const prompt = `${FORMAT_SYSTEM_PREFIX.replace('{category}', category)}\n\n${text}`;
    return llmCall(endpoint, prompt, { temperature: 0.4, priority: 'low' });
}

export async function expandLoreText(text: string, category: string): Promise<string> {
    const endpoint = getEndpointOrThrow();
    const prompt = `${EXPAND_SYSTEM_PREFIX.replace('{category}', category)}\n\n${text}`;
    return llmCall(endpoint, prompt, { temperature: 0.7, priority: 'low' });
}