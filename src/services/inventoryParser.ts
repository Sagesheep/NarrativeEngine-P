import type { ChatMessage, ProviderConfig } from '../types';

async function callLLM(provider: ProviderConfig | EndpointConfig, prompt: string): Promise<string> {
    const url = `${provider.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: provider.modelName,
            messages: [{ role: 'user', content: prompt }],
            stream: false,
        }),
    });

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`Inventory Parser API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
}

export async function scanInventory(
    provider: ProviderConfig,
    messages: ChatMessage[],
    currentInventory: string
): Promise<string> {
    // Take the last 15 messages for context
    const recentMessages = messages.slice(-15);
    if (recentMessages.length === 0) return currentInventory;

    const turns = recentMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    const prompt = `You are an AI game engine parser responsible for maintaining the player's inventory.
Review the recent chat history and the current inventory list below. Identify any items, currency, or equipment the player recently acquired or lost.

=== CURRENT INVENTORY ===
${currentInventory || '(Empty)'}

=== RECENT CHAT HISTORY ===
${turns}

=== INSTRUCTIONS ===
1. Analyze the chat history for explicit gains or losses of items/money.
2. Update the "CURRENT INVENTORY" list accordingly.
3. Output ONLY the updated, comprehensive inventory list. 
4. Format as a clean markdown list (e.g., bullet points or categorized sections).
5. DO NOT include any conversational text, explanations, or markdown formatting outside of the list itself. If nothing changed, return the current inventory exactly as is.`;

    try {
        const result = await callLLM(provider, prompt);
        // Strip out any surrounding markdown code blocks if the LLM adds them
        return result.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, '').trim();
    } catch (e) {
        console.error('[InventoryParser]', e);
        throw e;
    }
}
