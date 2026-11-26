// screens-gate.js — the gate screen for WO-P5-17.
//
// A deliberately simple screen: it renders a marker into its own frame
// body and stops. In 5.1 there is no host API (R6) — the frame receives
// nothing and sends nothing, so the screen draws from its own code only.
// This is the screen that proves a mod can ship a rendering surface a
// declared panel cannot describe, running where it cannot touch the app.
export default function () {
    const root = document.createElement('div');
    root.style.padding = '8px';
    root.style.fontFamily = 'monospace';
    root.style.fontSize = '11px';
    root.style.color = '#0f0';
    root.style.background = '#111';
    root.style.border = '1px solid #333';
    root.style.borderRadius = '3px';
    root.textContent = 'screens-gate: rendered in an isolated frame. The app is unaffected.';
    document.body.appendChild(root);
}
