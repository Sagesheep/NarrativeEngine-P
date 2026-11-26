import { llmCall } from '../../utils/llmCall';
import { useAppStore } from '../../store/useAppStore';
import { renderPrompt } from '../prompts/promptRegistry';

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



export async function formatLoreText(text: string, category: string): Promise<string> {
    const endpoint = getEndpointOrThrow();
    const prompt = `${renderPrompt('world.lore-format', { category })}\n\n${text}`;
    return llmCall(endpoint, prompt, { temperature: 0.4, priority: 'low' });
}

export async function expandLoreText(text: string, category: string): Promise<string> {
    const endpoint = getEndpointOrThrow();
    const prompt = `${renderPrompt('world.lore-expand', { category })}\n\n${text}`;
    return llmCall(endpoint, prompt, { temperature: 0.7, priority: 'low' });
}