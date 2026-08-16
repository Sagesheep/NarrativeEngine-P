/**
 * World Map — the canvas renderer.
 *
 * A content mount (`ctx.mounts.window()`) is in-page and inherits the app's
 * CSS custom properties, so the renderer reads theme tokens rather than
 * hardcoded colours. It draws the visible viewport only, evaluating the
 * field per visible cell — at sane zoom that is a few thousand evaluations,
 * cheap. The whole world is never evaluated.
 *
 *   • Pan and zoom. Anchors drawn as labelled markers; transit routes as
 *     lines between connected anchors.
 *   • No fog of war. Terrain renders everywhere because it is free and
 *     stable; only *content* is hidden. A visited-set is unnecessary at
 *     this stage.
 *   • Dragging an anchor re-pins it (tier 2) and re-solves.
 *
 * This module deliberately has no imports outside the mod. It receives the
 * solved campaign snapshot and the field module via the options bag, so the
 * host never has to reach into the mod's interior.
 */

import { BIOME_COLORS, FIELD_WORLD_SIZE, buildWarpField, biomeAt } from './field.js';

const CELL_PIXELS = 14;
const MIN_CELL_PIXELS = 4;
const MAX_CELL_PIXELS = 36;
const BASE_VIEW_CELLS = 60;
const LABEL_MIN_CELL_PIXELS = 9;
const DRAG_HIT_RADIUS_PX = 14;
const DOUBLE_CLICK_MS = 320;

function readToken(node, name, fallback) {
    const value = getComputedStyle(node).getPropertyValue(name).trim();
    return value || fallback;
}

function biomeColor(node, biomeId) {
    const token = readToken(node, `--worldmap-biome-${biomeId}`, '');
    if (token) return token;
    return BIOME_COLORS[biomeId] || '#444';
}

function applyStyle(node, styles) {
    Object.assign(node.style, styles);
    return node;
}

function makeElement(tag, text, styles = {}) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return applyStyle(node, styles);
}

/**
 * Mount the map renderer into `root`. Returns a cleanup function.
 *
 * @param {HTMLElement} root
 * @param {{
 *   getSnapshot: () => {
 *     anchors: Array<{ locationId: string, name: string, x: number, y: number, pinned: boolean, source: string }>,
 *     transects: Array<object>,
 *     connections: Array<{ fromId: string, toId: string }>,
 *     settings: { worldSeed: string, climateGradient: number },
 *     hardened: Map<string, string>,
 *     locationId: string | null,
 *   },
 *   onDragAnchor: (locationId: string, x: number, y: number) => void,
 *   log?: (...args: unknown[]) => void,
 * }} options
 */
export function mountMapRenderer(root, options) {
    const { getSnapshot, onDragAnchor, log = () => undefined } = options;

    applyStyle(root, {
        boxSizing: 'border-box',
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: 'var(--color-void-darker, #0e0f12)',
        color: 'var(--color-text-primary, inherit)',
        fontFamily: 'inherit',
        touchAction: 'none',
        cursor: 'grab',
    });

    const canvas = document.createElement('canvas');
    applyStyle(canvas, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
    root.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const overlay = makeElement('div', undefined, {
        position: 'absolute',
        inset: '0',
        pointerEvents: 'none',
    });
    root.appendChild(overlay);

    const hud = makeElement('div', undefined, {
        position: 'absolute',
        top: '8px',
        left: '8px',
        padding: '5px 9px',
        borderRadius: '5px',
        background: 'var(--color-void-lighter, rgba(20,21,25,0.78))',
        border: '1px solid var(--color-border, rgba(255,255,255,0.18))',
        color: 'var(--color-text-primary, inherit)',
        font: '11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace',
        pointerEvents: 'none',
        opacity: '0.9',
    });
    overlay.appendChild(hud);

    const help = makeElement('div', 'Scroll to zoom · Drag to pan · Drag a pin to move it', {
        position: 'absolute',
        bottom: '8px',
        left: '8px',
        padding: '4px 8px',
        borderRadius: '4px',
        background: 'var(--color-void-lighter, rgba(20,21,25,0.72))',
        color: 'var(--color-text-dim, inherit)',
        font: '10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace',
        pointerEvents: 'none',
        opacity: '0.78',
    });
    overlay.appendChild(help);

    const view = {
        cx: FIELD_WORLD_SIZE / 2,
        cy: FIELD_WORLD_SIZE / 2,
        cellPixels: CELL_PIXELS,
    };

    let dragging = null;
    let panLast = null;
    let pendingDragId = null;
    let pendingDragStart = null;
    let lastClickAt = 0;
    let lastClickLocationId = null;
    let resizeObserver = null;
    let rafHandle = 0;
    let dirty = true;

    function scheduleRender() {
        if (rafHandle) return;
        rafHandle = requestAnimationFrame(() => {
            rafHandle = 0;
            paint();
        });
    }

    function resize() {
        const rect = root.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            dirty = true;
        }
        scheduleRender();
    }

    function cellSizePixels() {
        return Math.max(MIN_CELL_PIXELS, Math.min(MAX_CELL_PIXELS, view.cellPixels));
    }

    function worldToScreen(x, y) {
        const rect = root.getBoundingClientRect();
        const cell = cellSizePixels();
        return {
            x: ((x - view.cx) * cell) + (rect.width / 2),
            y: ((y - view.cy) * cell) + (rect.height / 2),
        };
    }

    function screenToWorld(px, py) {
        const rect = root.getBoundingClientRect();
        const cell = cellSizePixels();
        return {
            x: ((px - (rect.width / 2)) / cell) + view.cx,
            y: ((py - (rect.height / 2)) / cell) + view.cy,
        };
    }

    function hitTestAnchor(px, py) {
        const snapshot = getSnapshot();
        if (!snapshot || !Array.isArray(snapshot.anchors)) return null;
        let best = null;
        let bestDistance = DRAG_HIT_RADIUS_PX;
        for (const anchor of snapshot.anchors) {
            const screen = worldToScreen(anchor.x, anchor.y);
            const d = Math.hypot(screen.x - px, screen.y - py);
            if (d <= bestDistance) {
                bestDistance = d;
                best = anchor;
            }
        }
        return best;
    }

    function clampView() {
        const margin = 10;
        view.cx = Math.max(-margin, Math.min(FIELD_WORLD_SIZE + margin, view.cx));
        view.cy = Math.max(-margin, Math.min(FIELD_WORLD_SIZE + margin, view.cy));
    }

    function paint() {
        const snapshot = getSnapshot();
        if (!snapshot || !snapshot.settings) return;
        const rect = root.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        const cell = cellSizePixels();
        const halfX = Math.ceil(w / 2 / cell);
        const halfY = Math.ceil(h / 2 / cell);
        const minX = Math.floor(view.cx - halfX) - 1;
        const maxX = Math.ceil(view.cx + halfX) + 1;
        const minY = Math.floor(view.cy - halfY) - 1;
        const maxY = Math.ceil(view.cy + halfY) + 1;
        const controls = buildWarpField(snapshot.transects);
        const hardened = snapshot.hardened instanceof Map ? snapshot.hardened : new Map();

        ctx.fillStyle = readToken(root, '--color-void-darker', '#0e0f12');
        ctx.fillRect(0, 0, w, h);

        for (let y = minY; y <= maxY; y += 1) {
            for (let x = minX; x <= maxX; x += 1) {
                const result = biomeAt(x, y, snapshot.settings.worldSeed, snapshot.settings.climateGradient, controls, hardened);
                const color = biomeColor(root, result.biome);
                ctx.fillStyle = color;
                const screen = worldToScreen(x, y);
                ctx.fillRect(Math.floor(screen.x), Math.floor(screen.y), Math.ceil(cell) + 1, Math.ceil(cell) + 1);
            }
        }

        if (snapshot.connections && cell >= LABEL_MIN_CELL_PIXELS) {
            ctx.lineWidth = Math.max(1, cell / 6);
            ctx.strokeStyle = readToken(root, '--color-border', 'rgba(220,220,220,0.55)');
            const byId = new Map((snapshot.anchors || []).map(a => [a.locationId, a]));
            for (const connection of snapshot.connections) {
                const from = byId.get(connection.fromId);
                const to = byId.get(connection.toId);
                if (!from || !to) continue;
                const fromScreen = worldToScreen(from.x, from.y);
                const toScreen = worldToScreen(to.x, to.y);
                ctx.beginPath();
                ctx.moveTo(fromScreen.x, fromScreen.y);
                ctx.lineTo(toScreen.x, toScreen.y);
                ctx.stroke();
            }
        }

        for (const anchor of snapshot.anchors || []) {
            const screen = worldToScreen(anchor.x, anchor.y);
            const radius = Math.max(5, cell / 2.4);
            const isCurrent = anchor.locationId === snapshot.locationId;
            ctx.beginPath();
            ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = anchor.pinned
                ? readToken(root, '--color-command-accent', '#E01B1B')
                : isCurrent
                    ? readToken(root, '--color-terminal', '#A78BFA')
                    : readToken(root, '--color-ice', '#E8EAED');
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = readToken(root, '--color-void-darker', '#0e0f12');
            ctx.stroke();

            if (cell >= LABEL_MIN_CELL_PIXELS) {
                ctx.font = '11px ui-monospace, SFMono-Regular, Consolas, monospace';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                const label = anchor.name || anchor.locationId;
                const labelX = screen.x + radius + 4;
                const labelY = screen.y - radius - 2;
                const metrics = ctx.measureText(label);
                ctx.fillStyle = 'rgba(0,0,0,0.55)';
                ctx.fillRect(labelX - 2, labelY - 8, metrics.width + 4, 16);
                ctx.fillStyle = readToken(root, '--color-text-primary', '#E8EAED');
                ctx.fillText(label, labelX, labelY);
            }
        }

        hud.textContent = `cell ${view.cx.toFixed(0)},${view.cy.toFixed(0)} · ${cell.toFixed(0)}px · ${(snapshot.anchors || []).length} anchors`;
        dirty = false;
    }

    function onPointerDown(event) {
        if (event.button !== undefined && event.button !== 0) return;
        const rect = root.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const hit = hitTestAnchor(px, py);
        if (hit) {
            pendingDragId = hit.locationId;
            pendingDragStart = { px, py, x: hit.x, y: hit.y };
            root.style.cursor = 'grabbing';
            return;
        }
        panLast = { px, py };
        root.style.cursor = 'grabbing';
    }

    function onPointerMove(event) {
        const rect = root.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        if (pendingDragId && pendingDragStart) {
            const cell = cellSizePixels();
            const dx = (px - pendingDragStart.px) / cell;
            const dy = (py - pendingDragStart.py) / cell;
            const x = pendingDragStart.x + dx;
            const y = pendingDragStart.y + dy;
            if (Math.hypot(px - pendingDragStart.px, py - pendingDragStart.py) > 3) {
                dragging = pendingDragId;
            }
            if (dragging === pendingDragId) {
                onDragAnchor(pendingDragId, Math.max(0, Math.min(FIELD_WORLD_SIZE - 1, x)), Math.max(0, Math.min(FIELD_WORLD_SIZE - 1, y)));
            }
            return;
        }
        if (panLast) {
            const cell = cellSizePixels();
            view.cx -= (px - panLast.px) / cell;
            view.cy -= (py - panLast.py) / cell;
            panLast = { px, py };
            clampView();
            scheduleRender();
            return;
        }
        const hover = hitTestAnchor(px, py);
        root.style.cursor = hover ? 'pointer' : 'grab';
    }

    function onPointerUp(event) {
        const rect = root.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        if (pendingDragId && pendingDragStart) {
            const moved = Math.hypot(px - pendingDragStart.px, py - pendingDragStart.py) > 3;
            if (!moved) {
                const now = Date.now();
                if (now - lastClickAt < DOUBLE_CLICK_MS && lastClickLocationId === pendingDragId) {
                    const world = screenToWorld(px, py);
                    onDragAnchor(pendingDragId, Math.max(0, Math.min(FIELD_WORLD_SIZE - 1, world.x)), Math.max(0, Math.min(FIELD_WORLD_SIZE - 1, world.y)));
                    lastClickAt = 0;
                    lastClickLocationId = null;
                } else {
                    lastClickAt = now;
                    lastClickLocationId = pendingDragId;
                }
            }
        }
        pendingDragId = null;
        pendingDragStart = null;
        dragging = null;
        panLast = null;
        root.style.cursor = 'grab';
    }

    function onWheel(event) {
        event.preventDefault();
        const rect = root.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const before = screenToWorld(px, py);
        const factor = Math.exp(-event.deltaY * 0.0015);
        view.cellPixels = Math.max(MIN_CELL_PIXELS, Math.min(MAX_CELL_PIXELS, view.cellPixels * factor));
        const cell = cellSizePixels();
        view.cx = before.x - ((px - rect.width / 2) / cell);
        view.cy = before.y - ((py - rect.height / 2) / cell);
        clampView();
        scheduleRender();
    }

    function centreOnAnchors() {
        const snapshot = getSnapshot();
        if (!snapshot || !Array.isArray(snapshot.anchors) || snapshot.anchors.length === 0) return;
        let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
        for (const a of snapshot.anchors) {
            if (a.x < minX) minX = a.x;
            if (a.y < minY) minY = a.y;
            if (a.x > maxX) maxX = a.x;
            if (a.y > maxY) maxY = a.y;
        }
        view.cx = (minX + maxX) / 2;
        view.cy = (minY + maxY) / 2;
        const span = Math.max(maxX - minX, maxY - minY, 10) + 8;
        const rect = root.getBoundingClientRect();
        const targetCell = Math.min(rect.width, rect.height) / span;
        view.cellPixels = Math.max(MIN_CELL_PIXELS, Math.min(MAX_CELL_PIXELS, targetCell));
        clampView();
        scheduleRender();
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => { dirty = true; resize(); });
        resizeObserver.observe(root);
    } else {
        window.addEventListener('resize', resize);
    }

    resize();
    centreOnAnchors();
    paint();

    const repaint = () => { dirty = true; scheduleRender(); };

    return () => {
        if (rafHandle) cancelAnimationFrame(rafHandle);
        rafHandle = 0;
        canvas.removeEventListener('pointerdown', onPointerDown);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('wheel', onWheel);
        if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
        else window.removeEventListener('resize', resize);
        root.replaceChildren();
    };
}