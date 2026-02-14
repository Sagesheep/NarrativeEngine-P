import type { AppSettings, ChatMessage, GameContext } from '../types';

type OpenAIMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
};

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

export function buildPayload(
    settings: AppSettings,
    context: GameContext,
    history: ChatMessage[],
    userMessage: string
): OpenAIMessage[] {
    const systemContent = [context.loreRaw, context.rulesRaw]
        .filter(Boolean)
        .join('\n\n');

    const systemTokens = estimateTokens(systemContent);
    const userTokens = estimateTokens(userMessage);
    const budget = settings.contextLimit - systemTokens - userTokens;

    // Walk history backwards, fitting as many as possible
    const fitted: OpenAIMessage[] = [];
    let used = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        const cost = estimateTokens(history[i].content);
        if (used + cost > budget) break;
        fitted.unshift({ role: history[i].role, content: history[i].content });
        used += cost;
    }

    const messages: OpenAIMessage[] = [];
    if (systemContent) {
        messages.push({ role: 'system', content: systemContent });
    }
    messages.push(...fitted);
    messages.push({ role: 'user', content: userMessage });

    return messages;
}

export async function sendMessage(
    settings: AppSettings,
    messages: OpenAIMessage[],
    onChunk: (text: string) => void,
    onDone: () => void,
    onError: (err: string) => void
): Promise<void> {
    const url = `${settings.endpoint.replace(/\/+$/, '')}/chat/completions`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey) {
        headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: settings.modelName,
                messages,
                stream: true,
            }),
        });

        if (!res.ok) {
            const errBody = await res.text();
            onError(`API error ${res.status}: ${errBody}`);
            return;
        }

        const reader = res.body?.getReader();
        if (!reader) {
            onError('No readable stream in response');
            return;
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || !trimmed.startsWith('data: ')) continue;
                const data = trimmed.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const parsed = JSON.parse(data);
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                        fullText += delta;
                        onChunk(fullText);
                    }
                } catch {
                    // skip malformed chunks
                }
            }
        }

        onDone();
    } catch (err) {
        onError(err instanceof Error ? err.message : 'Unknown network error');
    }
}

export async function testConnection(settings: AppSettings): Promise<{ ok: boolean; detail: string }> {
    const url = `${settings.endpoint.replace(/\/+$/, '')}/models`;
    const headers: Record<string, string> = {};
    if (settings.apiKey) {
        headers['Authorization'] = `Bearer ${settings.apiKey}`;
    }

    try {
        const res = await fetch(url, { headers });
        if (res.ok) {
            return { ok: true, detail: 'Connection successful' };
        }
        return { ok: false, detail: `HTTP ${res.status}: ${await res.text()}` };
    } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : 'Network error' };
    }
}
