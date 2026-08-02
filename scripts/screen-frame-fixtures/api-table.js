// P5-18 §5 — table.read and table.write round-trip through the host.
export default async function () {
    const before = await globalThis.__screenApi.request({ capability: 'table.read', table: 'tree' });
    const write = await globalThis.__screenApi.request({
        capability: 'table.write',
        table: 'tree',
        value: [{ id: 'node-1', label: 'edited' }],
    });
    const after = await globalThis.__screenApi.request({ capability: 'table.read', table: 'tree' });
    parent.postMessage({ __screenFixture: 'api-table.js', before, write, after }, '*');
}
