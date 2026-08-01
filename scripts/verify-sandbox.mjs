import { createServer } from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtureRoot = join(projectRoot, 'src', 'services', 'mods', 'sandbox', '__tests__', 'fixtures');
const fixtureNames = [
  'ok.js',
  'throws.js',
  'infinite.js',
  'memoryhog.js',
  'escape-net.js',
  'escape-store.js',
  'heavy-payload.js',
];
const deadlineMs = 250;
const cycleCount = 200;

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolvePromise(server.address().port);
    });
  });
}

function waitForJson(url, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const poll = async () => {
      if (Date.now() >= deadline) {
        reject(new Error(`Timed out waiting for ${url}`));
        return;
      }
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), 1000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        const value = await response.json();
        const match = predicate(value);
        if (match) {
          resolvePromise(match);
          return;
        }
      } catch {}
      finally {
        clearTimeout(abortTimer);
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

function connectCdp(webSocketUrl) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 1;
    let opened = false;

    const connection = {
      send(method, params = {}) {
        const id = nextId++;
        return new Promise((resolveMessage, rejectMessage) => {
          pending.set(id, { resolveMessage, rejectMessage });
          socket.send(JSON.stringify({ id, method, params }));
        });
      },
      close() {
        for (const { rejectMessage } of pending.values()) rejectMessage(new Error('CDP connection closed'));
        pending.clear();
        socket.close();
      },
    };

    socket.addEventListener('open', () => {
      opened = true;
      resolvePromise(connection);
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id == null) return;
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.rejectMessage(new Error(JSON.stringify(message.error)));
      else waiter.resolveMessage(message.result);
    });
    socket.addEventListener('error', () => {
      if (!opened) rejectPromise(new Error('CDP WebSocket error'));
    });
  });
}

function workerPrelude(source) {
  const modBody = source.replace(/^\s*export\s+default\s+/, 'globalThis.__sandboxMod = ');
  return `
const __deny = (name) => { try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); } catch {} };
for (const __name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts', 'Worker', 'SharedArrayBuffer', 'Atomics', 'indexedDB', 'caches']) __deny(__name);
try { Object.defineProperty(globalThis.navigator, 'sendBeacon', { value: undefined, writable: false, configurable: false }); } catch {}
const __freeze = (value, seen = new WeakSet()) => {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value); Object.freeze(value);
    for (const child of Object.values(value)) __freeze(child, seen);
  }
  return value;
};
${modBody}
self.onmessage = async (event) => {
  try {
    const context = __freeze(event.data.snapshot);
    const value = await globalThis.__sandboxMod(context);
    self.postMessage({ type: 'fulfilled', value });
  } catch (error) {
    self.postMessage({ type: 'rejected', error: String(error), stack: error && error.stack ? String(error.stack) : '' });
  }
};
`;
}

async function terminateProcessTree(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolvePromise) => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      killer.kill();
      resolvePromise();
    }, 5000);
    const finish = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    killer.once('exit', finish);
    killer.once('error', finish);
  });
}

async function removeProfile(profilePath) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await rm(profilePath, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  console.error(`PROFILE_CLEANUP ${lastError?.message ?? String(lastError)}`);
}
async function startBrowserHost() {
  const pageHtml = `<!doctype html><meta charset="utf-8"><script>
const __fixtures = ${JSON.stringify(fixtureNames)};
const __metrics = { createdWorkers: 0, activeWorkers: 0, maxActiveWorkers: 0 };
const __deadlineMs = ${deadlineMs};
const __workerPrelude = ${JSON.stringify(workerPrelude.toString())};

function __sourceFor(source) {
  return (${workerPrelude.toString()})(source);
}

function __runWorker(source, snapshot, timeoutMs, respondToRpc) {
  const started = performance.now();
  const scriptUrl = URL.createObjectURL(new Blob([__sourceFor(source)], { type: 'text/javascript' }));
  const worker = new Worker(scriptUrl);
  URL.revokeObjectURL(scriptUrl);
  __metrics.createdWorkers += 1;
  __metrics.activeWorkers += 1;
  __metrics.maxActiveWorkers = Math.max(__metrics.maxActiveWorkers, __metrics.activeWorkers);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      __metrics.activeWorkers -= 1;
      resolve({ ...result, elapsedMs: performance.now() - started });
    };
    timer = setTimeout(() => finish({ status: 'deadline', error: 'host-side deadline exceeded' }), Math.max(1, timeoutMs));
    worker.onmessage = (event) => {
      if (event.data?.type === 'rpc') {
        if (respondToRpc) respondToRpc(worker, event.data);
        return;
      }
      if (event.data?.type === 'fulfilled') finish({ status: 'fulfilled', value: event.data.value });
      else finish({ status: 'rejected', error: event.data?.error ?? 'worker rejected without an error' });
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish({ status: 'worker-error', error: event.message || 'browser Worker error' });
    };
    worker.postMessage({ snapshot });
  });
}

window.__verifySandbox = async ({ sources }) => {
  const batch = {};
  for (const name of __fixtures) {
    batch[name] = await __runWorker(sources[name], { data: { value: 42, context: { scene: 'verify-scene' } }, config: { mode: 'verify' } }, __deadlineMs, null);
  }

  const nestedWorkerSource = "export default async function () { try { new Worker('data:text/javascript,postMessage(1)'); return { nested: 'created' }; } catch (error) { return { nested: 'blocked', error: String(error) }; } }";
  const nestedWorker = await __runWorker(nestedWorkerSource, {}, __deadlineMs, null);

  const messageChannelSource = "export default async function () { self.postMessage({ type: 'rpc', method: 'table:read', requestId: 'verify-message-channel' }); return await new Promise(() => {}); }";
  const messageChannel = await __runWorker(messageChannelSource, {}, __deadlineMs, null);
const credentialProbeSource = "export default async function (ctx) { const globalNames = Object.getOwnPropertyNames(globalThis); const credentialGlobals = globalNames.filter((name) => /^(?:apiKey|endpoint|authorization)$/i.test(name)); const serialized = JSON.stringify(ctx); return { credentialGlobals, credentialText: /apiKey|endpoint|authorization/i.test(serialized) }; }";
  const credentialProbe = await __runWorker(credentialProbeSource, { data: { value: 42 }, config: {}, modelRoles: ['utility'] }, __deadlineMs, null);

  const cyclesStarted = performance.now();
  const cycleOutcomes = [];
  for (let index = 0; index < ${cycleCount}; index += 1) {
    cycleOutcomes.push(await __runWorker(sources['ok.js'], { data: { cycle: index, context: { scene: 'cycle-scene' } }, config: {} }, __deadlineMs, null));
  }
  return {
    batch,
    nestedWorker,
    messageChannel,
    credentialProbe,
    cycles: {
      count: cycleOutcomes.length,
      wallClockMs: performance.now() - cyclesStarted,
      createdWorkers: __metrics.createdWorkers,
      maxActiveWorkers: __metrics.maxActiveWorkers,
      activeWorkersAfter: __metrics.activeWorkers,
      allFulfilled: cycleOutcomes.every((result) => result.status === 'fulfilled'),
    },
  };
};
</script>`;

  const pageServer = createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; worker-src blob:; connect-src 'none';",
    });
    response.end(pageHtml);
  });
  const pagePort = await listen(pageServer);
  const debugPortServer = createServer();
  const debugPort = await listen(debugPortServer);
  await new Promise((resolvePromise) => debugPortServer.close(resolvePromise));

  const edgePath = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const profilePath = join(process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp', `sandbox-verify-edge-${process.pid}`);
  const edge = spawn(edgePath, [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-extensions',
    '--no-first-run',
    '--disable-background-networking',
    '--remote-allow-origins=*',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profilePath}`,
    `http://127.0.0.1:${pagePort}/`,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  try {
    const target = await waitForJson(
      `http://127.0.0.1:${debugPort}/json/list`,
      (value) => value.find((candidate) => candidate.type === 'page' && candidate.url === `http://127.0.0.1:${pagePort}/` && candidate.webSocketDebuggerUrl),
    );
    const cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    return {
      async run(sources) {
        const expression = `window.__verifySandbox({ sources: ${JSON.stringify(sources)} })`;
        const availability = await cdp.send('Runtime.evaluate', { expression: "({ href: location.href, title: document.title, verify: typeof window.__verifySandbox, html: document.documentElement.outerHTML.slice(0, 300) })", returnByValue: true });
        if (availability?.result?.value?.verify !== 'function') throw new Error(`sandbox page unavailable: ${JSON.stringify(availability?.result?.value)}`);
        const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        return result.result.value;
      },
      async close() {
        cdp.close();
        try {
          await terminateProcessTree(edge);
        } finally {
          await removeProfile(profilePath);
          await new Promise((resolvePromise) => pageServer.close(resolvePromise));
        }
      },
    };
  } catch (error) {
    try {
      await terminateProcessTree(edge);
    } finally {
      await removeProfile(profilePath);
      await new Promise((resolvePromise) => pageServer.close(resolvePromise));
    }
    throw error;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const sources = Object.fromEntries(await Promise.all(fixtureNames.map(async (name) => [
    name,
    await readFile(join(fixtureRoot, name), 'utf8'),
  ])));
  const browserHost = await startBrowserHost();
  let result;
  try {
    result = await browserHost.run(sources);
  } finally {
    await browserHost.close();
  }

  assert(result.batch['ok.js']?.status === 'fulfilled', `ok fixture failed: ${JSON.stringify(result.batch['ok.js'])}`);
  assert(result.batch['throws.js']?.status === 'rejected', `throws fixture escaped: ${JSON.stringify(result.batch['throws.js'])}`);
  assert(result.batch['infinite.js']?.status === 'deadline', `infinite fixture escaped: ${JSON.stringify(result.batch['infinite.js'])}`);
  assert(['deadline', 'rejected'].includes(result.batch['memoryhog.js']?.status), `memoryhog fixture escaped: ${JSON.stringify(result.batch['memoryhog.js'])}`);
  assert(result.batch['escape-net.js']?.status === 'fulfilled' && result.batch['escape-net.js']?.value?.network === 'fetch-undefined', 'network fixture failed: ' + JSON.stringify(result.batch['escape-net.js']));
  assert(result.batch['escape-store.js']?.status === 'fulfilled' && result.batch['escape-store.js']?.value?.visible?.length === 0 && result.batch['escape-store.js']?.value?.matchingGlobals?.length === 0, 'store fixture failed: ' + JSON.stringify(result.batch['escape-store.js']));
  assert(result.batch['heavy-payload.js']?.status === 'fulfilled', `payload fixture failed: ${JSON.stringify(result.batch['heavy-payload.js'])}`);
  assert(result.nestedWorker.value?.nested === 'blocked', `nested Worker was not blocked: ${JSON.stringify(result.nestedWorker)}`);
  assert(result.messageChannel.status === 'deadline' && result.messageChannel.elapsedMs <= deadlineMs + 50, `message-channel block escaped: ${JSON.stringify(result.messageChannel)}`);
  assert(result.credentialProbe.status === 'fulfilled' && result.credentialProbe.value?.credentialGlobals?.length === 0 && result.credentialProbe.value?.credentialText === false, 'credential-bearing worker global escaped: ' + JSON.stringify(result.credentialProbe));
  assert(result.cycles.count === cycleCount, `cycle count mismatch: ${JSON.stringify(result.cycles)}`);
  assert(result.cycles.allFulfilled, `cycle failure: ${JSON.stringify(result.cycles)}`);
  assert(result.cycles.createdWorkers === cycleCount + fixtureNames.length + 3, `worker count mismatch: ${JSON.stringify(result.cycles)}`);
  assert(result.cycles.maxActiveWorkers === 1, `workers overlapped: ${JSON.stringify(result.cycles)}`);
  assert(result.cycles.activeWorkersAfter === 0, `workers leaked: ${JSON.stringify(result.cycles)}`);

  console.log('SANDBOX BROWSER VERIFICATION');
  console.log(`browser=${process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'}`);
  console.log(`deadlineMs=${deadlineMs}`);
  console.log(`fixtures=${JSON.stringify(Object.fromEntries(fixtureNames.map((name) => [name, result.batch[name].status])))}`);
  console.log(`nestedWorker=${JSON.stringify(result.nestedWorker)}`);
  console.log(`messageChannel=${JSON.stringify(result.messageChannel)}`);
  console.log('credentialProbe=' + JSON.stringify(result.credentialProbe));
  console.log(`cycles=${JSON.stringify(result.cycles)}`);
  console.log('PASS');
}

main().catch((error) => {
  console.error(error?.stack ?? String(error));
  process.exitCode = 1;
});
