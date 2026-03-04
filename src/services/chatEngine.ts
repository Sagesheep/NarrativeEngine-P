import type { AppSettings, ChatMessage, GameContext, LoreChunk, EndpointConfig, ProviderConfig, NPCEntry, ArchiveChunk } from '../types';
import { countTokens } from './tokenizer';

export type OpenAIMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    name?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
};

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}


export function buildPayload(
    settings: AppSettings,
    context: GameContext,
    history: ChatMessage[],
    userMessage: string,
    condensedSummary?: string,
    condensedUpToIndex?: number,
    relevantLore?: LoreChunk[],
    npcLedger?: NPCEntry[],
    archiveRecall?: ArchiveChunk[]
): OpenAIMessage[] {
    // === 1. Build system prompt (protected — never compressed) ===
    const systemParts: string[] = [];

    // Static parts first for better LLM prefix caching!
    if (context.rulesRaw) systemParts.push(context.rulesRaw);

    // Template fields (only when toggled on)
    if (context.canonStateActive && context.canonState) systemParts.push(context.canonState);
    if (context.headerIndexActive && context.headerIndex) systemParts.push(context.headerIndex);
    if (context.starterActive && context.starter) systemParts.push(context.starter);
    if (context.continuePromptActive && context.continuePrompt) systemParts.push(context.continuePrompt);
    if (context.inventoryActive && context.inventory) systemParts.push(`[PLAYER INVENTORY]\n${context.inventory}`);

    // === 2. Condensed history — SEPARATE message so static rules are always prefix-cached ===
    let condensedContent = '';
    if (condensedSummary) {
        condensedContent = `[CONDENSED SESSION HISTORY]\n${condensedSummary}\n[END CONDENSED HISTORY]`;
    }

    const dynamicSystemParts: string[] = [];

    // === 2b. Archive Recall (Tier 4 — long-term memory) ===
    if (archiveRecall && archiveRecall.length > 0) {
        const recallText = archiveRecall
            .map(c => `[${c.sceneRange}]\n${c.summary}`)
            .join('\n\n');
        dynamicSystemParts.push(`[ARCHIVE RECALL]\n${recallText}\n[END ARCHIVE RECALL]`);
    }

    // === 3. Inject dynamic RAG Lore (DYNAMIC SUFFIX) ===
    if (relevantLore !== undefined) {
        // RAG is active for this campaign. 
        if (relevantLore.length > 0) {
            const loreBlock = relevantLore
                .map((c) => `### ${c.header}\n${c.content}`)
                .join('\n\n');
            dynamicSystemParts.push(`[WORLD LORE — RELEVANT SECTIONS]\n${loreBlock}\n[END WORLD LORE]`);
        }
    } else if (context.loreRaw) {
        // Legacy fallback: No loreChunks generated yet, just dump the raw text.
        dynamicSystemParts.push(context.loreRaw);
    }

    // === 3b. Inject active NPCs from the Ledger (DYNAMIC SUFFIX) ===
    // We only need to scan the recent context for active NPCs to save processing.
    // Scanning the last 10 messages is enough to catch anyone currently relevant.
    const candidateMessagesToScan = history.length > 10
        ? history.slice(-10)
        : history;

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
            console.log(`[NPC Ledger] Injected ${activeNPCs.length} active NPC(s):`, activeNPCs.map(n => n.name).join(', '));
            const npcLines = activeNPCs.map(npc => {
                const aliases = npc.aliases ? ` (${npc.aliases})` : '';
                return `[${npc.name.toUpperCase()}${aliases}] Faction: ${npc.faction || '?'} | Relevance: ${npc.storyRelevance || '?'} | Status: ${npc.status || 'Alive'} | Disp: ${npc.disposition || '?'} | Goals: ${npc.goals || '?'} | N:${npc.nature} T:${npc.training} E:${npc.emotion} S:${npc.social} B:${npc.belief} G:${npc.ego}`;
            });
            dynamicSystemParts.push(`[ACTIVE NPC CONTEXT]\n${npcLines.join('\n')}\n[END NPC CONTEXT]`);
        }
    }

    // === 3c. Player Inventory & Powers (DYNAMIC SUFFIX) ===
    // Placed directly before user message so character sheet updates don't kill the history cache
    if (context.characterProfileActive && context.characterProfile) {
        dynamicSystemParts.push(`[CHARACTER PROFILE]\n${context.characterProfile}`);
    }

    if (context.inventoryActive && context.inventory) {
        dynamicSystemParts.push(`[PLAYER INVENTORY]\n${context.inventory}`);
    }

    const systemContent = systemParts.join('\n\n');
    const dynamicSystemContent = dynamicSystemParts.join('\n\n');
    // Token math for window constraint
    const systemTokens = countTokens(systemContent);
    const condensedTokens = countTokens(condensedContent);
    const dynamicSystemTokens = countTokens(dynamicSystemContent);
    const userTokens = countTokens(userMessage);
    const budget = settings.contextLimit - systemTokens - condensedTokens - dynamicSystemTokens - userTokens;

    // === 4. Select which history messages to include ===
    // STRICT PREFIX CACHING: We MUST NOT use a rolling window like slice(-5). 
    // Dropping the oldest message every turn invalidates the entire history prefix cache.
    // Instead, we use a static append-only array since the last condense marker.
    const candidateMessages = (condensedSummary && condensedUpToIndex !== undefined && condensedUpToIndex >= 0)
        ? history.slice(condensedUpToIndex + 1)
        : history;

    const fitted: OpenAIMessage[] = [];
    let used = 0;
    for (let i = candidateMessages.length - 1; i >= 0; i--) {
        const msg = candidateMessages[i];
        // estimate tokens from content or from serialized tool payload
        const textToEstimate = msg.content || JSON.stringify(msg.tool_calls || '') || '';
        const cost = countTokens(textToEstimate);
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

    // === 5. Assemble: Static → Condensed → History → Dynamic(Lore+NPC) → User ===
    const messages: OpenAIMessage[] = [];
    if (systemContent) {
        messages.push({ role: 'system', content: systemContent });
    }
    if (condensedContent) {
        messages.push({ role: 'system', content: condensedContent });
    }
    messages.push(...fitted);
    if (dynamicSystemContent) {
        messages.push({ role: 'system', content: dynamicSystemContent });
    }
    messages.push({ role: 'user', content: userMessage });

    return messages;
}

export async function sendMessage(
    provider: EndpointConfig | ProviderConfig,
    messages: OpenAIMessage[],
    onChunk: (text: string) => void,
    onDone: (toolCall?: { id: string, name: string, arguments: string }) => void,
    onError: (err: string) => void,
    tools?: unknown[]
) {
    const url = `${provider.endpoint.replace(/\/+$/, '')}/chat/completions`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    try {
        const payload: Record<string, unknown> = {
            model: provider.modelName,
            messages,
            stream: true,
        };
        if (tools && tools.length > 0) {
            payload.tools = tools;
        }

        const controller = new AbortController();
        let timeoutId = setTimeout(() => controller.abort(), 120000); // 120 seconds timeout

        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        if (!res.ok) {
            clearTimeout(timeoutId);
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
            clearTimeout(timeoutId);
            if (done) break;

            timeoutId = setTimeout(() => controller.abort(), 120000); // reset timeout for next chunk

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
                const argsObj: Record<string, unknown> = {};

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

export async function testConnection(provider: EndpointConfig | ProviderConfig): Promise<{ ok: boolean; detail: string }> {
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
    provider: EndpointConfig | ProviderConfig,
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
  "faction": "String (The faction, group, or origin this NPC belongs to)",
  "storyRelevance": "String (Why this NPC matters to the current story)",
  "visualProfile": {
    "race": "String (e.g. Human, Elf)",
    "gender": "String",
    "ageRange": "String",
    "build": "String",
    "symmetry": "String (e.g. symmetrical features for handsome, rugged, asymmetrical/pockmarked for ugly)",
    "hairStyle": "String",
    "eyeColor": "String",
    "skinTone": "String",
    "gait": "String",
    "distinctMarks": "String",
    "clothing": "String"
  },
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
            const cleanStr = fullJsonStr.replace(/```json/gi, '').replace(/```/g, '').trim();

            try {
                const parsed = JSON.parse(cleanStr);

                const newEntry: NPCEntry = {
                    id: uid(),
                    name: parsed.name || npcName,
                    aliases: parsed.aliases || '',
                    status: parsed.status || 'Alive',
                    faction: parsed.faction || 'Unknown',
                    storyRelevance: parsed.storyRelevance || 'Unknown',
                    appearance: '', // legacy
                    visualProfile: parsed.visualProfile || {
                        race: 'Unknown', gender: 'Unknown', ageRange: 'Unknown', build: 'Unknown', symmetry: 'Unknown', hairStyle: 'Unknown', eyeColor: 'Unknown', skinTone: 'Unknown', gait: 'Unknown', distinctMarks: 'None', clothing: 'Unknown'
                    },
                    disposition: parsed.disposition || 'Neutral',
                    goals: parsed.goals || 'Unknown',
                    nature: Number(parsed.nature) || 5,
                    training: Number(parsed.training) || 5,
                    emotion: Number(parsed.emotion) || 5,
                    social: Number(parsed.social) || 5,
                    belief: Number(parsed.belief) || 5,
                    ego: Number(parsed.ego) || 5,
                    affinity: 50,
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
 * AI-powered tag population for Surprise & World engines.
 * Sends current tags + world lore to the AI, returns 3-12 contextually relevant tags.
 */
export async function populateEngineTags(
    provider: EndpointConfig | ProviderConfig,
    worldLore: string,
    currentTags: string[],
    field: 'surpriseTypes' | 'surpriseTones' | 'worldWho' | 'worldWhere' | 'worldWhy' | 'worldWhat'
): Promise<string[]> {
    const fieldDescriptions: Record<typeof field, string> = {
        surpriseTypes: 'surprise event TYPES (e.g. ENVIRONMENTAL_HAZARD, NPC_ACTION, BEAST_BEHAVIOR). These are categories of unexpected events that can occur during gameplay.',
        surpriseTones: 'surprise event TONES (e.g. TERRIFYING, HILARIOUS, MYSTERIOUS). These describe the emotional flavor of the surprise.',
        worldWho: '"Who" elements for world events — the actors/instigators (e.g. "a rogue splinter group", "a powerful leader").',
        worldWhere: '"Where" elements for world events — the locations (e.g. "in a neighboring city", "deep underground").',
        worldWhy: '"Why" elements for world events — the motivations (e.g. "to seize power", "for brutal vengeance").',
        worldWhat: '"What" elements for world events — the actions taken (e.g. "declared open hostilities", "formed an unexpected alliance").',
    };

    const prompt = `You are a Campaign Tag Generator. Your job is to analyze the provided WORLD LORE and CURRENT TAGS, then generate contextually appropriate tags that fit this specific campaign's theme, factions, locations, and tone.

[FIELD TO GENERATE]
${fieldDescriptions[field]}

[CURRENT TAGS — Use as reference for format and style]
${currentTags.join(', ')}

[WORLD LORE — Use to make tags thematically relevant]
${worldLore.slice(0, 6000)}

RULES:
- Generate MINIMUM 3 and MAXIMUM 12 tags.
- Tags must be thematically appropriate for this specific campaign world.
- Keep the same format style as the current tags (uppercase for surprise types/tones, descriptive phrases for world engine).
- Do NOT repeat any current tags verbatim — generate NEW ones inspired by the lore.
- RESPOND ONLY WITH A VALID JSON ARRAY OF STRINGS. No markdown, no explanation.

Example output: ["TAG_ONE", "TAG_TWO", "TAG_THREE"]`;

    const messages: OpenAIMessage[] = [
        { role: 'user', content: prompt }
    ];

    let fullJsonStr = '';

    await sendMessage(
        provider,
        messages,
        (chunk) => { fullJsonStr = chunk; },
        () => { },
        (err) => console.error('[Tag Populator] Error:', err)
    );

    if (fullJsonStr) {
        const cleanStr = fullJsonStr.replace(/```json/gi, '').replace(/```/g, '').trim();
        try {
            const parsed = JSON.parse(cleanStr);
            if (Array.isArray(parsed) && parsed.length >= 3 && parsed.every((t: unknown) => typeof t === 'string')) {
                console.log(`[Tag Populator] Generated ${parsed.length} tags for ${field}:`, parsed);
                return parsed.slice(0, 12);
            }
        } catch (e) {
            console.error('[Tag Populator] Failed to parse JSON:', e, '\nRaw:', cleanStr);
        }
    }

    return currentTags; // Fallback to current tags if generation fails
}

/**
 * Background auto-update for existing NPCs that were mentioned in the chat.
 * Asks the LLM if any relevant attributes have changed based on recent context.
 */
export async function updateExistingNPCs(
    provider: EndpointConfig | ProviderConfig,
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
            `Appearance: ${npc.appearance || 'Unknown'}\n` +
            `Disposition: ${npc.disposition || 'Unknown'}\n` +
            `Goals: ${npc.goals || 'Unknown'}\n` +
            `Affinity: ${npc.affinity ?? 50}/100\n` +
            `Axes: Nature=${npc.nature}/10, Training=${npc.training}/10, Emotion=${npc.emotion}/10, Social=${npc.social}/10, Belief=${npc.belief}/10, Ego=${npc.ego}/10\n` +
            `Faction: ${npc.faction || 'Unknown'}\n` +
            `Story Relevance: ${npc.storyRelevance || 'Unknown'}\n`
    }).join('\n\n');

    const prompt = `You are a background game state analyzer. Your job is to read the RECENT CONTEXT of an RPG session and determine if any of the provided NPCs have undergone a shift in their status, psychological axes, goals, disposition, faction, or relevance.

[RECENT CONTEXT]
${recentContext}
[END CONTEXT]

[CURRENT NPC STATES]
${npcDatas}
[END STATES]

If NO changes occurred for ANY of these NPCs, respond EXACTLY with:
{"updates": []}

If ANY changes occurred, respond with a JSON object containing an "updates" array. Each update must include the basic "name" and ANY attributes that have fundamentally changed (status, disposition, goals, nature, training, emotion, social, belief, ego, affinity, faction, storyRelevance, visualProfile). DO NOT include attributes that stayed the same.
Valid statuses: Alive, Deceased, Missing, Unknown.
Note: "affinity" is a 0-100 scale of how much they like the player (0=Nemesis, 50=Neutral, 100=Ally). Update this if the player did something to gain or lose favor.

Example of an NPC dying and getting angry:
{"updates": [{"name": "Captain Vorin", "changes": {"status": "Deceased", "emotion": 9, "storyRelevance": "His death sparked a rebellion"}}]}

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
            const cleanStr = fullJsonStr.replace(/```json/gi, '').replace(/```/g, '').trim();
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

