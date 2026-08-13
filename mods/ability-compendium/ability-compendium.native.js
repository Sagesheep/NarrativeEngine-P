// Native Generation 1 bridge for the Ability & Power Compendium.
//
// The original contribution used a pre-freeze declarative lookup field. Gen 1
// deliberately keeps the manifest surface smaller, so the same behaviour is
// expressed through the public native interceptor and the module's own tables.

const PROMPT_INDEX = 'prompt-index';
const CONFIG = 'config';
const MAX_BUDGET = 1200;
let activeContext = null;

function canonical(value) {
    return ` ${String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

function terms(value) {
    if (Array.isArray(value)) return value.filter((item) => typeof item === 'string');
    if (typeof value === 'string') return value.split(',');
    return [];
}

function matchesRow(row, haystack) {
    if (!row || typeof row !== 'object' || typeof row.text !== 'string') return false;
    return terms(row.terms).some((term) => {
        const needle = canonical(term);
        return needle.trim().length >= 2 && haystack.includes(needle);
    });
}

function fitPromptRows(rows, counter) {
    const selected = ['[ABILITY & POWER COMPENDIUM — MATCHED CANON]'];
    for (const row of rows) {
        const next = [...selected, row.text.trim()].join('\n\n');
        if (counter && counter(next) > MAX_BUDGET) break;
        selected.push(row.text.trim());
    }
    return selected.length > 1 ? selected.join('\n\n') : '';
}

export function onActivate(ctx) {
    activeContext = ctx || null;
}

export function onDisable() {
    activeContext = null;
}

export async function interceptPrompt(input) {
    const ctx = activeContext;
    if (!ctx?.table) return;

    const config = await ctx.table.read(CONFIG).catch(() => null);
    if (config && typeof config === 'object' && config.promptContextEnabled === false) return;

    const rows = await ctx.table.read(PROMPT_INDEX).catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) return;

    const messages = Array.isArray(ctx.data?.messages) ? ctx.data.messages.slice(-8) : [];
    const recentText = messages.map((message) => message?.content || '').join('\n');
    const haystack = canonical(`${recentText}\n${input?.playerInput || ''}`);
    const matched = rows.filter((row) => matchesRow(row, haystack));
    if (matched.length === 0) return;

    const counter = typeof ctx.tokens?.count === 'function' ? (value) => ctx.tokens.count(value) : null;
    const text = fitPromptRows(matched, counter);
    if (!text) return;

    return {
        contributions: [{
            id: 'mentioned-abilities',
            order: 150,
            budget: MAX_BUDGET,
            text,
        }],
    };
}
