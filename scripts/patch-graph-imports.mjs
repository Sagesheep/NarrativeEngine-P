import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, sep, normalize, posix } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const GRAPH_JSON = resolve(ROOT, 'graphify-out', 'graph.json');
const GRAPH_HTML = resolve(ROOT, 'graphify-out', 'graph.html');

const graph = JSON.parse(readFileSync(GRAPH_JSON, 'utf8'));

const nodesById = new Map();
const nodesBySourceFile = new Map();
for (const n of graph.nodes) {
    nodesById.set(n.id, n);
    if (n.source_file) {
        const key = normalize(n.source_file).replace(/\\/g, '/');
        if (!nodesBySourceFile.has(key)) nodesBySourceFile.set(key, []);
        nodesBySourceFile.get(key).push(n);
    }
}

function getFileNodeId(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const candidates = nodesBySourceFile.get(normalized);
    if (candidates) {
        const fileNode = candidates.find(n => n.source_location === 'L1' || n.source_file.endsWith(normalized));
        if (fileNode) return fileNode.id;
        return candidates[0].id;
    }
    const base = normalized.split('/').pop().replace(/\.(js|ts|tsx|jsx|cjs|mjs)$/, '').toLowerCase();
    for (const [id, node] of nodesById) {
        const sf = normalize(node.source_file).replace(/\\/g, '/');
        if (sf === normalized) return id;
        if (sf.endsWith('/' + normalized)) return id;
    }
    return null;
}

function resolveImportPath(fromFile, importPath) {
    if (!importPath.startsWith('.')) return null;
    const dir = fromFile.includes('/') ? fromFile.substring(0, fromFile.lastIndexOf('/')) : '';
    const parts = dir ? dir.split('/') : [];
    for (const seg of importPath.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.') parts.push(seg);
    }
    let resolved = parts.join('/');
    const candidates = [
        resolved,
        resolved + '.js',
        resolved + '.ts',
        resolved + '.tsx',
        resolved + '/index.js',
        resolved + '/index.ts',
        resolved + '/index.tsx',
    ];
    for (const c of candidates) {
        if (nodesBySourceFile.has(c.replace(/\\/g, '/'))) return c.replace(/\\/g, '/');
    }
    for (const c of candidates) {
        const norm = c.replace(/\\/g, '/');
        for (const key of nodesBySourceFile.keys()) {
            if (key.endsWith('/' + norm) || key === norm) return key;
        }
    }
    return null;
}

const FILES_TO_SCAN = [
    { file: 'server.js', source_file: 'server.js' },
    { file: 'debug_api.js', source_file: 'debug_api.js' },
    { file: 'src/main.tsx', source_file: 'src/main.tsx' },
    { file: 'src/App.tsx', source_file: 'src/App.tsx' },
    { file: 'src/lib/apiBase.ts', source_file: 'src/lib/apiBase.ts' },
    { file: 'src/services/apiClient.ts', source_file: 'src/services/apiClient.ts' },
    { file: 'src/services/turnOrchestrator.ts', source_file: 'src/services/turnOrchestrator.ts' },
    { file: 'src/services/contextGatherer.ts', source_file: 'src/services/contextGatherer.ts' },
    { file: 'src/services/postTurnPipeline.ts', source_file: 'src/services/postTurnPipeline.ts' },
    { file: 'src/services/aiPlayerEngine.ts', source_file: 'src/services/aiPlayerEngine.ts' },
    { file: 'src/services/toolHandlers.ts', source_file: 'src/services/toolHandlers.ts' },
    { file: 'src/services/archiveManager.ts', source_file: 'src/services/archiveManager.ts' },
    { file: 'src/services/chatEngine.ts', source_file: 'src/services/chatEngine.ts' },
    { file: 'src/services/condenser.ts', source_file: 'src/services/condenser.ts' },
    { file: 'src/services/campaignInit.ts', source_file: 'src/services/campaignInit.ts' },
    { file: 'src/services/llmService.ts', source_file: 'src/services/llmService.ts' },
    { file: 'src/services/callLLM.ts', source_file: 'src/services/callLLM.ts' },
    { file: 'src/services/llmRequestQueue.ts', source_file: 'src/services/llmRequestQueue.ts' },
    { file: 'src/services/payloadBuilder.ts', source_file: 'src/services/payloadBuilder.ts' },
    { file: 'src/services/importanceRater.ts', source_file: 'src/services/importanceRater.ts' },
    { file: 'src/services/contextRecommender.ts', source_file: 'src/services/contextRecommender.ts' },
    { file: 'src/services/characterProfileParser.ts', source_file: 'src/services/characterProfileParser.ts' },
    { file: 'src/services/inventoryParser.ts', source_file: 'src/services/inventoryParser.ts' },
    { file: 'src/services/saveFileEngine.ts', source_file: 'src/services/saveFileEngine.ts' },
    { file: 'src/services/npcDetector.ts', source_file: 'src/services/npcDetector.ts' },
    { file: 'src/services/npcGeneration.ts', source_file: 'src/services/npcGeneration.ts' },
    { file: 'src/services/tagGeneration.ts', source_file: 'src/services/tagGeneration.ts' },
    { file: 'src/services/npcBehaviorDirective.ts', source_file: 'src/services/npcBehaviorDirective.ts' },
    { file: 'src/services/loreEngineSeeder.ts', source_file: 'src/services/loreEngineSeeder.ts' },
    { file: 'src/services/loreChunker.ts', source_file: 'src/services/loreChunker.ts' },
    { file: 'src/services/loreNPCParser.ts', source_file: 'src/services/loreNPCParser.ts' },
    { file: 'src/services/loreRetriever.ts', source_file: 'src/services/loreRetriever.ts' },
    { file: 'src/services/archiveMemory.ts', source_file: 'src/services/archiveMemory.ts' },
    { file: 'src/services/archiveChapterEngine.ts', source_file: 'src/services/archiveChapterEngine.ts' },
    { file: 'src/services/engineRolls.ts', source_file: 'src/services/engineRolls.ts' },
    { file: 'src/services/tokenizer.ts', source_file: 'src/services/tokenizer.ts' },
    { file: 'src/services/contextMinifier.ts', source_file: 'src/services/contextMinifier.ts' },
    { file: 'src/services/timelineResolver.ts', source_file: 'src/services/timelineResolver.ts' },
    { file: 'src/services/assetService.ts', source_file: 'src/services/assetService.ts' },
    { file: 'src/services/backgroundQueue.ts', source_file: 'src/services/backgroundQueue.ts' },
    { file: 'src/services/settingsCrypto.ts', source_file: 'src/services/settingsCrypto.ts' },
    { file: 'src/services/lib/payloadSanitizer.ts', source_file: 'src/services/lib/payloadSanitizer.ts' },
    { file: 'src/store/useAppStore.ts', source_file: 'src/store/useAppStore.ts' },
    { file: 'src/store/campaignStore.ts', source_file: 'src/store/campaignStore.ts' },
    { file: 'src/store/slices/settingsSlice.ts', source_file: 'src/store/slices/settingsSlice.ts' },
    { file: 'src/store/slices/campaignSlice.ts', source_file: 'src/store/slices/campaignSlice.ts' },
    { file: 'src/store/slices/chatSlice.ts', source_file: 'src/store/slices/chatSlice.ts' },
    { file: 'src/store/slices/uiSlice.ts', source_file: 'src/store/slices/uiSlice.ts' },
    { file: 'src/components/ChatArea.tsx', source_file: 'src/components/ChatArea.tsx' },
    { file: 'src/components/CampaignHub.tsx', source_file: 'src/components/CampaignHub.tsx' },
    { file: 'src/components/Header.tsx', source_file: 'src/components/Header.tsx' },
    { file: 'src/components/ContextDrawer.tsx', source_file: 'src/components/ContextDrawer.tsx' },
    { file: 'src/components/SettingsModal.tsx', source_file: 'src/components/SettingsModal.tsx' },
    { file: 'src/components/BackupModal.tsx', source_file: 'src/components/BackupModal.tsx' },
    { file: 'src/components/NPCLedgerModal.tsx', source_file: 'src/components/NPCLedgerModal.tsx' },
    { file: 'src/components/VaultUnlockModal.tsx', source_file: 'src/components/VaultUnlockModal.tsx' },
    { file: 'src/components/TokenGauge.tsx', source_file: 'src/components/TokenGauge.tsx' },
    { file: 'src/components/MessageBubble.tsx', source_file: 'src/components/MessageBubble.tsx' },
    { file: 'src/components/CondensedPanel.tsx', source_file: 'src/components/CondensedPanel.tsx' },
    { file: 'src/components/Toast.tsx', source_file: 'src/components/Toast.tsx' },
    { file: 'src/components/ErrorBoundary.tsx', source_file: 'src/components/ErrorBoundary.tsx' },
    { file: 'src/components/PayloadTraceView.tsx', source_file: 'src/components/PayloadTraceView.tsx' },
    { file: 'src/components/SceneNoteEditor.tsx', source_file: 'src/components/SceneNoteEditor.tsx' },
    { file: 'src/components/hooks/useCampaignForm.ts', source_file: 'src/components/hooks/useCampaignForm.ts' },
    { file: 'src/components/hooks/useMessageEditor.ts', source_file: 'src/components/hooks/useMessageEditor.ts' },
    { file: 'src/components/hooks/useChapterSealing.ts', source_file: 'src/components/hooks/useChapterSealing.ts' },
    { file: 'src/components/hooks/useCondenser.ts', source_file: 'src/components/hooks/useCondenser.ts' },
    { file: 'server/vault.js', source_file: 'server/vault.js' },
    { file: 'server/routes/vault.js', source_file: 'server/routes/vault.js' },
    { file: 'server/routes/settings.js', source_file: 'server/routes/settings.js' },
    { file: 'server/routes/campaigns.js', source_file: 'server/routes/campaigns.js' },
    { file: 'server/routes/archive.js', source_file: 'server/routes/archive.js' },
    { file: 'server/routes/chapters.js', source_file: 'server/routes/chapters.js' },
    { file: 'server/routes/timeline.js', source_file: 'server/routes/timeline.js' },
    { file: 'server/routes/facts.js', source_file: 'server/routes/facts.js' },
    { file: 'server/routes/backups.js', source_file: 'server/routes/backups.js' },
    { file: 'server/routes/assets.js', source_file: 'server/routes/assets.js' },
    { file: 'server/lib/fileStore.js', source_file: 'server/lib/fileStore.js' },
    { file: 'server/lib/embedder.js', source_file: 'server/lib/embedder.js' },
    { file: 'server/lib/vectorStore.js', source_file: 'server/lib/vectorStore.js' },
    { file: 'server/lib/nlp.js', source_file: 'server/lib/nlp.js' },
    { file: 'server/lib/entityResolution.js', source_file: 'server/lib/entityResolution.js' },
    { file: 'server/services/llmProxy.js', source_file: 'server/services/llmProxy.js' },
    { file: 'server/services/backup.js', source_file: 'server/services/backup.js' },
];

const IMPORT_REGEX = /(?:import\s+.*?from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

const existingEdges = new Set();
for (const e of graph.links) {
    existingEdges.add(`${e.source}->${e.target}`);
}

const newEdges = [];
const importMap = {};

for (const { file, source_file } of FILES_TO_SCAN) {
    const fullPath = resolve(ROOT, file);
    if (!existsSync(fullPath)) continue;
    const content = readFileSync(fullPath, 'utf8');
    const srcId = getFileNodeId(source_file);
    if (!srcId) continue;

    const imports = [];
    let m;
    IMPORT_REGEX.lastIndex = 0;
    while ((m = IMPORT_REGEX.exec(content)) !== null) {
        const importPath = m[1] || m[2] || m[3];
        if (importPath && importPath.startsWith('.')) {
            imports.push(importPath);
        }
    }

    for (const imp of imports) {
        const resolvedTarget = resolveImportPath(source_file, imp);
        if (!resolvedTarget) continue;
        const tgtId = getFileNodeId(resolvedTarget);
        if (!tgtId || tgtId === srcId) continue;

        const edgeKey = `${srcId}->${tgtId}`;
        if (!existingEdges.has(edgeKey)) {
            newEdges.push({
                relation: 'imports',
                confidence: 'CODE_PARSED',
                confidence_score: 1.0,
                source_file: source_file,
                source_location: null,
                weight: 1.0,
                _src: srcId,
                _tgt: tgtId,
                source: srcId,
                target: tgtId,
            });
            existingEdges.add(edgeKey);
        }
        if (!importMap[source_file]) importMap[source_file] = [];
        if (!importMap[source_file].includes(resolvedTarget)) {
            importMap[source_file].push(resolvedTarget);
        }
    }
}

for (const edge of newEdges) {
    graph.links.push(edge);
}

const nodeEdgeCount = new Map();
for (const n of graph.nodes) nodeEdgeCount.set(n.id, 0);
for (const e of graph.links) {
    nodeEdgeCount.set(e.source, (nodeEdgeCount.get(e.source) || 0) + 1);
    nodeEdgeCount.set(e.target, (nodeEdgeCount.get(e.target) || 0) + 1);
}

writeFileSync(GRAPH_JSON, JSON.stringify(graph, null, 2));

console.log(`\n=== Graph Import Patch Complete ===`);
console.log(`New "imports" edges added: ${newEdges.length}`);
console.log(`Total edges now: ${graph.links.length}`);
console.log(`Total nodes: ${graph.nodes.length}`);

console.log(`\n--- Import Edge Summary ---`);
for (const e of newEdges) {
    const srcNode = nodesById.get(e.source);
    const tgtNode = nodesById.get(e.target);
    console.log(`  ${srcNode?.label || e.source}  →  ${tgtNode?.label || e.target}  [imports]`);
}

writeFileSync(
    resolve(ROOT, 'graphify-out', 'import-map.json'),
    JSON.stringify(importMap, null, 2)
);
console.log(`\nImport map written to graphify-out/import-map.json`);

function regenerateHtml() {
    const htmlTemplate = readFileSync(GRAPH_HTML, 'utf8');

    const COMMUNITY_COLORS = [
        '#4E79A7','#F28E2B','#E15759','#76B7B2','#59A14F','#EDC948','#B07AA1','#FF9DA7','#9C755F','#BAB0AC',
        '#4E79A7','#F28E2B','#E15759','#76B7B2','#59A14F','#EDC948','#B07AA1','#FF9DA7','#9C755F','#BAB0AC',
        '#4E79A7','#F28E2B','#E15759','#76B7B2','#59A14F','#EDC948','#B07AA1','#FF9DA7','#9C755F','#BAB0AC',
        '#4E79A7','#F28E2B','#E15759','#76B7B2','#59A14F','#EDC948','#B07AA1','#FF9DA7','#9C755F','#BAB0AC',
        '#4E79A7','#F28E2B','#E15759','#76B7B2','#59A14F','#EDC948','#B07AA1','#FF9DA7','#9C755F','#BAB0AC',
    ];

    const communityNames = new Map();
    if (graph.graph && graph.graph.community_names) {
        for (const [k, v] of Object.entries(graph.graph.community_names)) {
            communityNames.set(parseInt(k), v);
        }
    }

    const edgeCounts = new Map();
    for (const e of graph.links) {
        edgeCounts.set(e.source, (edgeCounts.get(e.source) || 0) + 1);
        edgeCounts.set(e.target, (edgeCounts.get(e.target) || 0) + 1);
    }

    const RAW_NODES = graph.nodes.map(n => {
        const cid = n.community || 0;
        const color = COMMUNITY_COLORS[cid % COMMUNITY_COLORS.length];
        const deg = edgeCounts.get(n.id) || 0;
        const size = Math.max(11, Math.min(22, 11 + deg * 0.3));
        return {
            id: n.id,
            label: n.label,
            color: { background: color, border: color, highlight: { background: '#ffffff', border: color } },
            size,
            font: { size: 0, color: '#ffffff' },
            title: n.label,
            community: cid,
            community_name: n.community_name || communityNames.get(cid) || `Community ${cid}`,
            source_file: n.source_file,
            file_type: n.file_type,
            degree: deg,
        };
    });

    const RAW_EDGES = graph.links.map(e => ({
        from: e.source,
        to: e.target,
        label: '',
        title: `${e.relation} [${e.confidence || 'INFERRED'}]`,
        dashes: e.relation === 'imports',
        width: e.relation === 'imports' ? 1.5 : 2,
        color: e.relation === 'imports'
            ? { color: '#6366f1', opacity: 0.6 }
            : { opacity: 0.7 },
        confidence: e.confidence || 'INFERRED',
        _relation: e.relation,
    }));

    const communityCounts = new Map();
    for (const n of RAW_NODES) {
        const cid = n.community;
        if (!communityCounts.has(cid)) communityCounts.set(cid, { count: 0, name: n.community_name });
        communityCounts.get(cid).count++;
    }
    const LEGEND = [...communityCounts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([cid, { count, name }]) => ({
            cid, color: COMMUNITY_COLORS[cid % COMMUNITY_COLORS.length], label: name, count,
        }));

    const statsLine = `${RAW_NODES.length} nodes &middot; ${RAW_EDGES.length} edges &middot; ${LEGEND.length} communities`;

    let newHtml = htmlTemplate;
    newHtml = newHtml.replace(
        /const RAW_NODES = \[.*?\];/s,
        `const RAW_NODES = ${JSON.stringify(RAW_NODES)};`
    );
    newHtml = newHtml.replace(
        /const RAW_EDGES = \[.*?\];/s,
        `const RAW_EDGES = ${JSON.stringify(RAW_EDGES)};`
    );
    newHtml = newHtml.replace(
        /const LEGEND = \[.*?\];/s,
        `const LEGEND = ${JSON.stringify(LEGEND)};`
    );
    newHtml = newHtml.replace(
        /\d+ nodes &middot; \d+ edges &middot; \d+ communities/,
        statsLine
    );

    const hyperedgesJson = JSON.stringify(
        (graph.graph && graph.graph.hyperedges) ? graph.graph.hyperedges : []
    );
    newHtml = newHtml.replace(
        /const hyperedges = \[.*?\];/s,
        `const hyperedges = ${hyperedgesJson};`
    );

    writeFileSync(GRAPH_HTML, newHtml);
    console.log(`\ngraph.html regenerated with updated nodes/edges.`);
}

regenerateHtml();
console.log(`\nDone.`);
