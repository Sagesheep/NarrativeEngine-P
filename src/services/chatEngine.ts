import type { AppSettings, ChatMessage, GameContext, LoreChunk, ProviderConfig, NPCEntry } from '../types';
import { getVerbatimWindow } from './condenser';

type OpenAIMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    name?: string;
    tool_calls?: any[];
    tool_call_id?: string;
};

function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}


export function buildPayload(
    settings: AppSettings,
    context: GameContext,
    history: ChatMessage[],
    userMessage: string,
    condensedSummary?: string,
    relevantLore?: LoreChunk[],
    npcLedger?: NPCEntry[]
): OpenAIMessage[] {
    // === 1. Build system prompt (protected — never compressed) ===
    const systemParts: string[] = [];

    // Static parts first for better LLM prefix caching!
    if (context.rulesRaw) systemParts.push(context.rulesRaw);

    // Template fields (only when toggled on)
    if (context.saveFormat1Active && context.saveFormat1) systemParts.push(context.saveFormat1);
    if (context.saveFormat2Active && context.saveFormat2) systemParts.push(context.saveFormat2);
    if (context.saveInstructionActive && context.saveInstruction) systemParts.push(context.saveInstruction);
    if (context.canonStateActive && context.canonState) systemParts.push(context.canonState);
    if (context.headerIndexActive && context.headerIndex) systemParts.push(context.headerIndex);
    if (context.starterActive && context.starter) systemParts.push(context.starter);
    if (context.continuePromptActive && context.continuePrompt) systemParts.push(context.continuePrompt);

    // === 2. Inject condensed history into system prompt (if available) ===
    if (condensedSummary) {
        systemParts.push(`[CONDENSED SESSION HISTORY]\n${condensedSummary}\n[END CONDENSED HISTORY]`);
    }

    // === 3. Inject dynamic RAG Lore at the end of the system prompt ===
    // This prevents cache busting for the static rules and templates above.
    if (relevantLore !== undefined) {
        // RAG is active for this campaign. 
        if (relevantLore.length > 0) {
            const loreBlock = relevantLore
                .map((c) => `### ${c.header}\n${c.content}`)
                .join('\n\n');
            systemParts.push(`[WORLD LORE — RELEVANT SECTIONS]\n${loreBlock}\n[END WORLD LORE]`);
        }
    } else if (context.loreRaw) {
        // Legacy fallback: No loreChunks generated yet, just dump the raw text.
        systemParts.push(context.loreRaw);
    }

    // === 3b. Inject active NPCs from the Ledger ===
    // When not condensed, we look at full history which might be huge, but candidateMessages is filtered below.
    // Let's do a quick pass over the veribiage that will be sent.
    const candidateMessagesToScan = condensedSummary
        ? history.slice(-getVerbatimWindow())
        : history.slice(-10); // Look at last 10 messages max for NPC presence to save scanning everything

    if (npcLedger && npcLedger.length > 0) {
        const allTextForNPC = candidateMessagesToScan.map(m => m.content || '').join(' ') + ' ' + userMessage;
        const activeNPCs = npcLedger.filter(npc => {
            if (!npc.name) return false;
            // Safely parse aliases just in case it's undefined or empty
            const aliasesRaw = npc.aliases || '';
            const names = [npc.name, ...aliasesRaw.split(',').map(a => a.trim()).filter(Boolean)];

            return names.some(name => {
                // Word boundary search to avoid sub-word matching
                const regex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`, 'i');
                return regex.test(allTextForNPC);
            });
        });

        if (activeNPCs.length > 0) {
            console.log(`[NPC Ledger] Injected ${activeNPCs.length} active NPC(s) into LLM context:`, activeNPCs.map(n => n.name).join(', '));
            const npcBlocks = activeNPCs.map(npc => {
                return `[NPC LEDGER RECORD: ${npc.name.toUpperCase()}]\n` +
                    `Aliases: ${npc.aliases || 'None'}\n` +
                    `Status: ${npc.status || 'Alive'}\n` +
                    `Appearance: ${npc.appearance || 'None'}\n` +
                    `Disposition: ${npc.disposition || 'None'}\n` +
                    `Goals: ${npc.goals || 'None'}\n` +
                    `Axes (1=Low, 10=Extreme):\n` +
                    `- Nature: ${npc.nature}/10\n` +
                    `- Training: ${npc.training}/10\n` +
                    `- Emotion: ${npc.emotion}/10\n` +
                    `- Social: ${npc.social}/10\n` +
                    `- Belief: ${npc.belief}/10\n` +
                    `- Ego: ${npc.ego}/10\n` +
                    `[END RECORD]`;
            });
            systemParts.push(`[ACTIVE NPC CONTEXT]\n${npcBlocks.join('\\n\\n')}\n[END ACTIVE NPC CONTEXT]`);
        }
    }

    const systemContent = systemParts.join('\n\n');
    const systemTokens = estimateTokens(systemContent);
    const userTokens = estimateTokens(userMessage);
    const budget = settings.contextLimit - systemTokens - userTokens;

    // === 3. Select which history messages to include ===
    // When condensed: ONLY send the verbatim window (last 5 messages)
    // When not condensed: walk backwards from full history until budget runs out
    const candidateMessages = condensedSummary
        ? history.slice(-getVerbatimWindow())
        : history;

    const fitted: OpenAIMessage[] = [];
    let used = 0;
    for (let i = candidateMessages.length - 1; i >= 0; i--) {
        const msg = candidateMessages[i];
        // estimate tokens from content or from serialized tool payload
        const textToEstimate = msg.content || JSON.stringify(msg.tool_calls || '') || '';
        const cost = estimateTokens(textToEstimate);
        if (used + cost > budget) break;

        const openAIMsg: OpenAIMessage = {
            role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
            content: msg.content || null
        };
        if (msg.name) openAIMsg.name = msg.name;
        if (msg.tool_calls) openAIMsg.tool_calls = msg.tool_calls;
        if (msg.tool_call_id) openAIMsg.tool_call_id = msg.tool_call_id;

        fitted.unshift(openAIMsg);
        used += cost;
    }

    // === 4. Assemble final payload: system → history → user (bottom) ===
    const messages: OpenAIMessage[] = [];
    if (systemContent) {
        messages.push({ role: 'system', content: systemContent });
    }
    messages.push(...fitted);
    messages.push({ role: 'user', content: userMessage });

    return messages;
}

export async function sendMessage(
    provider: ProviderConfig,
    messages: OpenAIMessage[],
    onChunk: (text: string) => void,
    onDone: (toolCall?: { id: string, name: string, arguments: string }) => void,
    onError: (err: string) => void,
    tools?: any[]
): Promise<void> {
    const url = `${provider.endpoint.replace(/\/+$/, '')}/chat/completions`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    try {
        const payload: any = {
            model: provider.modelName,
            messages,
            stream: true,
        };
        if (tools && tools.length > 0) {
            payload.tools = tools;
        }

        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
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

        let tcId = '';
        let tcName = '';
        let tcArgs = '';

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
                    const delta = parsed.choices?.[0]?.delta;

                    if (delta?.content) {
                        fullText += delta.content;
                        onChunk(fullText);
                    }

                    if (delta?.tool_calls && delta.tool_calls.length > 0) {
                        const tc = delta.tool_calls[0];
                        if (tc.id) tcId = tc.id;
                        if (tc.function?.name) tcName = tc.function.name;
                        if (tc.function?.arguments) tcArgs += tc.function.arguments;
                    }
                } catch {
                    // skip malformed chunks
                }
            }
        }

        // --- DeepSeek / Local Model Fallback Parsing ---
        // Some models output tool calls as text tags instead of actual JSON `tool_calls` array
        if (!tcName && fullText.includes('<｜DSML｜function_calls>')) {
            const funcMatch = fullText.match(/<｜DSML｜invoke name="([^"]+)">/);
            if (funcMatch) {
                tcName = funcMatch[1];
                tcId = uid(); // Generate a fake ID since it was just text

                // Try to extract parameters using basic regex (DeepSeek string format)
                // <｜DSML｜parameter name="query" string="true">lore</｜DSML｜parameter>
                // We'll capture both the parameter name and the text content inside the tags.
                const paramRegex = /<｜DSML｜parameter name="([^"]+)"[^>]*>([\s\S]*?)<\/｜DSML｜parameter>/g;
                let match;
                const argsObj: Record<string, any> = {};

                while ((match = paramRegex.exec(fullText)) !== null) {
                    argsObj[match[1]] = match[2].trim();
                }

                if (Object.keys(argsObj).length > 0) {
                    tcArgs = JSON.stringify(argsObj);
                } else {
                    // Fallback to searching the entire DSML tag content just in case
                    const fallbackQueryMatch = fullText.match(/>([^<]+)<\/｜DSML｜parameter>/);
                    if (fallbackQueryMatch) {
                        tcArgs = JSON.stringify({ query: fallbackQueryMatch[1].trim() });
                    } else if (fullText.includes('string="true">')) {
                        const directMatch = fullText.split('string="true">')[1]?.split('</')[0];
                        if (directMatch) {
                            tcArgs = JSON.stringify({ query: directMatch.trim() });
                        }
                    }
                }

                // Clean the fullText so the user doesn't see the raw XML junk in the UI 
                // if it happens to bypass the ChatArea tool filter
                fullText = fullText.split('<｜DSML｜function_calls>')[0].trim();
                onChunk(fullText); // Push the cleaned text back to UI
            }
        }

        if (tcName) {
            onDone({ id: tcId, name: tcName, arguments: tcArgs });
        } else {
            onDone();
        }
    } catch (err) {
        onError(err instanceof Error ? err.message : 'Unknown network error');
    }
}

export async function testConnection(provider: ProviderConfig): Promise<{ ok: boolean; detail: string }> {
    const url = `${provider.endpoint.replace(/\/+$/, '')}/models`;
    const headers: Record<string, string> = {};
    if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
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

export async function generateNPCProfile(
    provider: ProviderConfig,
    history: ChatMessage[],
    npcName: string,
    addNPCToStore: (npc: NPCEntry) => void
): Promise<void> {
    try {
        console.log(`[NPC Generator] Initiating background profile generation for: ${npcName}`);

        // Grab recent context (last ~15 messages should give enough flavor)
        const recentHistory = history.slice(-15).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

        const systemPrompt = `You are a background GM assistant running silently.
The game mentioned a new character named "${npcName}".
Your job is to generate a psychological profile for this character based on the recent chat history.
If the character is barely mentioned, invent a plausible, tropes-appropriate profile that fits the current scene context.

RESPOND ONLY WITH VALID JSON. NO MARKDOWN FORMATTING. NO EXPLANATIONS.
The JSON must perfectly match this structure:
{
  "name": "String (The primary name)",
  "aliases": "String (Comma separated aliases or titles)",
  "status": "String (Alive, Deceased, Missing, or Unknown)",
  "appearance": "String (Brief visual description)",
  "disposition": "String (Helpful, Hostile, Suspicion, etc)",
  "goals": "String (Core motive)",
  "nature": 5,
  "training": 5,
  "emotion": 5,
  "social": 5,
  "belief": 5,
  "ego": 5
}
Note: the 6 axes (nature...ego) MUST be integers from 1 to 10.`;

        const messages: OpenAIMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `RECENT CHAT HISTORY:\n${recentHistory}\n\nGenerate the JSON profile for "${npcName}".` }
        ];

        let fullJsonStr = '';

        await sendMessage(
            provider,
            messages,
            (chunk) => { fullJsonStr = chunk; },
            () => { }, // onDone
            (err) => console.error('[NPC Generator] Error:', err)
        );

        if (fullJsonStr) {
            // Strip potential markdown code blocks if the LLM ignored instructions
            let cleanStr = fullJsonStr.replace(/```json/gi, '').replace(/```/g, '').trim();

            try {
                const parsed = JSON.parse(cleanStr);

                // Construct the full object with a new ID
                const newEntry: NPCEntry = {
                    id: uid(),
                    name: parsed.name || npcName,
                    aliases: parsed.aliases || '',
                    status: parsed.status || 'Alive',
                    appearance: parsed.appearance || 'Unknown',
                    disposition: parsed.disposition || 'Neutral',
                    goals: parsed.goals || 'Unknown',
                    nature: Number(parsed.nature) || 5,
                    training: Number(parsed.training) || 5,
                    emotion: Number(parsed.emotion) || 5,
                    social: Number(parsed.social) || 5,
                    belief: Number(parsed.belief) || 5,
                    ego: Number(parsed.ego) || 5,
                };

                addNPCToStore(newEntry);
                console.log(`[NPC Generator] Successfully generated and added profile for: ${newEntry.name}`);

            } catch (parseErr) {
                console.error('[NPC Generator] Failed to parse generated JSON:', parseErr, '\nRaw String:', cleanStr);
            }
        }

    } catch (err) {
        console.error('[NPC Generator] Fatal error during generation:', err);
    }
}

/**
 * Background auto-update for existing NPCs that were mentioned in the chat.
 * Asks the LLM if any relevant attributes have changed based on recent context.
 */
export async function updateExistingNPCs(
    provider: ProviderConfig,
    history: ChatMessage[],
    npcsToCheck: NPCEntry[],
    updateNPCStore: (id: string, updates: Partial<NPCEntry>) => void
) {
    if (!npcsToCheck.length) return;

    console.log(`[NPC Updater] Checking for attribute shifts on ${npcsToCheck.length} existing NPC(s)...`);

    const recentContext = history.slice(-5).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    const npcDatas = npcsToCheck.map(npc => {
        return `[NPC: ${npc.name}]\n` +
            `Status: ${npc.status || 'Alive'}\n` +
            `Disposition: ${npc.disposition || 'Unknown'}\n` +
            `Goals: ${npc.goals || 'Unknown'}\n` +
            `Axes: Nature=${npc.nature}/10, Training=${npc.training}/10, Emotion=${npc.emotion}/10, Social=${npc.social}/10, Belief=${npc.belief}/10, Ego=${npc.ego}/10\n`
    }).join('\n\n');

    const prompt = `You are a background game state analyzer. Your job is to read the RECENT CONTEXT of an RPG session and determine if any of the provided NPCs have undergone a shift in their status, personality axes, goals, or disposition.

[RECENT CONTEXT]
${recentContext}
[END CONTEXT]

[CURRENT NPC STATES]
${npcDatas}
[END STATES]

If NO changes occurred for ANY of these NPCs, respond EXACTLY with:
{"updates": []}

If ANY changes occurred, respond with a JSON object containing an "updates" array. Each update must include the basic "name" and ANY attributes that have fundamentally changed (status, disposition, goals, nature, training, emotion, social, belief, ego). DO NOT include attributes that stayed the same.
Valid statuses: Alive, Deceased, Missing, Unknown.

Example of an NPC dying and getting angry:
{"updates": [{"name": "Captain Vorin", "changes": {"status": "Deceased", "emotion": 9}}]}

RESPOND ONLY WITH VALID JSON.`;

    const messages: OpenAIMessage[] = [{
        role: 'user',
        content: prompt
    }];

    try {
        let fullJsonStr = '';
        await sendMessage(
            provider,
            messages,
            (chunk) => { fullJsonStr = chunk; },
            () => { }, // onDone
            (err) => console.error('[NPC Updater] Error:', err)
        );

        if (fullJsonStr) {
            let cleanStr = fullJsonStr.replace(/```json/gi, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanStr);

            if (parsed.updates && Array.isArray(parsed.updates)) {
                for (const update of parsed.updates) {
                    if (!update.name || !update.changes) continue;

                    // Find matching NPC (case-insensitive)
                    const targetNpc = npcsToCheck.find(n =>
                        n.name.toLowerCase() === update.name.toLowerCase() ||
                        (n.aliases && n.aliases.toLowerCase().includes(update.name.toLowerCase()))
                    );

                    if (targetNpc) {
                        // Apply updates
                        updateNPCStore(targetNpc.id, update.changes);
                        console.log(`[NPC Updater] Applied changes to ${targetNpc.name}:`, update.changes);
                    }
                }
            } else {
                console.log(`[NPC Updater] No updates required.`);
            }
        }
    } catch (err) {
        console.error('[NPC Updater] Failed to parse generated JSON or fatal error:', err);
    }
}

