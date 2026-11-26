// WO-P1-01 codemod: convert positional buildPayload(...) calls to options-object form.
//
// Run once to migrate all call sites (production + tests). The script reads each
// .ts file, finds `buildPayload(` calls, parses the positional args, and emits
// `buildPayload({ settings: ..., context: ..., ... })`. The dead `_sceneNumber`
// (pos 9) param is dropped.
//
// This is a one-shot tool — not part of the build. It deliberately over-matches
// (any `buildPayload(` call) and uses a tolerant parser. Manual review after.
//
// USAGE: node scripts/migrate-buildPayload-options.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// The 29 positional params in order. Index 8 (_sceneNumber) is dropped.
// Source: payloadBuilder.ts pre-refactor signature (WO-P1-01 audit finding A).
const PARAM_NAMES = [
    'settings',           // 0
    'context',            // 1
    'history',            // 2
    'userMessage',        // 3
    'condensedUpToIndex', // 4
    'relevantLore',       // 5
    'npcLedger',          // 6
    'archiveRecall',      // 7
    '_sceneNumber',       // 8 — DROPPED
    'recommendedNPCNames',// 9
    'semanticFactText',   // 10
    'archiveIndex',       // 11
    'timelineEvents',     // 12
    'inventoryCategories',// 13
    'profileFields',      // 14
    'deepContextSummary', // 15
    'divergenceRegister', // 16
    'chapters',           // 17
    'onStageNpcIds',      // 18
    'relevantRules',      // 19
    'rulesManifest',      // 20
    'pinnedExcerpts',     // 21
    'plannerEventTypes',  // 22
    'locationLedger',     // 23
    'nextTurnOocBrief',   // 24
    'watchdogNudge',      // 25
    'directorBrief',      // 26
    'elevatedScenes',     // 27
    'slottedRagSnippets', // 28
];
const DROPPED_INDEX = 8; // _sceneNumber

// Recursively walk for .ts files (skip node_modules, dist, .opencode).
function walk(dir, out = []) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
        if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.opencode' || e.name === 'graphify-out') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.isFile() && p.endsWith('.ts')) out.push(p);
    }
    return out;
}

// Find the matching closing paren for an opening paren at index `open` in `src`.
// Returns the index of the matching `)`. Honors string literals, template
// literals, regex literals (best-effort), nested parens/brackets/braces.
function matchParen(src, open) {
    let depth = 0;
    let i = open;
    let inStr = null; // ', ", `
    let inRegex = false;
    let inLineComment = false;
    let inBlockComment = false;
    let prev = '';
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (inLineComment) {
            if (c === '\n') inLineComment = false;
        } else if (inBlockComment) {
            if (c === '*' && next === '/') { inBlockComment = false; i++; }
        } else if (inStr) {
            if (c === '\\') { i++; } // skip escaped char
            else if (c === inStr) inStr = null;
        } else if (inRegex) {
            if (c === '\\') { i++; }
            else if (c === '/') inRegex = false;
        } else {
            if (c === '/' && next === '/') { inLineComment = true; i++; }
            else if (c === '/' && next === '*') { inBlockComment = true; i++; }
            else if (c === '"' || c === "'" || c === '`') inStr = c;
            else if (c === '/' && isRegexContext(prev)) inRegex = true;
            else if (c === '(' || c === '[' || c === '{') depth++;
            else if (c === ')' || c === ']' || c === '}') {
                depth--;
                if (depth === 0 && c === ')') return i;
            }
        }
        prev = c;
        i++;
    }
    return -1;
}

function isRegexContext(prev) {
    // Heuristic: a `/` starts a regex if the previous non-space char is an
    // operator, comma, paren, or start of expression. False positives possible
    // but rare in buildPayload call args.
    return /[(,=:!&|?+\-*{[]\s*$/.test(prev) || prev === '';
}

// Split top-level args of a call (between the outer parens). Args are separated
// by commas at depth 0 (relative to the args region). Returns array of raw
// arg strings (with their original whitespace).
function splitArgs(src) {
    const args = [];
    let depth = 0;
    let i = 0;
    let inStr = null;
    let inRegex = false;
    let inLineComment = false;
    let inBlockComment = false;
    let prev = '';
    let start = 0;
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (inLineComment) {
            if (c === '\n') inLineComment = false;
        } else if (inBlockComment) {
            if (c === '*' && next === '/') { inBlockComment = false; i++; }
        } else if (inStr) {
            if (c === '\\') { i++; }
            else if (c === inStr) inStr = null;
        } else if (inRegex) {
            if (c === '\\') { i++; }
            else if (c === '/') inRegex = false;
        } else {
            if (c === '/' && next === '/') { inLineComment = true; i++; }
            else if (c === '/' && next === '*') { inBlockComment = true; i++; }
            else if (c === '"' || c === "'" || c === '`') inStr = c;
            else if (c === '/' && isRegexContext(prev)) inRegex = true;
            else if (c === '(' || c === '[' || c === '{') depth++;
            else if (c === ')' || c === ']' || c === '}') depth--;
            else if (c === ',' && depth === 0) {
                args.push(src.slice(start, i));
                start = i + 1;
            }
        }
        prev = c;
        i++;
    }
    if (start < src.length) args.push(src.slice(start));
    return args;
}

// Convert a buildPayload(...) call's args to an options object literal.
// `argSrc` is the text between the outer parens.
function convertCall(argSrc) {
    const args = splitArgs(argSrc).map(a => a.trim()).filter(a => a.length > 0);
    // Drop trailing-whitespace-only entries from splitArgs (shouldn't happen).
    // Build the options object. Skip dropped param (index 8).
    const lines = [];
    for (let i = 0; i < args.length; i++) {
        if (i === DROPPED_INDEX) continue; // _sceneNumber dropped
        const name = PARAM_NAMES[i];
        if (!name) continue;
        // Keep `as` casts intact — they ride with the arg.
        lines.push(`${name}: ${args[i]}`);
    }
    return `{ ${lines.join(', ')} }`;
}

// Process one file: find every `buildPayload(` that is a CALL (not a definition,
// not an import, not a comment) and rewrite it to `buildPayload({...})`.
function processFile(filePath) {
    let src = fs.readFileSync(filePath, 'utf8');
    const out = [];
    let i = 0;
    let changed = false;
    let count = 0;
    while (i < src.length) {
        const idx = src.indexOf('buildPayload', i);
        if (idx === -1) { out.push(src.slice(i)); break; }
        // Find the next "(" after buildPayload (allow whitespace).
        let j = idx + 'buildPayload'.length;
        while (j < src.length && /\s/.test(src[j])) j++;
        if (src[j] !== '(') {
            // Not a call (could be `buildPayload:` in a mock or `buildPayload` in a comment).
            out.push(src.slice(i, idx + 'buildPayload'.length));
            i = idx + 'buildPayload'.length;
            continue;
        }
        // Check preceding char — must not be `.`, `a-z`, `_`, `$` (would be a different identifier).
        const prevChar = src[idx - 1];
        if (prevChar && /[a-zA-Z0-9_$.]/.test(prevChar)) {
            out.push(src.slice(i, idx + 'buildPayload'.length));
            i = idx + 'buildPayload'.length;
            continue;
        }
        // Check we're not in a comment or string — naive: scan a tiny window
        // back for // or /* or a string opener. Skip (rare in practice).
        const closeIdx = matchParen(src, j);
        if (closeIdx === -1) {
            out.push(src.slice(i));
            break;
        }
        const argSrc = src.slice(j + 1, closeIdx);
        // Skip calls that already pass an options object (idempotency).
        const trimmed = argSrc.trim();
        if (trimmed.startsWith('{')) {
            out.push(src.slice(i, closeIdx + 1));
            i = closeIdx + 1;
            continue;
        }
        // Skip mock-factory calls like `(...args: unknown[]) => buildPayloadMock(...args)`
        // — those don't have `buildPayload(` as a real call to convert. We're
        // only converting direct buildPayload calls. The mock pattern uses
        // `buildPayloadMock` (different identifier) so it's already filtered
        // by the prev-char check above.
        const optionsObj = convertCall(argSrc);
        out.push(src.slice(i, j + 1));
        out.push(optionsObj);
        out.push(')');
        i = closeIdx + 1;
        changed = true;
        count++;
    }
    if (changed) {
        fs.writeFileSync(filePath, out.join(''), 'utf8');
    }
    return count;
}

// Main: walk src/ + scripts/, process every .ts file.
const files = walk(path.join(ROOT, 'src'));
let total = 0;
for (const f of files) {
    const n = processFile(f);
    if (n > 0) {
        console.log(`  ${path.relative(ROOT, f)}: ${n} call(s) converted`);
        total += n;
    }
}
console.log(`Done. ${total} call(s) converted across ${files.length} files.`);