import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const NPC_LEDGER_DIR = join(ROOT, 'src', 'components', 'npc-ledger');
const NPC_LEDGER_MODAL = join(ROOT, 'src', 'components', 'NPCLedgerModal.tsx');
const CHARACTER_DIR = join(ROOT, 'src', 'components', 'character');
const CHARACTER_SERVICES_DIR = join(ROOT, 'src', 'services', 'character');

function readFileSafe(path: string): string | null {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return null;
    }
}

function walkTsWithoutTests(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const recurse = (d: string) => {
        for (const name of readdirSync(d)) {
            if (name === '__tests__' || name === 'node_modules') continue;
            const full = join(d, name);
            const stat = statSync(full);
            if (stat.isDirectory()) recurse(full);
            else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
        }
    };
    recurse(dir);
    return out;
}

describe('WO-A rewrite 2 §1 — module boundary isolation gate', () => {
    it('NPCEditForm.tsx contains no load-bearing isPC branch', () => {
        const file = readFileSafe(join(NPC_LEDGER_DIR, 'NPCEditForm.tsx'));
        expect(file).not.toBeNull();
        const lines = file!.split('\n');
        // Only comment references to isPC are permitted. A load-bearing use
        // would be an identifier reference not inside a `//` or `*` comment.
        const offending = lines.filter(l => {
            const trimmed = l.trim();
            if (!trimmed.includes('isPC')) return false;
            if (trimmed.startsWith('//') || trimmed.startsWith('*')) return false;
            return true;
        });
        expect(offending).toEqual([]);
    });

    it('NPCListView.tsx contains no isPC reference', () => {
        const file = readFileSafe(join(NPC_LEDGER_DIR, 'NPCListView.tsx'));
        expect(file).not.toBeNull();
        expect(file!.includes('isPC')).toBe(false);
    });

    it('NPCGalleryView.tsx contains no isPC reference', () => {
        const file = readFileSafe(join(NPC_LEDGER_DIR, 'NPCGalleryView.tsx'));
        expect(file).not.toBeNull();
        expect(file!.includes('isPC')).toBe(false);
    });

    it('NPCLedgerModal.tsx contains no isPC reference', () => {
        const file = readFileSafe(NPC_LEDGER_MODAL);
        expect(file).not.toBeNull();
        expect(file!.includes('isPC')).toBe(false);
    });

    it('no character/ component file imports NPCEditForm', () => {
        const files = walkTsWithoutTests(CHARACTER_DIR);
        const offenders = files.filter(f => {
            const text = readFileSafe(f);
            return text != null && /from\s+['"][^'"]*npc-ledger\/NPCEditForm['"]/.test(text);
        });
        expect(offenders).toEqual([]);
    });

    it('no character/ service file imports NPCEditForm', () => {
        const files = walkTsWithoutTests(CHARACTER_SERVICES_DIR);
        const offenders = files.filter(f => {
            const text = readFileSafe(f);
            return text != null && /from\s+['"][^'"]*npc-ledger\/NPCEditForm['"]/.test(text);
        });
        expect(offenders).toEqual([]);
    });

    // WO-A2 §4.9 — Isolation gate. No file in src/services/character/ or
    // src/components/character/ may import from npc-generation/; the only
    // permitted cross-module import is services/npc/signatureKit.ts.
    it('no character/ service or component file imports from npc-generation/', () => {
        const serviceFiles = walkTsWithoutTests(CHARACTER_SERVICES_DIR);
        const componentFiles = walkTsWithoutTests(CHARACTER_DIR);
        const all = [...serviceFiles, ...componentFiles];
        const offenders = all.filter(f => {
            const text = readFileSafe(f);
            return text != null && /from\s+['"][^'"]*services\/npc-generation['"]/.test(text);
        });
        expect(offenders).toEqual([]);
    });
});