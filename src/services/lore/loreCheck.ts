import type {
    EndpointConfig,
    LoreChunk,
    ArchiveIndexEntry,
    ArchiveChapter,
    ChatMessage,
    LoreCheckResult,
    LoreCheckCitation,
    LoreCheckVerdict,
    LoreCheckCategory,
} from '../../types';
import { llmCall } from '../../utils/llmCall';
import { searchLoreByQuery } from './loreRetriever';
import { deepArchiveScan } from '../archive-memory/deepArchiveSearch';
import { extractJsonRobust } from '../infrastructure/jsonExtract';

export type LoreCheckInput = {
    utilityEndpoint: EndpointConfig;
    selectedText: string;
    surroundingContext: string;
    messages: ChatMessage[];
    targetMessageId: string;
    loreChunks: LoreChunk[];
    archiveIndex: ArchiveIndexEntry[];
    sealedChapters: ArchiveChapter[];
    campaignId: string;
    onStatus: (msg: string) => void;
    signal?: AbortSignal;
    hint?: string;
    categories?: LoreCheckCategory[];
};

export function buildSearchQuery(selectedText: string, hint?: string): string {
    const parts = [selectedText, hint?.trim()].filter(Boolean);
    return parts.join(' — ');
}

export async function runLoreCheck(input: LoreCheckInput): Promise<LoreCheckResult> {
    const {
        utilityEndpoint, selectedText, surroundingContext,
        messages, targetMessageId, loreChunks,
        archiveIndex, sealedChapters, campaignId,
        onStatus, signal, hint, categories,
    } = input;

    const searchQuery = buildSearchQuery(selectedText, hint);

    onStatus('Searching lore...');
    const loreHits = searchLoreByQuery(loreChunks, searchQuery, 1500, 5);

    onStatus('Scanning archive...');
    const targetIdx = messages.findIndex(m => m.id === targetMessageId);
    const contextSlice = targetIdx >= 0
        ? messages.slice(Math.max(0, targetIdx - 3), targetIdx + 1)
        : messages.slice(-4);

    let archiveBrief = '';
    if (sealedChapters.length > 0 && archiveIndex.length > 0) {
        try {
            archiveBrief = await deepArchiveScan(
                utilityEndpoint,
                archiveIndex,
                sealedChapters,
                campaignId,
                contextSlice,
                searchQuery,
                1500,
                onStatus,
            );
        } catch (err) {
            console.warn('[LoreCheck] deepArchiveScan failed (non-fatal):', err);
            archiveBrief = '';
        }
    }

    onStatus('Verifying...');
    const loreText = loreHits.length === 0
        ? '(no relevant lore entries found)'
        : loreHits.map(c => `### ${c.header}\n${c.content}`).join('\n\n');

    const archiveText = archiveBrief.trim() || '(no archived scenes available)';

    const prompt = buildVerifierPrompt({
        selectedText,
        surroundingContext,
        loreText,
        archiveText,
        hint,
        categories,
    });

    const raw = await llmCall(utilityEndpoint, prompt, {
        temperature: 0.1,
        maxTokens: 800,
        priority: 'high',
        signal,
    });

    return parseVerdict(raw, selectedText);
}

export type DirectRewriteInput = {
    utilityEndpoint: EndpointConfig;
    selectedText: string;
    surroundingContext: string;
    fact: string;
    signal?: AbortSignal;
};

/**
 * Edit-and-replace mode. The user already knows the correct fact, so we skip all
 * retrieval/verification and just rewrite the highlighted sentence to state that fact.
 */
export async function runDirectRewrite(input: DirectRewriteInput): Promise<LoreCheckResult> {
    const { utilityEndpoint, selectedText, surroundingContext, fact, signal } = input;

    const prompt = buildRewritePrompt({ selectedText, surroundingContext, fact });

    const raw = await llmCall(utilityEndpoint, prompt, {
        temperature: 0.3,
        maxTokens: 4096,
        priority: 'high',
        signal,
    });

    return parseRewrite(raw, selectedText);
}

export function buildRewritePrompt(args: {
    selectedText: string;
    surroundingContext: string;
    fact: string;
}): string {
    return `You are a precise copy editor for a tabletop RPG narration. The player has highlighted a SENTENCE the GM wrote and supplied a FACT they know to be true. Your only job is to rewrite the sentence so it states the fact correctly.

Rules:
- Treat the FACT as authoritative ground truth. Do NOT question it, soften it, or check it against anything.
- Change ONLY what is needed to make the SENTENCE consistent with the FACT.
- Preserve the GM's tone, voice, tense, and approximate length.
- Do NOT add new events, NPCs, places, or commitments beyond what the FACT states.
- The SURROUNDING CONTEXT is for tone and continuity reference only — your rewrite replaces just the SENTENCE, so it must read naturally between those neighbors.
- If the SENTENCE already matches the FACT, return it essentially unchanged.

OUTPUT SCHEMA:
{
  "rewrite": "the rewritten sentence"
}

Respond with ONLY a single JSON object, no prose, no code fence.

[SENTENCE]
${args.selectedText}

[SURROUNDING CONTEXT]
${args.surroundingContext}

[FACT]
${args.fact}
`;
}

function parseRewrite(raw: string, originalText: string): LoreCheckResult {
    const { value, parseOk } = extractJsonRobust<{ rewrite?: unknown }>(raw, { rewrite: '' });
    const rewrite =
        parseOk && typeof value.rewrite === 'string' && value.rewrite.trim().length > 0
            ? value.rewrite.trim()
            : null;

    if (rewrite) {
        return { verdict: 'corrected', issues: [], citations: [], suggestedRewrite: rewrite, originalText };
    }

    console.warn('[DirectRewrite] Rewriter returned unparseable response. Raw:\n', raw);
    return {
        verdict: 'corrected',
        issues: ['Could not produce a rewrite from your fact. See raw output below.'],
        citations: [],
        suggestedRewrite: null,
        originalText,
        rawResponse: raw,
    };
}

export function buildVerifierPrompt(args: {
    selectedText: string;
    surroundingContext: string;
    loreText: string;
    archiveText: string;
    hint?: string;
    categories?: LoreCheckCategory[];
}): string {
    const hasConcern = (args.hint?.trim()) || (args.categories && args.categories.length > 0);
    let userConcernBlock = '';
    if (hasConcern) {
        const catList = args.categories?.length ? args.categories.join(', ') : '';
        const note = args.hint?.trim() ?? '';
        const parts: string[] = [];
        if (catList) parts.push(`Categories: ${catList}`);
        if (note) parts.push(`Note: "${note}"`);
        userConcernBlock = `

[USER CONCERN]
${parts.join('\n')}

The user has flagged this sentence specifically because of the concern above.
Focus your verdict on whether the concern is justified, but you may still flag other clear issues you notice.
`;
    }

    return `You are a narrative continuity auditor for a tabletop RPG campaign.
A player has highlighted a sentence written by the GM and wants to know whether it is consistent with established lore and play history.

You will receive:
- The highlighted SENTENCE
- The surrounding CONTEXT (sentence before and after, for tone reference only)
- LORE evidence (canonical world facts written by the player)
- ARCHIVE evidence (a brief summarizing past scenes from the campaign)${hasConcern ? '\n- A USER CONCERN describing why they flagged this sentence' : ''}

Your job:
1. Decide a verdict:
   - "consistent": the sentence is supported (or at least not contradicted) by the evidence.
   - "unsupported": the sentence makes specific factual claims that are not covered by lore or archive — possible hallucination but not a clear contradiction.
   - "contradicts": the sentence directly contradicts at least one lore entry or archived event.${hasConcern ? '\n   If a USER CONCERN is provided, weigh it heavily in your verdict, but don\'t ignore other contradictions.' : ''}
2. List up to 3 short issues (each one sentence). Empty list if verdict is "consistent".
3. List the citations you relied on. Use "lore:<exact lore header>" for lore and "scene:<sceneId>" for archive references that appear in the brief. Do NOT invent citations.
4. If verdict is "contradicts" or "unsupported", produce a SUGGESTED REWRITE that:
   - Preserves the GM's tone and approximate length.
   - Replaces ONLY the contradicted/fabricated facts with ones supported by the evidence.
   - Does NOT add new events or commitments.
   - If you cannot produce a confident rewrite from evidence, set suggestedRewrite to null.
5. If verdict is "consistent", set suggestedRewrite to null.
${userConcernBlock}
Respond with ONLY a single JSON object, no prose, no code fence:
{
  "verdict": "consistent" | "unsupported" | "contradicts",
  "issues": ["..."],
  "citations": [{"ref": "lore:...", "label": "..."}, {"ref": "scene:042", "label": "..."}],
  "suggestedRewrite": "..." | null
}

[SENTENCE]
${args.selectedText}

[SURROUNDING CONTEXT]
${args.surroundingContext}

[LORE EVIDENCE]
${args.loreText}

[ARCHIVE EVIDENCE]
${args.archiveText}
`;
}

function parseVerdict(raw: string, originalText: string): LoreCheckResult {
    let clean = raw.replace(/<think[\s\S]*?<\/think>/gi, '');
    const orphanThink = clean.indexOf('<think>');
    if (orphanThink !== -1 && !clean.includes('</think>')) {
        clean = clean.slice(0, orphanThink);
    }
    const fence = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) clean = fence[1];

    // Try multiple JSON candidates
    const candidates: string[] = [];
    const firstStart = clean.indexOf('{');
    const lastEnd = clean.lastIndexOf('}');
    if (firstStart !== -1 && lastEnd !== -1 && lastEnd > firstStart) {
        candidates.push(clean.substring(firstStart, lastEnd + 1));
    }
    const balanced = extractFirstJsonObject(clean);
    if (balanced && !candidates.includes(balanced)) candidates.push(balanced);

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            const verdictRaw = String(parsed.verdict ?? '').toLowerCase();
            const verdict: LoreCheckVerdict =
                verdictRaw === 'contradicts' || verdictRaw === 'unsupported' ? verdictRaw : 'consistent';
            const issues: string[] = Array.isArray(parsed.issues)
                ? parsed.issues.filter((s: unknown): s is string => typeof s === 'string').slice(0, 3)
                : [];
            const citations: LoreCheckCitation[] = Array.isArray(parsed.citations)
                ? parsed.citations
                    .map((c: unknown) => {
                        if (typeof c === 'string') return { ref: c, label: c };
                        if (c && typeof c === 'object' && 'ref' in c) {
                            const ref = String((c as { ref: unknown }).ref);
                            const label = 'label' in c ? String((c as { label: unknown }).label) : ref;
                            return { ref, label };
                        }
                        return null;
                    })
                    .filter((x: LoreCheckCitation | null): x is LoreCheckCitation => x !== null)
                : [];
            const suggestedRewrite =
                typeof parsed.suggestedRewrite === 'string' && parsed.suggestedRewrite.trim().length > 0
                    ? parsed.suggestedRewrite
                    : null;
            return { verdict, issues, citations, suggestedRewrite, originalText };
        } catch {
            // try next candidate
        }
    }

    console.warn('[LoreCheck] Verifier returned unparseable response. Raw:\n', raw);
    return {
        verdict: 'unsupported',
        issues: ['The verifier returned an unparseable response. See raw output below.'],
        citations: [],
        suggestedRewrite: null,
        originalText,
        rawResponse: raw,
    };
}

function extractFirstJsonObject(text: string): string | null {
    let depth = 0;
    let start = -1;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0 && start !== -1) {
                return text.substring(start, i + 1);
            }
        }
    }
    return null;
}