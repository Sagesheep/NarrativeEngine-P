// P5-18 R1 — the harness mounts a second frame that sends a forged request
// with the target nonce. The target must accept only its own contentWindow.
export default async function () {
    await new Promise((resolve) => setTimeout(resolve, 350));
    const readAfterAttack = await globalThis.__screenApi.request({ capability: 'table.read', table: 'tree' });
    parent.postMessage({ __screenFixture: 'api-forgery.js', readAfterAttack }, '*');
}
