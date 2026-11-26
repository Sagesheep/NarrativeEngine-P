#!/usr/bin/env node
/**
 * i18n coverage report.
 *
 * Exists so a translator can answer "am I done?" and "did I break anything?"
 * without asking a maintainer and without installing tooling.
 *
 *   npm run i18n:check
 *
 * Reports, per locale: how many keys are translated, which are still missing,
 * which no longer exist in en.ts (orphans, usually left behind by a rename),
 * and any placeholder mismatches — a dropped `{{name}}` renders a literal
 * "{{name}}" to the user, which the type system cannot catch.
 *
 * Exit code is 0 for an incomplete translation (that is a normal, shipping
 * state — English fills the gaps) and 1 only for real defects: orphan keys or
 * broken placeholders.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, '..', 'src', 'i18n', 'locales');

/**
 * Pull the quoted keys out of a locale file by reading its source.
 *
 * Deliberately a regex over source rather than an import: this script must run
 * with plain `node`, with no TypeScript toolchain, so a contributor who has
 * only cloned the repo can still use it.
 */
function keysIn(filename) {
    const source = readFileSync(join(localesDir, filename), 'utf8');

    // Strip comments so commented-out examples are not counted as real keys.
    const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

    const entries = new Map();
    // Matches: 'some.key': 'value'  /  'some.key': "value"
    const re = /['"]([a-z][\w.]*)['"]\s*:\s*(['"])((?:\\.|(?!\2)[^\\])*)\2/gi;
    let m;
    while ((m = re.exec(code)) !== null) {
        entries.set(m[1], m[3]);
    }
    return entries;
}

function placeholders(value) {
    return (value.match(/\{\{(\w+)\}\}/g) ?? []).sort();
}

const en = keysIn('en.ts');
if (en.size === 0) {
    console.error('i18n:check — could not read any keys from en.ts. Aborting.');
    process.exit(1);
}

const localeFiles = readdirSync(localesDir)
    .filter((f) => f.endsWith('.ts') && f !== 'en.ts' && f !== 'pseudo.ts');

console.log(`\ni18n coverage — ${en.size} keys in en.ts\n${'─'.repeat(46)}`);

let failed = false;

for (const file of localeFiles) {
    const code = file.replace(/\.ts$/, '');
    const strings = keysIn(file);

    // A locale file also contains non-key fields (code, label, styleProfile);
    // only keys that exist in en.ts count as translations.
    const translated = [...strings.keys()].filter((k) => en.has(k));
    const orphans = [...strings.keys()].filter((k) => !en.has(k) && k.includes('.'));
    const missing = [...en.keys()].filter((k) => !strings.has(k));

    const pct = Math.round((translated.length / en.size) * 100);
    console.log(`\n${code}  ${translated.length}/${en.size} (${pct}%)`);

    const badPlaceholders = translated.filter(
        (k) => placeholders(en.get(k)).join() !== placeholders(strings.get(k)).join(),
    );

    if (orphans.length > 0) {
        failed = true;
        console.log(`  ✗ ${orphans.length} key(s) not in en.ts — renamed or mistyped, these render nothing:`);
        for (const k of orphans) console.log(`      ${k}`);
    }

    if (badPlaceholders.length > 0) {
        failed = true;
        console.log(`  ✗ ${badPlaceholders.length} key(s) with changed {{placeholders}} — these leak literal braces to users:`);
        for (const k of badPlaceholders) {
            console.log(`      ${k}`);
            console.log(`        en: ${placeholders(en.get(k)).join(' ') || '(none)'}`);
            console.log(`        ${code}: ${placeholders(strings.get(k)).join(' ') || '(none)'}`);
        }
    }

    if (missing.length > 0) {
        // Not a failure. English fills these in and the app stays usable.
        console.log(`  · ${missing.length} not translated yet (English is shown for these):`);
        for (const k of missing.slice(0, 15)) console.log(`      ${k}`);
        if (missing.length > 15) console.log(`      … and ${missing.length - 15} more`);
    }

    // A key present but byte-identical to English reads as 100% translated in
    // the count above while still showing English to the user. Some of these are
    // correct (product names, "Debug"); the rest are lines a translator scrolled
    // past. Only a human can tell which, so this reports rather than fails.
    const sameAsEnglish = translated.filter((k) => strings.get(k) === en.get(k));
    if (sameAsEnglish.length > 0) {
        console.log(`  · ${sameAsEnglish.length} identical to English — intentional (brand names) or overlooked:`);
        for (const k of sameAsEnglish) console.log(`      ${k}  =  "${en.get(k)}"`);
    }

    if (
        orphans.length === 0 &&
        badPlaceholders.length === 0 &&
        missing.length === 0 &&
        sameAsEnglish.length === 0
    ) {
        console.log('  ✓ complete');
    }
}

console.log(
    failed
        ? '\n✗ Problems found above. Missing keys are fine; orphans and placeholder\n  mismatches are not — please fix those.\n'
        : '\n✓ No defects. Untranslated keys fall back to English and ship fine.\n',
);

process.exit(failed ? 1 : 0);
