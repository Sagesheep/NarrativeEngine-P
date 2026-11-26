import { enemyData, onActivate } from '../mods/enemies/index.js';

const iterations = Number(process.argv[2] || 5000);
const instanceId = 'enemy-reactivity-benchmark';
const tableValues = {
    compendium: [],
    instances: [],
    encounters: [],
    resolutions: [],
    config: {
        initiativeMode: 'manual',
        barrierMode: 'absorb-first',
        promptContextEnabled: true,
        enemyDiscoveryEnabled: false,
        enabled: true,
        initiativeModifierStat: '',
        autoDefeatAtZeroHp: true,
        weaknessMultiplier: 2,
        resistanceMultiplier: 0.5,
        actionsEnabled: false,
        defaultActionsPerTurn: 1,
        cooldownsEnabled: false,
        resourcesEnabled: false,
    },
};
const listeners = new Map();
const clone = value => JSON.parse(JSON.stringify(value));
const ctx = {
    data: { campaignId: 'enemy-reactivity-benchmark' },
    log() {},
    table: {
        async read(name) {
            return clone(tableValues[name]);
        },
        async write(name, value) {
            tableValues[name] = clone(value);
            for (const listener of listeners.get(name) || []) listener(clone(value));
        },
        subscribe(name, listener) {
            const bucket = listeners.get(name) || new Set();
            bucket.add(listener);
            listeners.set(name, bucket);
            return () => bucket.delete(listener);
        },
    },
    write: { requestBackup() {} },
    events: { on: () => () => {} },
    mounts: {
        window: () => ({ open() {}, close() {}, update() {} }),
        header: () => ({ update() {}, close() {} }),
    },
};

const makeInstance = hp => ({
    id: instanceId,
    templateId: 'enemy-reactivity-template',
    templateSnapshot: { id: 'enemy-reactivity-template', name: 'Benchmark Enemy', stats: [] },
    displayName: 'Benchmark Enemy #1',
    currentHp: hp,
    maxHp: hp,
    currentBarrier: 0,
    maxBarrier: 0,
    conditions: [],
    temporaryModifiers: [],
    defeated: false,
    initiative: null,
    actionsRemaining: 1,
    actionsPerTurn: 1,
    cooldowns: [],
    resources: [],
});

async function reset() {
    const instances = [makeInstance(iterations + 1)];
    tableValues.instances = instances;
    await enemyData.setEnemyInstances(ctx, instances);
}

async function damageLoop() {
    for (let index = 0; index < iterations; index += 1) {
        await enemyData.applyEnemyDamage(ctx, instanceId, 1, '', true);
    }
}

await onActivate(ctx);

await reset();
let subscriptionNotifications = 0;
let subscriptionChecksum = 0;
const stop = ctx.table.subscribe('instances', instances => {
    subscriptionNotifications += 1;
    subscriptionChecksum += instances[0]?.currentHp || 0;
});
const subscriptionStart = performance.now();
await damageLoop();
const subscriptionMs = performance.now() - subscriptionStart;
stop();

await reset();
let directReads = 0;
let directChecksum = 0;
const directStart = performance.now();
for (let index = 0; index < iterations; index += 1) {
    await enemyData.applyEnemyDamage(ctx, instanceId, 1, '', true);
    directReads += 1;
    directChecksum += tableValues.instances[0]?.currentHp || 0;
}
const directMs = performance.now() - directStart;

console.log(JSON.stringify({
    iterations,
    subscription: {
        ms: Number(subscriptionMs.toFixed(3)),
        notifications: subscriptionNotifications,
        checksum: subscriptionChecksum,
    },
    directStoreRead: {
        ms: Number(directMs.toFixed(3)),
        reads: directReads,
        checksum: directChecksum,
    },
    polling: false,
}));
