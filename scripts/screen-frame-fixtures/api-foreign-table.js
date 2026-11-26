// P5-18 §5 — a screen cannot name another mod's table or a host field.
export default async function () {
    await globalThis.__screenApi.request({ capability: 'table.read', table: 'other-mod.secret' });
    parent.postMessage({ __screenFixture: 'api-foreign-table.js', unexpected: true }, '*');
}
