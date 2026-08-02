import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { enumerateBlocks } from '../blockModel';

/**
 * WO-P5-02 §9 — visual artifact generator.
 *
 * Renders the real registry data into a self-contained HTML file that mirrors the
 * BlockViewModal's visual structure. The artifact is the handoff screenshot
 * substitute for environments without a GUI browser: it is produced from the same
 * `enumerateBlocks()` the live component calls, so a block that appears here is a
 * block the live view would render, and a block missing here is the architecture
 * finding the work order asks for (§11 item 4).
 *
 * This test writes the file and asserts it is non-empty; it does not assert on
 * rendered DOM (the liveWiring.test.tsx does that). Run it once to produce the
 * artifact, then open the HTML file to screenshot.
 */

describe('WO-P5-02 §9 — visual artifact', () => {
    it('renders the block view into a self-contained HTML file from real registry data', () => {
        const { tier, contributions, tracks } = enumerateBlocks();
        const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const card = (b: typeof tier[number]) => {
            const kind = b.kind === 'model' ? 'MODEL' : 'ENGINE';
            const locked = !b.switchable;
            const badge = locked
                ? (b.lockReason === 'manual' ? 'MANUAL'
                    : b.lockReason === 'unwired' ? 'UNWIRED'
                    : 'LOCKED')
                : 'ON';
            const border = b.kind === 'model' ? '#6A9FD4' : '#5A6B80';
            const bg = locked ? 'transparent' : (b.kind === 'model' ? '#1B2634' : '#ECEEF1');
            const borderStyle = locked ? (b.lockReason === 'unwired' ? 'dotted' : 'dashed') : 'solid';
            const inkColor = b.kind === 'model' ? '#9CC3E8' : '#475869';
            const bgColor = b.kind === 'model' ? '#1B2634' : '#ECEEF1';
            return `<div style="width:180px;flex-shrink:0;border:1px ${borderStyle} ${border};background:${bg};border-left:3px solid ${border};padding:8px 10px;border-radius:3px;display:flex;flex-direction:column;gap:5px;box-sizing:border-box;${locked ? 'opacity:0.85' : ''}">
<div style="display:flex;justify-content:space-between;align-items:center">
<span style="font-family:monospace;font-size:8px;font-weight:700;letter-spacing:0.1em;padding:1px 5px;border:1px solid ${border};color:${inkColor};background:${bgColor}">${kind}</span>
<span style="font-family:monospace;font-size:8px;font-weight:700;letter-spacing:0.1em;padding:1px 5px;border:1px solid #3E3E45;color:#909090">${badge}</span>
</div>
<p style="font-family:monospace;font-size:11px;font-weight:600;margin:0;line-height:1.3;word-break:break-word;color:#EBEBEB">${esc(b.name)}</p>
<p style="font-size:9px;color:#909090;margin:0;line-height:1.35;word-break:break-word">${esc(b.description)}</p>
</div>`;
        };

        const section = (title: string, help: string, list: typeof tier) => {
            return `<section style="display:flex;flex-direction:column;gap:8px">
<div>
<div style="font-family:monospace;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#EBEBEB">${esc(title)}</div>
<p style="font-size:9px;color:#909090;margin:2px 0 0 0;max-width:680px">${esc(help)}</p>
</div>
<div style="overflow-x:auto;border:1px solid #2E2E33;background:#1C1C1F;border-radius:3px">
<div style="display:flex;align-items:stretch;gap:10px;padding:10px;width:max-content">
${list.map(card).join('\n')}
</div>
</div>
</section>`;
        };

        const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Block View — visual artifact (WO-P5-02 §9)</title>
<style>body{margin:0;background:#161618;color:#EBEBEB;font-family:system-ui,sans-serif}.wrap{padding:16px;max-width:100%}</style>
</head><body><div class="wrap">
<h2 style="font-family:monospace;color:#6A9FD4;font-size:14px;letter-spacing:0.2em;text-transform:uppercase;margin:0 0 8px">ONE TURN, LEFT TO RIGHT</h2>
<p style="font-size:11px;color:#909090;max-width:74ch;margin:0 0 12px">Every block the turn runs, in the order the registries publish them. Switch one off and the next turn skips it. Blocks stacked in the same column run concurrently.</p>
<div style="display:flex;flex-wrap:wrap;gap:8px 16px;font-family:monospace;font-size:10px;color:#909090;margin-bottom:16px">
<span>ENGINE — deterministic code, no model</span>
<span>MODEL — calls a language model</span>
<span>LOCKED — structural, not a feature</span>
<span>MANUAL — fires from a button, not the pipeline</span>
</div>
<div style="display:flex;gap:8px;align-items:center;margin-bottom:16px;border:1px solid #2E2E33;background:#1C1C1F;padding:8px 12px;border-radius:3px;flex-wrap:wrap">
<span style="font-family:monospace;font-size:10px;color:#909090;text-transform:uppercase">Tier</span>
<span style="font-family:monospace;font-size:10px;font-weight:700;color:#6A9FD4;border:1px solid #6A9FD4;background:#1B2634;padding:2px 6px;border-radius:3px">PRO</span>
<span style="font-size:9px;color:#909090;font-style:italic">Read-only. Cycle it from the header.</span>
<span style="margin-left:auto;font-family:monospace;font-size:9px;text-transform:uppercase;color:#909090">Apply preset</span>
<button style="font-family:monospace;font-size:10px;font-weight:700;letter-spacing:0.05em;padding:3px 8px;border:1px solid #6A9FD4;color:#6A9FD4;background:#1B2634;border-radius:3px;cursor:pointer">Lite</button>
<button style="font-family:monospace;font-size:10px;font-weight:700;letter-spacing:0.05em;padding:3px 8px;border:1px solid #6A9FD4;color:#6A9FD4;background:#1B2634;border-radius:3px;cursor:pointer">Pro</button>
<button style="font-family:monospace;font-size:10px;font-weight:700;letter-spacing:0.05em;padding:3px 8px;border:1px solid #6A9FD4;color:#6A9FD4;background:#1B2634;border-radius:3px;cursor:pointer">Max</button>
</div>
<div style="display:flex;flex-direction:column;gap:20px">
${section('Tier features', 'Pipeline stages gated by the active tier. A toggle writes an explicit override; the tier preset itself is shown read-only.', tier)}
${section('Prompt contributions', 'Blocks assembled into the final user message below the cache boundary. Built-ins and installed mods.', contributions)}
${section('Post-turn tracks', 'Background work that runs after the scene commits. Tracks are not in the tier matrix; absent means enabled.', tracks)}
</div>
<p style="margin-top:20px;font-size:10px;color:#909090;border-top:1px solid #2E2E33;padding-top:10px">Generated from real registry data. Tier: ${tier.length} blocks. Contributions: ${contributions.length} blocks. Tracks: ${tracks.length} blocks. Total: ${tier.length + contributions.length + tracks.length} blocks.</p>
</div></body></html>`;

        const outPath = resolve(__dirname, '../../../../Upgrade/EPIC PROJECT - Modularity/Project 5 - Block Architecture/BLOCK_VIEW_ARTIFACT.html');
        writeFileSync(outPath, html);
        expect(html.length).toBeGreaterThan(1000);
        expect(tier.length).toBe(27);
        expect(contributions.length).toBe(8);
        expect(tracks.length).toBe(4);
    });
});