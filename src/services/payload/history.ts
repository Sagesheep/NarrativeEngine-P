import type { ChatMessage, GameContext, ArchiveChapter, ArchiveIndexEntry } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { countTokens } from '../infrastructure/tokenizer';
import type { TraceCollector } from './traceCollector';
import { renderLodChapters } from './lodRenderer';

const THINK_TAG_REGEX = /<think[\s\S]*?<\/think>\s*/gi;

export function buildHistory(opts: {
    history: ChatMessage[];
    condensedUpToIndex?: number;
    userMessage: string;
    limit: number;
    stableTokens: number;
    currentWorldTokens: number;
    volatileTokens: number;
    context: GameContext;
    collector: TraceCollector;
    /** WO-09: sealed-chapter LOD inputs. When omitted (old campaigns), the
     *  condensed portion stays dropped as before — nothing throws. */
    chapters?: ArchiveChapter[];
    archiveIndex?: ArchiveIndexEntry[];
    lodSummaryChapters?: number;
    lodImportanceBonus?: number;
}): OpenAIMessage[] {
    const {
        history,
        condensedUpToIndex,
        userMessage,
        limit,
        stableTokens,
        currentWorldTokens,
        volatileTokens,
        context,
        collector,
        chapters,
        archiveIndex,
        lodSummaryChapters,
        lodImportanceBonus,
    } = opts;

    // --- 6. Fit History ---
    const userTokens = countTokens(userMessage);
    const reservedTotal = stableTokens + currentWorldTokens + volatileTokens + userTokens;
    const historyBudget = Math.max(0, limit - reservedTotal - 200); // Small safety margin of 200 tokens

    // WO-09: render the condensed portion's sealed chapters through the LOD renderer.
    // The previous mechanism (lines below) sliced messages from `condensedUpToIndex + 1`
    // and dropped the condensed prefix entirely — LOD replaces that void with a tiered
    // chapter summary that lives in the cached prefix. LOD gets up to 50% of the history
    // budget (soft cap via the renderer's cascade); the verbatim window keeps the rest so
    // the most-recent messages are never starved by summaries. Emitted as a system message
    // prepended to the fitted verbatim window — payloadBuilder's cache-stamping marks the
    // LAST history message, so prepending leaves it untouched and LOD rides in the cached prefix.
    //
    // WO-09b §4 / WO-09c §4: the emitted `lodContent` includes the deterministic envelope
    // (`[LOD HISTORY — CONDENSED CHAPTERS]\n` + `\n[END LOD HISTORY]`). The renderer's
    // `budgetTokens` allocation is reduced by the envelope's token cost so the wrapper
    // does not silently exceed the LOD allocation, and `lodTokens` counts the actual
    // emitted `lodContent` (envelope + body), not just the renderer's `lodResult.tokens`.
    //
    // WO-09c §4: the envelope cost is reserved conservatively as
    // `countTokens(prefix) + countTokens(suffix)` — tokenizing the two halves separately
    // rather than as adjacent strings, so cross-boundary BPE merges between the suffix and
    // the prefix cannot under-estimate the reservation. The actual trace count remains
    // `countTokens(lodContent)` (the whole emitted string). This is accounting, not a new
    // budget policy — the 50% LOD allocation is unchanged.
    const LOD_ENVELOPE_PREFIX = '[LOD HISTORY — CONDENSED CHAPTERS]\n';
    const LOD_ENVELOPE_SUFFIX = '\n[END LOD HISTORY]';
    const envelopeCost = countTokens(LOD_ENVELOPE_PREFIX) + countTokens(LOD_ENVELOPE_SUFFIX);
    let lodTokens = 0;
    let lodSummaryCount = 0;
    let lodSynopsisCount = 0;
    let lodDroppedCount = 0;
    let lodContent = '';
    let lodAllocation = 0;
    if (chapters && chapters.length > 0 && condensedUpToIndex !== undefined && condensedUpToIndex >= 0) {
        lodAllocation = Math.min(historyBudget, Math.max(200, Math.floor(historyBudget * 0.5)));
        const lodResult = renderLodChapters({
            chapters,
            archiveIndex: archiveIndex ?? [],
            condensedUpToIndex,
            messages: history,
            // Reserve the envelope cost from the renderer's allocation so the
            // emitted `lodContent` (envelope + body) fits the original LOD allocation.
            budgetTokens: Math.max(0, lodAllocation - envelopeCost),
            config: {
                summaryChapters: lodSummaryChapters ?? 7,
                importanceBonus: lodImportanceBonus ?? 2,
            },
        });
        if (lodResult.text) {
            lodContent = `${LOD_ENVELOPE_PREFIX}${lodResult.text}${LOD_ENVELOPE_SUFFIX}`;
            // Count the actual emitted content (envelope + body), not just the body.
            lodTokens = countTokens(lodContent);
            for (const tier of Object.values(lodResult.tierByChapterId)) {
                if (tier === 'summary') lodSummaryCount++;
                else if (tier === 'synopsis') lodSynopsisCount++;
                else if (tier === 'dropped') lodDroppedCount++;
            }
        }
    }

    const candidateMessages = (condensedUpToIndex !== undefined && condensedUpToIndex >= 0)
        ? history.slice(condensedUpToIndex + 1)
        : history;

    // Verbatim window gets the history budget remaining after LOD rendering.
    const verbatimBudget = Math.max(0, historyBudget - lodTokens);

    const fitted: OpenAIMessage[] = [];
    const fittedEphemeral: boolean[] = [];
    let historyUsed = 0;
    for (let i = candidateMessages.length - 1; i >= 0; i--) {
        const msg = candidateMessages[i];
        let content = msg.content ?? null;
        if (msg.role === 'user' && typeof content === 'string') {
            content = content.replace(/\n?\[(?:DICE OUTCOMES:|SURPRISE EVENT:|ENCOUNTER EVENT:|WORLD_EVENT:|LOOT DROP:)[^\]]*\]/g, '');
        }
        if (msg.role === 'assistant' && typeof content === 'string') {
            content = content.replace(THINK_TAG_REGEX, '').trim() || content;
        }
        const textToEstimate = content || JSON.stringify(msg.tool_calls || '') || '';
        const cost = countTokens(textToEstimate);
        if (historyUsed + cost > verbatimBudget) break;

        const openAIMsg: OpenAIMessage = {
            role: msg.role as 'system' | 'user' | 'assistant' | 'tool',
            content
        };
        if (msg.name) openAIMsg.name = msg.name;
        if (msg.tool_calls) openAIMsg.tool_calls = msg.tool_calls;
        if (msg.tool_call_id) openAIMsg.tool_call_id = msg.tool_call_id;

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
        collector.addTrace({ source: 'Ephemeral Cleanup', classification: 'summary', tokens: ephemeralSaved, reason: `Reclaimed from stale tool results`, included: false, position: 'history' });
    }

    // Protect orphaned tools
    while (fitted.length > 0 && fitted[0].role === 'tool') fitted.shift();

    // WO-09: capture the verbatim-window shape BEFORE prepending LOD so the
    // Fitted History trace/section below stay semantically unchanged (they
    // describe the verbatim window only — LOD gets its own trace + section).
    const verbatimCount = fitted.length;
    const verbatimTokens = historyUsed;

    // WO-09c §3: capture the Fitted History debug section content from the
    // post-fit, post-orphan-cleanup verbatim array BEFORE both the scene-note
    // splice and the LOD prepend. Pre-WO-09 the Fitted History section excluded
    // the separately traced scene note; WO-09b moved this capture to after the
    // scene-note splice (so the section briefly included the scene note text,
    // which was a regression). This restores the pre-WO-09 debug behavior: the
    // `Fitted History` section describes the verbatim window ONLY, and the
    // separate `Scene Note` and `LOD History` sections own those synthetic
    // blocks. Prompt assembly order is unchanged.
    const historyLines = fitted.map(m => {
        const tag = m.role === 'tool' && m.name ? `[TOOL: ${m.name}]` : `[${m.role.toUpperCase()}]`;
        const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return `${tag}\n${body}`;
    }).join('\n\n---\n\n');

    // WO-09b §2: depth-based scene-note splice runs against the VERBATIM fitted
    // history only, BEFORE the LOD system message is prepended. The synthetic LOD
    // message is condensed history, not a verbatim history entry, so it must not
    // consume one depth position. Splicing first then prepending LOD keeps
    // `sceneNoteDepth` counting real fitted history messages exactly as it did
    // before WO-09. The returned order is still: LOD (when present), fitted
    // verbatim history with the scene note at its pre-WO-09 depth, then the final
    // volatile user message is added later by payloadBuilder.ts.
    if (context.sceneNoteActive && context.sceneNote) {
        const noteText = `[SCENE NOTE: VOLATILE GUIDANCE]\n${context.sceneNote}`;
        const noteMsg: OpenAIMessage = { role: 'system', content: noteText };
        const depth = context.sceneNoteDepth ?? 3;

        // Splice into fitted verbatim history (LOD not yet prepended).
        if (fitted.length > 0) {
            const index = Math.max(0, fitted.length - depth);
            fitted.splice(index, 0, noteMsg);
            collector.addTrace({ source: 'Scene Note (Depth)', classification: 'scene_local', tokens: countTokens(noteText), reason: `Injected at depth ${depth}`, included: true, position: `history_at_${depth}` });
            collector.addSection({ label: 'Scene Note', role: 'system', tokens: countTokens(noteText), content: noteText, classification: 'scene_local' });
        } else {
            // Fallback to end of system prompt if no verbatim history
            fitted.push(noteMsg);
            collector.addTrace({ source: 'Scene Note (Fallback)', classification: 'scene_local', tokens: countTokens(noteText), reason: 'Injected after system (no history)', included: true, position: 'dynamic_suffix' });
            collector.addSection({ label: 'Scene Note', role: 'system', tokens: countTokens(noteText), content: noteText, classification: 'scene_local' });
        }
    }

    // WO-09: prepend the LOD history as a system message so it rides in the cached
    // prefix ahead of the verbatim window. Cache-stamping in payloadBuilder marks the
    // LAST history message (WO-09b widens the role check to include `system`), so
    // prepending leaves the stamp target untouched. The LOD renderer is byte-deterministic
    // for identical chapter/cast state, so this block stays cache-stable across turns.
    // Old campaigns (no chapters) skip this — the condensed portion stays dropped
    // exactly as before, preserving current behavior.
    if (lodContent) {
        const lodMsg: OpenAIMessage = { role: 'system', content: lodContent };
        fitted.unshift(lodMsg);
        const tierBreakdown = `${lodSummaryCount} summary, ${lodSynopsisCount} synopsis${lodDroppedCount > 0 ? `, ${lodDroppedCount} dropped` : ''}`;
        collector.addTrace({
            source: 'LOD History',
            classification: 'summary',
            tokens: lodTokens,
            reason: `Condensed-chapter LOD (${tierBreakdown}) within ${historyBudget} budget`,
            included: true,
            position: 'history',
            preview: lodContent,
        });
        collector.addSection({
            label: `LOD History (${tierBreakdown})`,
            role: 'system',
            tokens: lodTokens,
            content: lodContent,
            classification: 'summary',
        });
    }

    collector.addTrace({ source: 'Fitted History', classification: 'summary', tokens: verbatimTokens, reason: `Included ${verbatimCount} msgs within ${historyBudget} budget`, included: true, position: 'history' });
    collector.addSection({
        label: `Fitted History (${verbatimCount} msgs)`,
        role: 'mixed',
        tokens: verbatimTokens,
        content: historyLines,
        classification: 'summary',
    });
    collector.addTrace({ source: 'User Message', classification: 'volatile_state', tokens: userTokens, reason: 'Current turn', included: true, position: 'user' });
    collector.addSection({ label: 'User Message', role: 'user', tokens: userTokens, content: userMessage, classification: 'volatile_state' });

    return fitted;
}
