import type { AppSettings, ChatMessage, GameContext, LoreChunk, NPCEntry, ArchiveScene, ArchiveIndexEntry, PayloadTrace, TimelineEvent, DebugSection, InventoryItemCategory, DivergenceRegister } from '../types';
import type { OpenAIMessage } from './llmService';
import { countTokens } from './tokenizer';
import { buildBehaviorDirective, buildDriftAlert, buildKnowledgeBoundary } from './npcBehaviorDirective';
import { minifyLoreChunk, minifyNPC, minifyBookkeepingStub, minifySelectedInventory, minifySelectedProfile } from './contextMinifier';
import { resolveTimeline, formatResolvedForContext } from './timelineResolver';
import { DEFAULT_RULES } from './defaultRules';
import { renderRegisterForPayload } from './divergenceRegister';

const TOOL_MODE_ACTION_RESOLUTION = `### ACTION RESOLUTION

Trigger: Player attempts an action with an uncertain outcome — combat hits, skill checks, saves, contested actions.

1. Identify core intent of the player's action.
2. If the outcome depends on chance, CALL the \`roll_dice\` tool BEFORE narrating. Do NOT narrate the outcome first.
   - \`dice\`: typically \`1d20\` for skill checks/attacks; use \`NdM\` form for damage or special rolls
   - \`reason\`: short label (e.g. "Stealth check vs guard", "Longsword attack")
   - \`category\`: one of Combat / Stealth / Social / Perception / Movement / Knowledge / Mundane (for d20 only)
3. Use the returned \`tier\` (Catastrophe / Failure / Success / Triumph / Narrative Boon) to shape the narrative — same outcome semantics as pool mode.
4. Do NOT call \`roll_dice\` for descriptive moments, dialogue, or trivial actions. Mundane actions resolve as plain success without a roll.

**Advantage selection (tool mode):** if the player explicitly leverages a known weakness or superior tool, call \`roll_dice\` twice and use the higher result. If explicitly impaired (blinded, wounded, overwhelmed), call twice and use the lower. Otherwise, single roll.

**Outcomes:**
- Catastrophe: severe unexpected failure, consequences beyond simple loss.
- Failure: fails. Damage, setback, or resource loss.
- Success: succeeds exactly as intended.
- Triumph: succeeds with an unexpected additional benefit.
- Narrative Boon: flawless. Massive strategic or narrative advantage.`;

function swapActionResolutionForToolMode(rules: string): string {
    const marker = '### ACTION RESOLUTION';
    const idx = rules.indexOf(marker);
    if (idx === -1) return rules;
    const nextSectionMatch = rules.substring(idx + marker.length).match(/\n### /);
    const endIdx = nextSectionMatch ? idx + marker.length + nextSectionMatch.index! : rules.length;
    return rules.substring(0, idx) + TOOL_MODE_ACTION_RESOLUTION + rules.substring(endIdx);
}

function computeNPCSalience(npc: NPCEntry, scanText: string): number {
    let score = 0;
    const lower = scanText.toLowerCase();
    const name = npc.name.toLowerCase();
    const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
    const patterns = [name, ...aliases];

    for (const p of patterns) {
        const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'g');
        const matches = lower.match(regex);
        if (matches) score += matches.length * 2;
    }

    if (npc.drives?.sceneWant) score += 1;
    if (npc.pressure?.engaged) score += npc.pressure.engaged * 1.5;
    if (npc.pressure?.ignored) score += npc.pressure.ignored * 2;

    if (npc.behavioralTriggers) {
        for (const trigger of npc.behavioralTriggers) {
            if (lower.includes(trigger.keyword.toLowerCase())) score += 4;
        }
    }

    return score;
}


/**
 * Robustly extracts the first JSON object or array found in a text string.
 * Handles <think> tags, markdown code blocks, and leading/trailing chatter.
 */
function repairJson(str: string): string {
    let r = str;

    r = r.replace(/,\s*([}\]])/g, '$1');

    r = r.replace(/\/\/[^\n]*/g, '');

    r = r.replace(/\/\*[\s\S]*?\*\//g, '');

    r = r.replace(
        /"([^"\\]*(\\.[^"\\]*)*)"\s*:/g,
        (match) => match
    );

    r = r.replace(/:\s*'"([^']*)'([,}\]])/g, ': "$1"$2');
    r = r.replace(/:\s*'([^']*)'([,}\]])/g, ': "$1"$2');
    r = r.replace(/\[\s*'/g, '["');
    r = r.replace(/'\s*,\s*'/g, '", "');
    r = r.replace(/'\s*]/g, '"]');
    r = r.replace(/"\s*:\s*'([^']*(?:\\.[^']*)*)'\s*([,}\]])/g, '"$1"$2');

    let inString = false;
    let escaped = false;
    let result = '';
    for (let i = 0; i < r.length; i++) {
        const ch = r[i];
        if (escaped) {
            result += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\' && inString) {
            result += ch;
            escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            result += ch;
            continue;
        }
        if (inString) {
            if (ch === '\n') { result += '\\n'; continue; }
            if (ch === '\r') { result += '\\r'; continue; }
            if (ch === '\t') { result += '\\t'; continue; }
            if (ch === '\x00') { continue; }
        }
        result += ch;
    }
    r = result;

    r = r.replace(/\}\s*\{/g, '},{');

    return r.trim();
}

export function extractJson(text: string): string {
    let clean = text.replace(/<think[\s\S]*?<\/think\s*>/gi, '');

    const markdownMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (markdownMatch) {
        clean = markdownMatch[1];
    }

    const firstObj = clean.indexOf('{');
    const firstArr = clean.indexOf('[');
    const start = (firstObj !== -1 && (firstArr === -1 || firstObj < firstArr)) ? firstObj : firstArr;

    if (start !== -1) {
        const lastObj = clean.lastIndexOf('}');
        const lastArr = clean.lastIndexOf(']');
        const end = (lastObj !== -1 && (lastArr === -1 || lastObj > lastArr)) ? lastObj : lastArr;

        if (end !== -1 && end > start) {
            return repairJson(clean.substring(start, end + 1).trim());
        }
    }

    return repairJson(clean.trim());
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
    sceneNumber?: string,
    recommendedNPCNames?: string[],
    _semanticFactText?: string,
    archiveIndex?: ArchiveIndexEntry[],
    timelineEvents?: TimelineEvent[],
    inventoryCategories?: (InventoryItemCategory | 'equipped')[],
    profileFields?: string[],
    deepContextSummary?: string,
    divergenceRegister?: DivergenceRegister
): { messages: OpenAIMessage[]; trace?: PayloadTrace[]; debugSections?: DebugSection[] } {
    const trace: PayloadTrace[] = [];
    const debugSections: DebugSection[] = [];
    const isDebug = settings.debugMode === true;
    const limit = settings.contextLimit || 8192;

    // --- 1. Define Budgets (ST-inspired proportionality) ---
    // Protect core truth, but ensure history isn't completely starved.
    const budgetMap = deepContextSummary
        ? {
            stable: Math.floor(limit * 0.15),
            summary: Math.floor(limit * 0.10),
            world: Math.floor(limit * 0.60),
            volatile: Math.floor(limit * 0.10),
        }
        : {
            stable: Math.floor(limit * 0.25),
            summary: Math.floor(limit * 0.10),
            world: Math.floor(limit * 0.40),
            volatile: Math.floor(limit * 0.10),
        };

    // Helper to log to trace if debug
    const addTrace = (t: PayloadTrace) => {
        if (isDebug) trace.push(t);
    };
    const addSection = (s: DebugSection) => {
        if (isDebug) debugSections.push(s);
    };

    // --- 2. Calculate Stable Truth & Summary (High Priority) ---
    const stableParts: string[] = [];
    if (sceneNumber) stableParts.push(`[CURRENT SCENE: #${sceneNumber}]\n[ENGINE: Scene header is auto-injected. Do NOT write "Scene #${sceneNumber}" yourself. Start your response with the date/location/NPCs line directly.]`);
    const effectiveRules = context.rulesRaw || DEFAULT_RULES;
    const rulesWithMode = context.diceFairnessActive === false
        ? swapActionResolutionForToolMode(effectiveRules)
        : effectiveRules;
    if (rulesWithMode) stableParts.push(rulesWithMode);
    if (context.canonStateActive && context.canonState) {
        stableParts.push(context.canonState);
    }
    if (context.headerIndexActive && context.headerIndex) stableParts.push(context.headerIndex);
    if (context.starterActive && context.starter) stableParts.push(context.starter);
    if (context.continuePromptActive && context.continuePrompt) stableParts.push(context.continuePrompt);

    // Only inject if using a known reasoning/thinking model (DeepSeek-R1, Qwen QwQ, etc.)
    const modelName = (settings as any).presets?.find?.((p: any) => p.id === (settings as any).activePresetId)?.storyAI?.modelName ?? '';
    const isReasoningModel = /deepseek-r|qwq|qwen.*think|r1/i.test(modelName);
    if (isReasoningModel) {
        stableParts.push("IMPORTANT: If you use a 'thinking' or 'reasoning' block (<think>...</think>), you MUST still provide the full narrative response AFTER the closing tag. Never end a turn with only a thinking block.");
    }

    const stableContent = stableParts.join('\n\n');
    const stableTokens = countTokens(stableContent);
    addTrace({ source: 'Stable Preamble', classification: 'stable_truth', tokens: stableTokens, reason: 'Rules & Core state', included: true, position: 'system_static' });
    addSection({ label: 'Stable Preamble', role: 'system', tokens: stableTokens, content: stableContent, classification: 'stable_truth' });

    let summaryContent = '';
    if (condensedSummary) {
        summaryContent = `[CONDENSED SESSION HISTORY]\n${condensedSummary}\n[END CONDENSED HISTORY]`;
    }
    const summaryTokens = countTokens(summaryContent);
    addTrace({ source: 'Condensed Summary', classification: 'summary', tokens: summaryTokens, reason: 'Compressed session history', included: !!summaryContent, position: 'system_summary' });
    addSection({ label: 'Condensed Summary', role: 'system', tokens: summaryTokens, content: summaryContent, classification: 'summary' });

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

    // Deep Archive Context
    if (deepContextSummary) {
        const text = `[DEEP ARCHIVE CONTEXT — AI-synthesized from full campaign history]\n${deepContextSummary}\n[END DEEP ARCHIVE CONTEXT]`;
        worldBlocks.push({ source: 'Deep Archive Context', content: text, tokens: countTokens(text), reason: 'Deep archive scan result' });
    }

    // RAG Lore — minified and grouped by category
    if (relevantLore && relevantLore.length > 0) {
        const grouped = new Map<string, string[]>();
        for (const chunk of relevantLore) {
            const cat = chunk.category || 'misc';
            const catTitle = cat === 'faction' ? 'FACTIONS'
                           : cat === 'character' ? 'CHARACTERS'
                           : cat === 'location' ? 'LOCATIONS'
                           : cat === 'power_system' || cat === 'rules' ? 'POWER SYSTEM & RULES'
                           : cat === 'economy' ? 'ECONOMY'
                           : cat === 'event' ? 'EVENTS'
                           : cat === 'world_overview' ? 'OVERVIEW'
                           : 'MISCELLANEOUS';
            
            if (!grouped.has(catTitle)) grouped.set(catTitle, []);
            grouped.get(catTitle)!.push(minifyLoreChunk(chunk));
        }

        const sections: string[] = [];
        for (const [title, chunks] of grouped.entries()) {
            sections.push(`[${title}]\n` + chunks.join('\n'));
        }

        const text = `[WORLD LORE — RELEVANT SECTIONS]\n${sections.join('\n\n')}\n[END WORLD LORE]`;
        worldBlocks.push({ source: 'RAG Lore', content: text, tokens: countTokens(text), reason: `RAG injected (${relevantLore.length} chunks, minified)` });
    } else if (context.loreRaw) {
        worldBlocks.push({ source: 'Raw Lore (Legacy)', content: context.loreRaw, tokens: countTokens(context.loreRaw), reason: 'Legacy fallback' });
    }

    // Resolved World State (Timeline)
    if (timelineEvents && timelineEvents.length > 0) {
        const resolved = resolveTimeline(timelineEvents);
        if (resolved.length > 0) {
            const resolvedText = formatResolvedForContext(resolved);
            worldBlocks.push({
                source: 'Resolved World State',
                content: resolvedText,
                tokens: countTokens(resolvedText),
                reason: `Timeline resolution: ${resolved.length} active truths from ${timelineEvents.length} events`
            });
        }
    }

    // Active NPCs
    if (npcLedger && npcLedger.length > 0) {
        const loreHeadersSet = new Set((relevantLore ?? []).filter(l => l.header).map(l => l.header!.toLowerCase()));

        let activeNPCs: NPCEntry[];

        if (recommendedNPCNames && recommendedNPCNames.length > 0) {
            // ── Utility AI Recommender mode ──
            // Use the pre-computed list from contextRecommender.ts
            const recommendedSet = new Set(recommendedNPCNames.map(n => n.toLowerCase()));
            activeNPCs = npcLedger.filter(npc => {
                if (!npc.name || loreHeadersSet.has(npc.name.toLowerCase())) return false;
                const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
                const allNames = [npc.name.toLowerCase(), ...aliases];
                return allNames.some(n => recommendedSet.has(n));
            });
            console.log(`[PayloadBuilder] NPC selection via UtilityAI recommender: ${activeNPCs.length} active.`);
        } else {
            // ── Legacy substring scan mode ──
            const scanHistory = history.slice(-10).map(m => m.content || '').join(' ') + ' ' + userMessage;
            activeNPCs = npcLedger.filter(npc => {
                if (!npc.name || loreHeadersSet.has(npc.name.toLowerCase())) return false;
                const aliases = (npc.aliases || '').split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
                const patterns = [npc.name.toLowerCase(), ...aliases];
                return patterns.some(p => scanHistory.toLowerCase().includes(p));
            });
        }

        if (activeNPCs.length > 0) {
            const scanText = history.slice(-10).map(m => m.content || '').join(' ') + ' ' + userMessage;
            const scored = activeNPCs.map(npc => ({ npc, score: computeNPCSalience(npc, scanText) }));
            scored.sort((a, b) => b.score - a.score);
            const spotlitNpc = scored[0].npc;

            const npcLines = activeNPCs.map(npc => {
                const isSpotlit = npc.id === spotlitNpc.id;
                let line = minifyNPC(npc);
                const directive = buildBehaviorDirective(npc);
                if (directive) line += ` | ${directive}`;

                if (isSpotlit && npc.drives) {
                    const driveParts: string[] = [];
                    if (npc.drives.coreWant) driveParts.push(`CoreWant: ${npc.drives.coreWant}`);
                    if (npc.drives.sessionWant) driveParts.push(`SessionWant: ${npc.drives.sessionWant}`);
                    if (npc.drives.sceneWant) driveParts.push(`SceneWant: ${npc.drives.sceneWant}`);
                    if (driveParts.length) line += `\n  DRIVES: ${driveParts.join(' | ')}`;
                }

                if (isSpotlit && npc.behavioralTriggers && npc.behavioralTriggers.length > 0) {
                    const triggerTexts = npc.behavioralTriggers.map(t => `if "${t.keyword}" → ${t.shift}`);
                    line += `\n  TRIGGERS: ${triggerTexts.join('; ')}`;
                }

                if (isSpotlit && npc.hardBoundaries && npc.hardBoundaries.length > 0) {
                    line += `\n  HARD LIMITS: ${npc.hardBoundaries.join('; ')}`;
                }
                if (isSpotlit && npc.softBoundaries && npc.softBoundaries.length > 0) {
                    line += `\n  SOFT LIMITS: ${npc.softBoundaries.join('; ')}`;
                }

                const drift = buildDriftAlert(npc);
                if (drift) line += ` | ${drift}`;
                if (archiveIndex) {
                    const boundary = buildKnowledgeBoundary(npc, archiveIndex);
                    if (boundary) line += `\n  ${boundary}`;
                }
                return line;
            });

            const npcText = `[ACTIVE NPC CONTEXT]\n${npcLines.join('\n')}\n[END NPC CONTEXT]`;
            worldBlocks.push({ source: 'Active NPCs', content: npcText, tokens: countTokens(npcText), reason: `NPCs detected in context (${activeNPCs.length}, spotlit: ${spotlitNpc.name})` });
        }
    }

    // Divergence Register
    if (divergenceRegister && divergenceRegister.entries.length > 0) {
        const regText = renderRegisterForPayload(divergenceRegister);
        if (regText) {
            worldBlocks.push({ source: 'Divergence Register', content: regText, tokens: countTokens(regText), reason: `Campaign facts (${divergenceRegister.entries.length} entries)` });
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
            addSection({ label: block.source, role: 'system', tokens: block.tokens, content: block.content, classification: 'world_context' });
        } else {
            addTrace({ source: block.source, classification: 'world_context', tokens: block.tokens, reason: `Dropped: Exceeds World budget (${budgetMap.world} t)`, included: false, position: 'system_dynamic' });
        }
    }

    // --- 5. Volatile State (Profile, Inventory) — Smart Injection ---
    const volatileParts: string[] = [];

    const hasSmart = context.smartBookkeepingActive;
    const hasStructured = (context.inventoryItems?.length ?? 0) > 0 || context.characterProfileData?.name;

    if (hasSmart && hasStructured) {
        // Stub is always injected (cheap, prevents total amnesia)
        const stub = minifyBookkeepingStub(context.characterProfileData!, context.inventoryItems || []);
        if (stub) volatileParts.push(`[CHARACTER]
${stub}`);

        // Recommender-selected categories / fields
        const anyInventory = context.inventoryItems && context.inventoryItems.length > 0;
        const anyProfile = context.characterProfileData && context.characterProfileData.name;

        if (anyInventory && inventoryCategories && inventoryCategories.length > 0) {
            const invBlock = minifySelectedInventory(context.inventoryItems, inventoryCategories);
            if (invBlock) volatileParts.push(`[INVENTORY]
${invBlock}`);
        }
        if (anyProfile && profileFields && profileFields.length > 0) {
            const profBlock = minifySelectedProfile(context.characterProfileData, profileFields);
            if (profBlock) volatileParts.push(`[PROFILE]
${profBlock}`);
        }
    } else if (context.characterProfileActive && context.characterProfile) {
        // Legacy fallback
        const profileSceneTag = context.characterProfileLastScene && context.characterProfileLastScene !== 'Never'
            ? `Last Updated: Scene #${context.characterProfileLastScene}`
            : 'NEVER AUTO-UPDATED — may be stale';
        volatileParts.push(`[CHARACTER PROFILE — ${profileSceneTag}]\n${context.characterProfile}`);
    }
    if (!hasSmart && context.inventoryActive && context.inventory) {
        // Legacy fallback
        const inventorySceneTag = context.inventoryLastScene && context.inventoryLastScene !== 'Never'
            ? `Last Updated: Scene #${context.inventoryLastScene}`
            : 'NEVER AUTO-UPDATED — may be stale';
        volatileParts.push(`[PLAYER INVENTORY — ${inventorySceneTag}]\n${context.inventory}`);
    }
    if (context.notebookActive && context.notebook && context.notebook.length > 0) {
        const noteLines = context.notebook
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 50)
            .map(n => `▸ ${n.text}`);
        volatileParts.push(`[SCENE NOTEBOOK — Volatile Working Memory]\n${noteLines.join('\n')}\n[END NOTEBOOK]`);
    }

    const volatileContent = volatileParts.join('\n\n');
    const volatileTokens = countTokens(volatileContent);
    addTrace({ source: 'Profile/Inventory', classification: 'volatile_state', tokens: volatileTokens, reason: hasSmart ? 'Smart bookkeeping (stub + recommender selected)' : 'Legacy player state', included: true, position: 'system_dynamic' });
    addSection({ label: 'Profile/Inventory', role: 'system', tokens: volatileTokens, content: volatileContent, classification: 'volatile_state' });

    // --- 6. Fit History ---
    const userTokens = countTokens(userMessage);
    const reservedTotal = stableTokens + summaryTokens + currentWorldTokens + volatileTokens + userTokens;
    const historyBudget = Math.max(0, limit - reservedTotal - 200); // Small safety margin of 200 tokens

    const candidateMessages = (condensedSummary && condensedUpToIndex !== undefined && condensedUpToIndex >= 0)
        ? history.slice(condensedUpToIndex + 1)
        : history;

    const fitted: OpenAIMessage[] = [];
    const fittedEphemeral: boolean[] = [];
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
        if ((msg as any).reasoning_content) openAIMsg.reasoning_content = (msg as any).reasoning_content;

        fitted.unshift(openAIMsg);
        fittedEphemeral.unshift(!!msg.ephemeral);
        historyUsed += cost;
    }

    let lastToolIdx = -1;
    for (let i = fitted.length - 1; i >= 0; i--) {
        if (fitted[i].role === 'tool') { lastToolIdx = i; break; }
    }
    let ephemeralSaved = 0;
    for (let i = 0; i < fitted.length; i++) {
        if (fittedEphemeral[i] && fitted[i].role === 'tool' && i !== lastToolIdx) {
            const oldContent = fitted[i].content;
            fitted[i].content = ' ';
            if (typeof oldContent === 'string') {
                const oldTokens = countTokens(oldContent);
                historyUsed -= oldTokens;
                ephemeralSaved += oldTokens;
            }
        }
    }
    if (ephemeralSaved > 0) {
        addTrace({ source: 'Ephemeral Cleanup', classification: 'summary', tokens: ephemeralSaved, reason: `Reclaimed from stale tool results`, included: false, position: 'history' });
    }

    // Protect orphaned tools
    while (fitted.length > 0 && fitted[0].role === 'tool') fitted.shift();

    addTrace({ source: 'Fitted History', classification: 'summary', tokens: historyUsed, reason: `Included ${fitted.length} msgs within ${historyBudget} budget`, included: true, position: 'history' });
    const historyLines = fitted.map(m => {
        const tag = m.role === 'tool' && m.name ? `[TOOL: ${m.name}]` : `[${m.role.toUpperCase()}]`;
        const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return `${tag}\n${body}`;
    }).join('\n\n---\n\n');
    addSection({
        label: `Fitted History (${fitted.length} msgs)`,
        role: 'mixed',
        tokens: historyUsed,
        content: historyLines,
        classification: 'summary',
    });
    addTrace({ source: 'User Message', classification: 'volatile_state', tokens: userTokens, reason: 'Current turn', included: true, position: 'user' });
    addSection({ label: 'User Message', role: 'user', tokens: userTokens, content: userMessage, classification: 'volatile_state' });

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
            addSection({ label: 'Scene Note', role: 'system', tokens: countTokens(noteText), content: noteText, classification: 'scene_local' });
        } else {
            // Fallback to end of system prompt if no history
            fitted.push(noteMsg);
            addTrace({ source: 'Scene Note (Fallback)', classification: 'scene_local', tokens: countTokens(noteText), reason: 'Injected after system (no history)', included: true, position: 'dynamic_suffix' });
            addSection({ label: 'Scene Note', role: 'system', tokens: countTokens(noteText), content: noteText, classification: 'scene_local' });
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
    messages.push({ role: 'system', content: '[GM REMINDER: NPCs push back when their wants/boundaries are crossed. Do not default to facilitation.]' });
    messages.push({ role: 'user', content: userMessage });

    return { messages, trace: isDebug ? trace : undefined, debugSections: isDebug ? debugSections : undefined };
}
