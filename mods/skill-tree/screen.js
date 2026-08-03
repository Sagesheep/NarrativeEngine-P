// skill-tree.screen.js — a node-graph editor for character skill trees.
//
// This file is a MOD. It runs inside a sandboxed iframe with no access to the
// app's DOM, no storage, and no network. It reaches the host only through the
// four capabilities in 11_SCREEN_API.md: table.read, table.write, theme, resize.
//
// It uses `export default` as its entry point — the host rewrites that token to
// an assignment before inlining the source, and does so comment-aware, which is
// why this very sentence does not break the frame.
//
// No npm packages, no web fonts, no icon library, no external images. Vanilla
// JS and inline SVG, coloured entirely from host theme tokens.

export default async function () {
    const api = globalThis.__screenApi;
    const theme = await api.request('theme');
    const C = theme.colors;
    const FS = theme.fontSizes;
    const RAD = theme.radii;

    const TABLE = 'tree';
    const NODE_W = 208;
    const NODE_H = 68;
    const PORT_R = 5;
    const MIN_K = 0.35;
    const MAX_K = 2.4;

    // ── state ────────────────────────────────────────────────────────────
    let nodes = [];
    let links = [];
    let selection = null; // { kind: 'node' | 'link', id }
    let view = { x: 40, y: 40, k: 1 };
    let seq = 0;

    const loaded = await api.request({ capability: 'table.read', table: TABLE });
    if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
        if (Array.isArray(loaded.nodes)) nodes = loaded.nodes.filter(isNode);
        if (Array.isArray(loaded.links)) links = loaded.links.filter(isLink);
    }
    for (const n of nodes) {
        const numeric = Number(String(n.id).replace(/[^0-9]/g, ''));
        if (Number.isFinite(numeric) && numeric > seq) seq = numeric;
    }

    function isNode(n) {
        return n && typeof n === 'object' && typeof n.id === 'string'
            && Number.isFinite(n.x) && Number.isFinite(n.y);
    }
    function isLink(l) {
        return l && typeof l === 'object' && typeof l.from === 'string' && typeof l.to === 'string';
    }
    function nodeById(id) {
        return nodes.find((n) => n.id === id) || null;
    }
    function linkId(l) {
        return l.from + '→' + l.to;
    }

    await api.request({ capability: 'resize', height: 660 });

    // ── chrome ───────────────────────────────────────────────────────────
    document.body.innerHTML = ''
        + '<style>'
        + '*{box-sizing:border-box;margin:0;padding:0}'
        + 'body{background:' + C.background + ';color:' + C.text + ';'
        + 'font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;'
        + 'font-size:' + FS.body + ';overflow:hidden;height:100vh}'
        + '#shell{display:flex;flex-direction:column;height:100vh}'
        + '#bar{display:flex;align-items:center;gap:10px;padding:10px 14px;'
        + 'background:' + C.surface + ';border-bottom:1px solid ' + C.border + ';flex:0 0 auto}'
        + '#bar .grow{flex:1}'
        + '.btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;'
        + 'border-radius:' + RAD.small + ';border:1px solid ' + C.border + ';background:transparent;'
        + 'color:' + C.text + ';font-size:' + FS.body + ';font-family:inherit;cursor:pointer;'
        + 'transition:background .12s,border-color .12s,color .12s}'
        + '.btn:hover{background:rgba(255,255,255,.05);border-color:' + C.muted + '}'
        + '.btn.primary{background:' + C.accent + ';border-color:' + C.accent + ';color:#12101c;font-weight:600}'
        + '.btn.primary:hover{filter:brightness(1.08)}'
        + '.btn.danger{border-color:' + C.danger + ';color:' + C.danger + '}'
        + '.btn.danger:hover{background:rgba(248,113,113,.12)}'
        + '.btn svg{width:14px;height:14px;flex:0 0 auto}'
        + '.meta{font-size:' + FS.small + ';color:' + C.muted + ';white-space:nowrap}'
        + '#status{font-size:' + FS.small + ';color:' + C.muted + ';min-width:96px;text-align:right}'
        + '#status.dirty{color:' + C.accent + '}'
        + '#main{flex:1;display:flex;min-height:0}'
        + '#stage{flex:1;position:relative;min-width:0}'
        + '#canvas{width:100%;height:100%;display:block;cursor:grab;touch-action:none}'
        + '#canvas.panning{cursor:grabbing}'
        + '#empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;'
        + 'justify-content:center;gap:10px;pointer-events:none;text-align:center;padding:24px}'
        + '#empty h2{font-size:' + FS.heading + ';font-weight:600;color:' + C.text + '}'
        + '#empty p{font-size:' + FS.body + ';color:' + C.muted + ';max-width:320px;line-height:1.5}'
        + '#empty .ring{width:56px;height:56px;border-radius:50%;border:1px dashed ' + C.border + ';'
        + 'display:flex;align-items:center;justify-content:center;color:' + C.muted + '}'
        + '#empty .ring svg{width:22px;height:22px}'
        + '#panel{flex:0 0 248px;background:' + C.surface + ';border-left:1px solid ' + C.border + ';'
        + 'padding:14px;display:flex;flex-direction:column;gap:12px;overflow-y:auto}'
        + '#panel.hidden{display:none}'
        + '#panel h3{font-size:' + FS.small + ';text-transform:uppercase;letter-spacing:.08em;color:' + C.muted + ';font-weight:600}'
        + '#panel label{display:block;font-size:' + FS.small + ';color:' + C.muted + ';margin-bottom:5px}'
        + '#panel input,#panel textarea{width:100%;background:' + C.background + ';color:' + C.text + ';'
        + 'border:1px solid ' + C.border + ';border-radius:' + RAD.small + ';padding:7px 9px;'
        + 'font-size:' + FS.body + ';font-family:inherit;outline:none;transition:border-color .12s}'
        + '#panel input:focus,#panel textarea:focus{border-color:' + C.accent + '}'
        + '#panel textarea{resize:vertical;min-height:74px;line-height:1.45}'
        + '.prereq{display:flex;align-items:center;gap:6px;font-size:' + FS.small + ';color:' + C.muted + ';'
        + 'padding:5px 8px;background:' + C.background + ';border:1px solid ' + C.border + ';'
        + 'border-radius:' + RAD.small + ';margin-bottom:5px}'
        + '.prereq span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:' + C.text + '}'
        + '.prereq button{background:none;border:none;color:' + C.muted + ';cursor:pointer;padding:0;'
        + 'display:flex;font-family:inherit}'
        + '.prereq button:hover{color:' + C.danger + '}'
        + '.prereq button svg{width:12px;height:12px}'
        + '#toast{position:absolute;left:50%;bottom:20px;transform:translateX(-50%) translateY(8px);'
        + 'background:' + C.surface + ';border:1px solid ' + C.border + ';border-radius:' + RAD.medium + ';'
        + 'padding:9px 14px;font-size:' + FS.body + ';box-shadow:0 8px 24px rgba(0,0,0,.5);'
        + 'opacity:0;transition:opacity .18s,transform .18s;pointer-events:none;max-width:80%}'
        + '#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}'
        + '#toast.error{border-color:' + C.danger + ';color:' + C.danger + '}'
        + '</' + 'style>'
        + '<div id="shell">'
        + '<div id="bar">'
        + '<button class="btn primary" id="add">' + icon('plus') + 'Add Skill</button>'
        + '<button class="btn" id="fit">' + icon('fit') + 'Fit</button>'
        + '<span class="meta" id="count"></span>'
        + '<span class="grow"></span>'
        + '<span class="meta">drag a right-hand dot onto another skill to set a prerequisite</span>'
        + '<span id="status"></span>'
        + '</div>'
        + '<div id="main">'
        + '<div id="stage">'
        + '<svg id="canvas"></svg>'
        + '<div id="empty">'
        + '<div class="ring">' + icon('node') + '</div>'
        + '<h2>No skills yet</h2>'
        + '<p>Add your first skill to start the tree, then drag between them to chain prerequisites.</p>'
        + '</div>'
        + '<div id="toast"></div>'
        + '</div>'
        + '<div id="panel" class="hidden"></div>'
        + '</div>'
        + '</div>';

    function icon(name) {
        const open = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
            + 'stroke-linecap="round" stroke-linejoin="round">';
        const paths = {
            plus: '<path d="M12 5v14M5 12h14"/>',
            fit: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
            trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
            node: '<rect x="3" y="8" width="7" height="8" rx="2"/><rect x="14" y="8" width="7" height="8" rx="2"/><path d="M10 12h4"/>',
        };
        return open + (paths[name] || '') + '</svg>';
    }

    const canvas = document.getElementById('canvas');
    const panel = document.getElementById('panel');
    const emptyState = document.getElementById('empty');
    const statusEl = document.getElementById('status');
    const countEl = document.getElementById('count');
    const toastEl = document.getElementById('toast');

    const SVG_NS = 'http://www.w3.org/2000/svg';
    function svg(tag, attrs) {
        const el = document.createElementNS(SVG_NS, tag);
        for (const key in attrs) el.setAttribute(key, String(attrs[key]));
        return el;
    }

    canvas.innerHTML = ''
        + '<defs>'
        + '<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse">'
        + '<circle cx="1.4" cy="1.4" r="1.4" fill="' + C.border + '" opacity="0.5"/>'
        + '</pattern>'
        + '<filter id="lift" x="-40%" y="-40%" width="180%" height="180%">'
        + '<feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#000" flood-opacity="0.5"/>'
        + '</filter>'
        + '</defs>';

    const root = svg('g', {});
    const grid = svg('rect', {
        x: -12000, y: -12000, width: 24000, height: 24000, fill: 'url(#dots)',
    });
    const linkLayer = svg('g', {});
    const ghostLayer = svg('g', {});
    const nodeLayer = svg('g', {});
    root.appendChild(grid);
    root.appendChild(linkLayer);
    root.appendChild(ghostLayer);
    root.appendChild(nodeLayer);
    canvas.appendChild(root);

    // ── persistence ──────────────────────────────────────────────────────
    let saveTimer = null;
    let saving = false;

    function markDirty() {
        statusEl.textContent = 'Unsaved';
        statusEl.className = 'dirty';
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 400);
    }

    async function save() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
        if (saving) { markDirty(); return; }
        saving = true;
        statusEl.textContent = 'Saving…';
        statusEl.className = 'dirty';
        try {
            await api.request({
                capability: 'table.write',
                table: TABLE,
                value: { nodes: nodes, links: links },
            });
            statusEl.textContent = 'Saved';
            statusEl.className = '';
        } catch (err) {
            statusEl.textContent = 'Not saved';
            statusEl.className = 'dirty';
            toast('Could not save: ' + (err && err.message ? err.message : err), true);
        } finally {
            saving = false;
        }
    }

    let toastTimer = null;
    function toast(message, isError) {
        toastEl.textContent = message;
        toastEl.className = 'show' + (isError ? ' error' : '');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { toastEl.className = ''; }, 2600);
    }

    // ── geometry ─────────────────────────────────────────────────────────
    function applyView() {
        root.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.k + ')');
    }

    function toWorld(clientX, clientY) {
        const box = canvas.getBoundingClientRect();
        return {
            x: (clientX - box.left - view.x) / view.k,
            y: (clientY - box.top - view.y) / view.k,
        };
    }

    function outPort(n) { return { x: n.x + NODE_W, y: n.y + NODE_H / 2 }; }
    function inPort(n) { return { x: n.x, y: n.y + NODE_H / 2 }; }

    function curve(a, b) {
        const dx = Math.max(46, Math.abs(b.x - a.x) * 0.45);
        return 'M ' + a.x + ' ' + a.y
            + ' C ' + (a.x + dx) + ' ' + a.y + ', ' + (b.x - dx) + ' ' + b.y
            + ', ' + b.x + ' ' + b.y;
    }

    // ── graph rules ──────────────────────────────────────────────────────
    function reaches(startId, targetId) {
        const stack = [startId];
        const seen = new Set();
        while (stack.length) {
            const current = stack.pop();
            if (current === targetId) return true;
            if (seen.has(current)) continue;
            seen.add(current);
            for (const l of links) if (l.from === current) stack.push(l.to);
        }
        return false;
    }

    function addLink(from, to) {
        if (from === to) { toast('A skill cannot require itself.', true); return false; }
        if (links.some((l) => l.from === from && l.to === to)) {
            toast('That prerequisite already exists.', true);
            return false;
        }
        if (reaches(to, from)) {
            toast('That would create a prerequisite loop.', true);
            return false;
        }
        links.push({ from: from, to: to });
        markDirty();
        render();
        return true;
    }

    // ── rendering ────────────────────────────────────────────────────────
    const nodeEls = new Map();
    const linkEls = new Map();

    function render() {
        linkLayer.innerHTML = '';
        nodeLayer.innerHTML = '';
        nodeEls.clear();
        linkEls.clear();

        for (const l of links) {
            const a = nodeById(l.from);
            const b = nodeById(l.to);
            if (!a || !b) continue;
            const id = linkId(l);
            const active = selection && selection.kind === 'link' && selection.id === id;
            const d = curve(outPort(a), inPort(b));

            const hit = svg('path', {
                d: d, fill: 'none', stroke: 'transparent', 'stroke-width': 16, cursor: 'pointer',
            });
            hit.addEventListener('pointerdown', (event) => {
                event.stopPropagation();
                select({ kind: 'link', id: id });
            });
            const line = svg('path', {
                d: d,
                fill: 'none',
                stroke: active ? C.accent : C.border,
                'stroke-width': active ? 2.4 : 1.8,
                'stroke-linecap': 'round',
                'pointer-events': 'none',
            });
            const dot = svg('circle', {
                cx: inPort(b).x, cy: inPort(b).y, r: 3,
                fill: active ? C.accent : C.border, 'pointer-events': 'none',
            });
            linkLayer.appendChild(line);
            linkLayer.appendChild(dot);
            linkLayer.appendChild(hit);
            linkEls.set(id, { line: line, dot: dot, hit: hit, from: l.from, to: l.to });
        }

        for (const n of nodes) {
            const active = selection && selection.kind === 'node' && selection.id === n.id;
            const g = svg('g', { transform: 'translate(' + n.x + ',' + n.y + ')', cursor: 'grab' });
            g.dataset.node = n.id;

            if (active) {
                g.appendChild(svg('rect', {
                    x: -3, y: -3, width: NODE_W + 6, height: NODE_H + 6,
                    rx: Number(RAD.medium.replace('px', '')) + 3,
                    fill: 'none', stroke: C.accent, 'stroke-width': 1.5, opacity: 0.45,
                }));
            }

            const card = svg('rect', {
                x: 0, y: 0, width: NODE_W, height: NODE_H, rx: RAD.medium.replace('px', ''),
                fill: C.surface, stroke: active ? C.accent : C.border,
                'stroke-width': active ? 1.6 : 1, filter: 'url(#lift)',
            });
            g.appendChild(card);

            g.appendChild(svg('rect', {
                x: 0, y: 0, width: 3, height: NODE_H,
                rx: 1.5, fill: active ? C.accent : C.muted, opacity: active ? 1 : 0.4,
            }));

            const title = svg('text', {
                x: 16, y: 27, fill: C.text, 'font-size': FS.body,
                'font-weight': 600, 'font-family': 'inherit', 'pointer-events': 'none',
            });
            title.textContent = clip(n.name || 'Untitled skill', 24);
            g.appendChild(title);

            const sub = svg('text', {
                x: 16, y: 46, fill: C.muted, 'font-size': FS.small,
                'font-family': 'inherit', 'pointer-events': 'none',
            });
            sub.textContent = clip(n.description || 'No description', 30);
            g.appendChild(sub);

            const target = svg('circle', {
                cx: 0, cy: NODE_H / 2, r: PORT_R,
                fill: C.background, stroke: C.border, 'stroke-width': 1.5,
            });
            target.dataset.port = 'in';
            g.appendChild(target);

            const source = svg('circle', {
                cx: NODE_W, cy: NODE_H / 2, r: PORT_R,
                fill: C.background, stroke: C.accent, 'stroke-width': 1.5, cursor: 'crosshair',
            });
            source.dataset.port = 'out';
            source.addEventListener('pointerdown', (event) => {
                event.stopPropagation();
                startLink(n, event);
            });
            source.addEventListener('pointerenter', () => source.setAttribute('r', PORT_R + 2));
            source.addEventListener('pointerleave', () => source.setAttribute('r', PORT_R));
            g.appendChild(source);

            g.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                event.stopPropagation();
                select({ kind: 'node', id: n.id });
                startDrag(n, event, g);
            });

            nodeLayer.appendChild(g);
            nodeEls.set(n.id, g);
        }

        emptyState.style.display = nodes.length ? 'none' : 'flex';
        countEl.textContent = nodes.length + (nodes.length === 1 ? ' skill' : ' skills')
            + ' · ' + links.length + (links.length === 1 ? ' link' : ' links');
        renderPanel();
    }

    function clip(text, max) {
        const value = String(text);
        return value.length > max ? value.slice(0, max - 1) + '…' : value;
    }

    // ── inspector ────────────────────────────────────────────────────────
    function renderPanel() {
        if (!selection) { panel.className = 'hidden'; panel.innerHTML = ''; return; }
        panel.className = '';

        if (selection.kind === 'link') {
            const parts = selection.id.split('→');
            const from = nodeById(parts[0]);
            const to = nodeById(parts[1]);
            panel.innerHTML = '<h3>Prerequisite</h3>';
            const body = document.createElement('p');
            body.style.cssText = 'font-size:' + FS.body + ';color:' + C.muted + ';line-height:1.5';
            body.textContent = (from ? from.name || 'Untitled' : '?')
                + ' must be taken before ' + (to ? to.name || 'Untitled' : '?') + '.';
            panel.appendChild(body);
            const remove = document.createElement('button');
            remove.className = 'btn danger';
            remove.innerHTML = icon('trash') + 'Remove link';
            remove.addEventListener('click', () => {
                links = links.filter((l) => linkId(l) !== selection.id);
                selection = null;
                markDirty();
                render();
            });
            panel.appendChild(remove);
            return;
        }

        const node = nodeById(selection.id);
        if (!node) { selection = null; panel.className = 'hidden'; panel.innerHTML = ''; return; }

        panel.innerHTML = '<h3>Skill</h3>';

        const nameWrap = document.createElement('div');
        nameWrap.innerHTML = '<label for="f-name">Name</label>';
        const name = document.createElement('input');
        name.id = 'f-name';
        name.value = node.name || '';
        name.addEventListener('input', () => {
            node.name = name.value;
            const g = nodeEls.get(node.id);
            if (g) g.querySelectorAll('text')[0].textContent = clip(name.value || 'Untitled skill', 24);
            markDirty();
        });
        nameWrap.appendChild(name);
        panel.appendChild(nameWrap);

        const descWrap = document.createElement('div');
        descWrap.innerHTML = '<label for="f-desc">Description</label>';
        const desc = document.createElement('textarea');
        desc.id = 'f-desc';
        desc.value = node.description || '';
        desc.addEventListener('input', () => {
            node.description = desc.value;
            const g = nodeEls.get(node.id);
            if (g) g.querySelectorAll('text')[1].textContent = clip(desc.value || 'No description', 30);
            markDirty();
        });
        descWrap.appendChild(desc);
        panel.appendChild(descWrap);

        const incoming = links.filter((l) => l.to === node.id);
        const prereqWrap = document.createElement('div');
        prereqWrap.innerHTML = '<h3 style="margin-bottom:7px">Requires</h3>';
        if (!incoming.length) {
            const none = document.createElement('p');
            none.style.cssText = 'font-size:' + FS.small + ';color:' + C.muted;
            none.textContent = 'No prerequisites.';
            prereqWrap.appendChild(none);
        }
        for (const l of incoming) {
            const source = nodeById(l.from);
            const row = document.createElement('div');
            row.className = 'prereq';
            const label = document.createElement('span');
            label.textContent = source ? (source.name || 'Untitled skill') : l.from;
            const cut = document.createElement('button');
            cut.innerHTML = icon('trash');
            cut.title = 'Remove this prerequisite';
            cut.addEventListener('click', () => {
                links = links.filter((x) => !(x.from === l.from && x.to === l.to));
                markDirty();
                render();
            });
            row.appendChild(label);
            row.appendChild(cut);
            prereqWrap.appendChild(row);
        }
        panel.appendChild(prereqWrap);

        const remove = document.createElement('button');
        remove.className = 'btn danger';
        remove.innerHTML = icon('trash') + 'Delete skill';
        remove.addEventListener('click', () => deleteNode(node.id));
        panel.appendChild(remove);
    }

    function select(next) {
        selection = next;
        render();
    }

    function deleteNode(id) {
        nodes = nodes.filter((n) => n.id !== id);
        links = links.filter((l) => l.from !== id && l.to !== id);
        selection = null;
        markDirty();
        render();
    }

    // ── dragging a node ──────────────────────────────────────────────────
    function startDrag(node, event, g) {
        const start = toWorld(event.clientX, event.clientY);
        const originX = node.x;
        const originY = node.y;
        let moved = false;
        g.style.cursor = 'grabbing';

        function move(moveEvent) {
            const now = toWorld(moveEvent.clientX, moveEvent.clientY);
            node.x = Math.round(originX + (now.x - start.x));
            node.y = Math.round(originY + (now.y - start.y));
            moved = true;
            g.setAttribute('transform', 'translate(' + node.x + ',' + node.y + ')');
            redrawLinksFor(node.id);
        }
        function up() {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            g.style.cursor = 'grab';
            if (moved) markDirty();
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    function redrawLinksFor(id) {
        for (const entry of linkEls.values()) {
            if (entry.from !== id && entry.to !== id) continue;
            const a = nodeById(entry.from);
            const b = nodeById(entry.to);
            if (!a || !b) continue;
            const head = inPort(b);
            const d = curve(outPort(a), head);
            entry.line.setAttribute('d', d);
            entry.hit.setAttribute('d', d);
            entry.dot.setAttribute('cx', String(head.x));
            entry.dot.setAttribute('cy', String(head.y));
        }
    }

    // ── dragging a link ──────────────────────────────────────────────────
    function startLink(node, event) {
        const from = outPort(node);
        const ghost = svg('path', {
            fill: 'none', stroke: C.accent, 'stroke-width': 2,
            'stroke-dasharray': '5 4', 'stroke-linecap': 'round', 'pointer-events': 'none',
        });
        ghostLayer.appendChild(ghost);

        function move(moveEvent) {
            const to = toWorld(moveEvent.clientX, moveEvent.clientY);
            ghost.setAttribute('d', curve(from, to));
        }
        function up(upEvent) {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            ghost.remove();
            const under = document.elementFromPoint(upEvent.clientX, upEvent.clientY);
            const host = under && under.closest ? under.closest('[data-node]') : null;
            if (host && host.dataset.node) addLink(node.id, host.dataset.node);
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    // ── canvas pan and zoom ──────────────────────────────────────────────
    canvas.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        select(null);
        const startX = event.clientX;
        const startY = event.clientY;
        const originX = view.x;
        const originY = view.y;
        canvas.classList.add('panning');

        function move(moveEvent) {
            view.x = originX + (moveEvent.clientX - startX);
            view.y = originY + (moveEvent.clientY - startY);
            applyView();
        }
        function up() {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            canvas.classList.remove('panning');
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    });

    canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        const box = canvas.getBoundingClientRect();
        const px = event.clientX - box.left;
        const py = event.clientY - box.top;
        const before = { x: (px - view.x) / view.k, y: (py - view.y) / view.k };
        const next = Math.min(MAX_K, Math.max(MIN_K, view.k * Math.exp(-event.deltaY * 0.0015)));
        view.k = next;
        view.x = px - before.x * next;
        view.y = py - before.y * next;
        applyView();
    }, { passive: false });

    function fit() {
        if (!nodes.length) { view = { x: 40, y: 40, k: 1 }; applyView(); return; }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nodes) {
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x + NODE_W);
            maxY = Math.max(maxY, n.y + NODE_H);
        }
        const box = canvas.getBoundingClientRect();
        const pad = 56;
        const k = Math.min(MAX_K, Math.max(MIN_K,
            Math.min((box.width - pad * 2) / (maxX - minX), (box.height - pad * 2) / (maxY - minY))));
        view.k = k;
        view.x = (box.width - (maxX - minX) * k) / 2 - minX * k;
        view.y = (box.height - (maxY - minY) * k) / 2 - minY * k;
        applyView();
    }

    // ── toolbar and keyboard ─────────────────────────────────────────────
    document.getElementById('add').addEventListener('click', () => {
        seq += 1;
        const box = canvas.getBoundingClientRect();
        const centre = toWorld(box.left + box.width / 2, box.top + box.height / 2);
        const node = {
            id: 'skill-' + seq,
            name: 'New skill',
            description: '',
            x: Math.round(centre.x - NODE_W / 2 + (nodes.length % 4) * 18),
            y: Math.round(centre.y - NODE_H / 2 + (nodes.length % 4) * 18),
        };
        nodes.push(node);
        selection = { kind: 'node', id: node.id };
        markDirty();
        render();
        const field = document.getElementById('f-name');
        if (field) { field.focus(); field.select(); }
    });

    document.getElementById('fit').addEventListener('click', fit);

    window.addEventListener('keydown', (event) => {
        const tag = document.activeElement ? document.activeElement.tagName : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
            if (event.key === 'Escape') document.activeElement.blur();
            return;
        }
        if (event.key === 'Escape') { select(null); return; }
        if (event.key !== 'Delete' && event.key !== 'Backspace') return;
        if (!selection) return;
        event.preventDefault();
        if (selection.kind === 'node') deleteNode(selection.id);
        else {
            links = links.filter((l) => linkId(l) !== selection.id);
            selection = null;
            markDirty();
            render();
        }
    });

    // ── go ───────────────────────────────────────────────────────────────
    applyView();
    render();
    statusEl.textContent = 'Saved';
    if (nodes.length) fit();
}
