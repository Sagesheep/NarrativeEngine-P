import type { AppSettings, ChatMessage, GameContext, LoreChunk, EndpointConfig, ProviderConfig, NPCEntry, ArchiveScene, PayloadTrace } from '../types';
import { countTokens } from './tokenizer';
import { formatQuestDigest } from './questTracker';

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

/**
 * Robustly extracts the first JSON object or array found in a text string.
 * Handles <think> tags, markdown code blocks, and leading/trailing chatter.
 */
function extractJson(text: string): string {
    // 1. Remove reasoning blocks if present
    let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '');

    // 2. Try to find content between triple backticks first
    const markdownMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (markdownMatch) {
        clean = markdownMatch[1];
    }

    // 3. Final fallback: find the first { or [ and the last } or ]
    const firstObj = clean.indexOf('{');
    const firstArr = clean.indexOf('[');
    const start = (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) ? firstObj : firstArr;

    if (start !== -1) {
        const lastObj = clean.lastIndexOf('}');
        const lastArr = clean.lastIndexOf(']');
        const end = (lastObj !== -1 && (lastArr === -1 || lastObj > lastArr)) ? lastObj : lastArr;

        if (end !== -1 && end > start) {
            return clean.substring(start, end + 1).trim();
        }
    }

    return clean.trim();
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
    archiveRecall?: ArchiveScene[],
    sceneNumber?: string
): { messages: OpenAIMessage[]; trace?: PayloadTrace[] } {
    const trace: PayloadTrace[] = [];
    const isDebug = settings.debugMode === true;
    const limit = settings.contextLimit || 8192;

    // --- 1. Define Budgets (ST-inspired proportionality) ---
    // Protect core truth, but ensure history isn't completely starved.
    const budgetMap = {
        stable: Math.floor(limit * 0.25),   // Rules, Canon, Index, Scene# (Max 25%)
        summary: Math.floor(limit * 0.10),  // Condensed summary (Max 10%)
        world: Math.floor(limit * 0.40),    // Lore, NPCs, Archive Recall (Max 40%)
        volatile: Math.floor(limit * 0.10), // Profile, Inventory (Max 10%)
        // History + User message take the remainder
    };

    // Helper to log to trace if debug
    const addTrace = (t: PayloadTrace) => {
        if (isDebug) trace.push(t);
    };

    // --- 2. Calculate Stable Truth & Summary (High Priority) ---
    const stableParts: string[] = [];
    if (sceneNumber) stableParts.push(`[CURRENT SCENE: #${sceneNumber}]`);
    if (context.rulesRaw) stableParts.push(context.rulesRaw);
    if (context.canonStateActive && context.canonState) stableParts.push(context.canonState);
    if (context.headerIndexActive && context.headerIndex) stableParts.push(context.headerIndex);
    if (context.starterActive && context.starter) stableParts.push(context.starter);
    if (context.continuePromptActive && context.continuePrompt) stableParts.push(context.continuePrompt);

    const reasoningSafety = "IMPORTANT: If you use a 'thinking' or 'reasoning' block (<think>...</think>), you MUST still provide the full narrative response AFTER the closing tag. Never end a turn with only a thinking block.";
    stableParts.push(reasoningSafety);

    const stableContent = stableParts.join('\n\n');
    const stableTokens = countTokens(stableContent);
    addTrace({ source: 'Stable Preamble', classification: 'stable_truth', tokens: stableTokens, reason: 'Rules & Core state', included: true, position: 'system_static' });

    let summaryContent = '';
    if (condensedSummary) {
        summaryContent = `[CONDENSED SESSION HISTORY]\n${condensedSummary}\n[END CONDENSED HISTORY]`;
    }
    const summaryTokens = countTokens(summaryContent);
    addTrace({ source: 'Condensed Summary', classification: 'summary', tokens: summaryTokens, reason: 'Compressed session history', included: !!summaryContent, position: 'system_summary' });

    // --- 3. Gather trimmable World Context (Medium Priority) ---
    const worldBlocks: { source: string; content: string; tokens: number; reason: string }[] = [];

    // Archive Recall
    if (archiveRecall && archiveRecall.length > 0) {
        // Simple dedupe against active history
        const activeAssistantContents = history
            .slice((condensedUpToIndex ?? -1) + 1)
            .filter(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.length > 20)
            .map(m => m.content as string);

        const filteredRecall = archiveRecall.filter(scene => {
            if (activeAssistantContents.some(asst => scene.content.includes(asst))) return false;
            if (condensedSummary && scene.content.length > 100) {
                const slug = scene.content.slice(0, 100).toLowerCase();
                if (condensedSummary.toLowerCase().includes(slug)) return false;
            }
            return true;
        });

        if (filteredRecall.length > 0) {
            const text = `[ARCHIVE RECALL — VERBATIM PAST SCENES]\n${filteredRecall.map(s => `[SCENE #${s.sceneId}]\n${s.content}`).join('\n\n')}\n[END ARCHIVE RECALL]`;
            worldBlocks.push({ source: 'Archive Recall', content: text, tokens: countTokens(text), reason: `Verbatim history (${filteredRecall.length} scenes)` });
        }
    }

    // RAG Lore
    if (relevantLore && relevantLore.length > 0) {
        const text = `[WORLD LORE — RELEVANT SECTIONS]\n${relevantLore.map(c => `### ${c.header}\n${c.content}`).join('\n\n')}\n[END WORLD LORE]`;
        worldBlocks.push({ source: 'RAG Lore', content: text, tokens: countTokens(text), reason: `RAG injected (${relevantLore.length} chunks)` });
    } else if (context.loreRaw) {
        worldBlocks.push({ source: 'Raw Lore (Legacy)', content: context.loreRaw, tokens: countTokens(context.loreRaw), reason: 'Legacy fallback' });
    }

    // Active NPCs
    if (npcLedger && npcLedger.length > 0) {
        const scanHistory = history.slice(-10).map(m => m.content || '').join(' ') + ' ' + userMessage;
        const loreHeadersSet = new Set((relevantLore ?? []).map(l => l.header.toLowerCase()));
        const activeNPCs = npcLedger.filter(npc => {
            if (!npc.name || loreHeadersSet.has(npc.name.toLowerCase())) return false;
            const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
            const patterns = [npc.name.toLowerCase(), ...aliases];
            return patterns.some(p => scanHistory.toLowerCase().includes(p));
        });

        if (activeNPCs.length > 0) {
            const npcText = `[ACTIVE NPC CONTEXT]\n${activeNPCs.map(npc => `[${npc.name.toUpperCase()}] Faction: ${npc.faction || '?'} | Goals: ${npc.goals || '?'} | Disp: ${npc.disposition || '?'}`).join('\n')}\n[END NPC CONTEXT]`;
            worldBlocks.push({ source: 'Active NPCs', content: npcText, tokens: countTokens(npcText), reason: `NPCs detected in context (${activeNPCs.length})` });
        }
    }

    // --- 4. Budget & Trim World Context ---
    let worldContent = '';
    let currentWorldTokens = 0;
    for (const block of worldBlocks) {
        if (currentWorldTokens + block.tokens <= budgetMap.world) {
            worldContent += (worldContent ? '\n\n' : '') + block.content;
            currentWorldTokens += block.tokens;
            addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: block.reason, included: true, position: 'system_dynamic' });
        } else {
            addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: `Dropped: Exceeds World budget (${budgetMap.world} t)`, included: false, position: 'system_dynamic' });
        }
    }

    // --- 5. Volatile State (Profile, Inventory) ---
    const volatileParts: string[] = [];
    if (context.characterProfileActive && context.characterProfile) volatileParts.push(`[CHARACTER PROFILE]\n${context.characterProfile}`);
    if (context.inventoryActive && context.inventory) volatileParts.push(`[PLAYER INVENTORY]\n${context.inventory}`);
    if (context.questLogActive && context.questLog?.length) {
        const questDigest = formatQuestDigest(context.questLog);
        if (questDigest) volatileParts.push(questDigest);
    }

    const volatileContent = volatileParts.join('\n\n');
    const volatileTokens = countTokens(volatileContent);
    addTrace({ source: 'Profile/Inventory', classification: 'volatile_state', tokens: volatileTokens, reason: 'Player state', included: true, position: 'system_dynamic' });

    // --- 6. Fit History ---
    const userTokens = countTokens(userMessage);
    const reservedTotal = stableTokens + summaryTokens + currentWorldTokens + volatileTokens + userTokens;
    const historyBudget = limit - reservedTotal - 200; // Small safety margin of 200 tokens

    const candidateMessages = (condensedSummary && condensedUpToIndex !== undefined && condensedUpToIndex >= 0)
        ? history.slice(condensedUpToIndex + 1)
        : history;

    const fitted: OpenAIMessage[] = [];
    let historyUsed = 0;
    for (let i = candidateMessages.length - 1; i >= 0; i--) {
        const msg = candidateMessages[i];
        const textToEstimate = msg.content || JSON.stringify(msg.tool_calls || '') || '';
        const cost = countTokens(textToEstimate);
        if (historyUsed + cost > historyBudget) break;

        const openAIMsg: OpenAIMessage = {
            role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
            content: msg.content ?? null
        };
        if (msg.name) openAIMsg.name = msg.name;
        if (msg.tool_calls) openAIMsg.tool_calls = msg.tool_calls;
        if (msg.tool_call_id) openAIMsg.tool_call_id = msg.tool_call_id;

        fitted.unshift(openAIMsg);
        historyUsed += cost;
    }

    // Protect orphaned tools
    while (fitted.length > 0 && fitted[0].role === 'tool') fitted.shift();

    addTrace({ source: 'Fitted History', classification: 'summary', tokens: historyUsed, reason: `Included ${fitted.length} msgs within ${historyBudget} budget`, included: true, position: 'history' });
    addTrace({ source: 'User Message', classification: 'volatile_state', tokens: userTokens, reason: 'Current turn', included: true, position: 'user' });

    // --- 7. Depth-Based Scene Note Insertion ---
    if (context.sceneNoteActive && context.sceneNote) {
        const noteText = `[SCENE NOTE: VOLATILE GUIDANCE]\n${context.sceneNote}`;
        const noteMsg: OpenAIMessage = { role: 'system', content: noteText };
        const depth = context.sceneNoteDepth ?? 3;

        // Splice into fitted history
        if (fitted.length > 0) {
            const index = Math.max(0, fitted.length - depth);
            fitted.splice(index, 0, noteMsg);
            addTrace({ source: 'Scene Note (Depth)', classification: 'scene_local', tokens: countTokens(noteText), reason: `Injected at depth ${depth}`, included: true, position: `history_at_${depth}` });
        } else {
            // Fallback to end of system prompt if no history
            fitted.push(noteMsg);
            addTrace({ source: 'Scene Note (Fallback)', classification: 'scene_local', tokens: countTokens(noteText), reason: 'Injected after system (no history)', included: true, position: 'dynamic_suffix' });
        }
    }

    // --- 8. Final Assembly ---
    const messages: OpenAIMessage[] = [];
    if (stableContent) messages.push({ role: 'system', content: stableContent });
    if (summaryContent) messages.push({ role: 'system', content: summaryContent });
    if (worldContent || volatileContent) {
        messages.push({ role: 'system', content: [worldContent, volatileContent].filter(Boolean).join('\n\n') });
    }
    messages.push(...fitted);
    messages.push({ role: 'user', content: userMessage });

    return { messages, trace: isDebug ? trace : undefined };
}

export async function sendMessage(
    provider: EndpointConfig | ProviderConfig,
    messages: OpenAIMessage[],
    onChunk: (text: string) => void,
    onDone: (text: string, toolCall?: { id: string; name: string; arguments: string }) => void,
    onError: (err: string) => void,
    tools?: unknown[],
    abortController?: AbortController
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

        const controller = abortController || new AbortController();
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
            onDone(fullText, { id: tcId, name: tcName, arguments: tcArgs });
        } else {
            onDone(fullText);
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
            const cleanStr = extractJson(fullJsonStr);

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
                        race: 'Unknown', gender: 'Unknown', ageRange: 'Unknown', build: 'Unknown', symmetry: 'Unknown', hairStyle: 'Unknown', eyeColor: 'Unknown', skinTone: 'Unknown', gait: 'Unknown', distinctMarks: 'None', clothing: 'Unknown', artStyle: 'Anime'
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
    field: 'surpriseTypes' | 'surpriseTones' | 'encounterTypes' | 'encounterTones' | 'worldWho' | 'worldWhere' | 'worldWhy' | 'worldWhat'
): Promise<string[]> {
    const fieldDescriptions: Record<typeof field, string> = {
        surpriseTypes: 'surprise event TYPES (e.g. WEATHER_SHIFT, ODD_SOUND, NPC_QUIRK). These are categories of unexpected ambient flavor events.',
        surpriseTones: 'surprise event TONES (e.g. CURIOUS, EERIE, AMUSING). These describe the emotional flavor of the surprise.',
        encounterTypes: 'encounter event TYPES (e.g. AMBUSH, RIVAL_APPEARANCE, RESOURCE_CRISIS). These are mid-stakes challenges or hooks requiring immediate player response.',
        encounterTones: 'encounter event TONES (e.g. TENSE, DESPERATE, MYSTERIOUS). These describe the emotional flavor of the encounter.',
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
        const cleanStr = extractJson(fullJsonStr);
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
        const vp = npc.visualProfile || { race: '', gender: '', ageRange: '', build: '', symmetry: '', hairStyle: '', eyeColor: '', skinTone: '', gait: '', distinctMarks: '', clothing: '' };
        const missingFields = Object.entries(vp)
            .filter(([key, val]) => key !== 'artStyle' && (!val || val === 'Unknown' || val === 'None'))
            .map(([key]) => key);

        let data = `[NPC: ${npc.name}]\n` +
            `Status: ${npc.status || 'Alive'}\n` +
            `Appearance: ${npc.appearance || 'Unknown'}\n` +
            `Disposition: ${npc.disposition || 'Unknown'}\n` +
            `Goals: ${npc.goals || 'Unknown'}\n` +
            `Affinity: ${npc.affinity ?? 50}/100\n` +
            `Axes: Nature=${npc.nature}/10, Training=${npc.training}/10, Emotion=${npc.emotion}/10, Social=${npc.social}/10, Belief=${npc.belief}/10, Ego=${npc.ego}/10\n` +
            `Faction: ${npc.faction || 'Unknown'}\n` +
            `Story Relevance: ${npc.storyRelevance || 'Unknown'}\n`;

        if (missingFields.length > 0) {
            data += `NOTE: This NPC has missing or generic "visualProfile" fields: ${missingFields.join(', ')}. You MUST attempt to determine specific values for these based on their "Appearance" and recent context.\n`;
        }
        return data;
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
            const cleanStr = extractJson(fullJsonStr);
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
                        // If AI provided visualProfile, ensure we get all fields, keeping defaults for missing ones
                        const changes = { ...update.changes };
                        if (changes.visualProfile && typeof changes.visualProfile === 'object') {
                            changes.visualProfile = {
                                ...targetNpc.visualProfile, // fallback to existing (even if unknown)
                                ...changes.visualProfile,
                                // Enforce artStyle persistence if they had one or set default
                                artStyle: targetNpc.visualProfile?.artStyle || 'Anime'
                            };
                        }

                        // Apply updates
                        updateNPCStore(targetNpc.id, changes);
                        console.log(`[NPC Updater] Applied changes to ${targetNpc.name}:`, changes);
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

// ============================================================================
// Image Generation API
// ============================================================================

export async function generateNPCPortrait(config: EndpointConfig, prompt: string): Promise<string> {
    if (!config.endpoint) {
        throw new Error('Image AI not configured');
    }

    const payload = {
        model: config.modelName || 'nano-banana',
        prompt,
        negative_prompt: "multiple people, group, crowd, split screen, twins, double, text, watermark, signature",
        size: '896x1152',
        response_format: 'url',
    };

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    // Normalize: strip trailing slashes and any pre-existing /images/generations suffix,
    // then always append the correct path. Works for both base endpoints and full paths.
    const baseEndpoint = config.endpoint
        .replace(/\/+$/, '')                   // strip trailing slashes
        .replace(/\/images\/generations$/, ''); // strip suffix if already present
    const url = `${baseEndpoint}/images/generations`;

    try {
        console.log('[Image Engine] Sending payload:', payload);
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Failed to generate image: ${err}`);
        }

        const data = await res.json();

        // Match nano-gpt return format
        if (data.data && data.data[0] && data.data[0].url) {
            return data.data[0].url;
        }

        throw new Error('Unexpected output format from Image AI: ' + JSON.stringify(data));
    } catch (error) {
        console.error('[Image Engine] Error generating portrait:', error);
        throw error;
    }
}

