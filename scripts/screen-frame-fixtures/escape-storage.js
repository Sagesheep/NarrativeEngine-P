// escape-storage.js — localStorage, cookies, and IndexedDB MUST be unreachable.
//
// R1: a sandboxed opaque-origin frame has no storage. `localStorage`
// throws (the origin is opaque), `document.cookie` is empty (no
// same-origin cookies), and `indexedDB` is null or throws (no
// same-origin database). `allow-same-origin` would give the frame our
// origin's storage — the same localStorage the app uses, the same
// IndexedDB the settings slice uses.
//
// This fixture TRIES each storage API and reports what it got back. The
// harness asserts each is unreachable. If R1 were violated, `localStorage`
// would return a real Storage object and the suite would go red.
export default async function () {
    const probe = {
        __screenFixture: 'escape-storage.js',
        localStorage: 'unknown',
        localStorageError: null,
        cookieReadable: false,
        cookieValue: null,
        indexedDB: 'unknown',
        indexedDBError: null,
        sessionStorage: 'unknown',
        sessionStorageError: null,
    };
    try {
        const store = window.localStorage;
        if (store) {
            // If we got here, R1 was violated. Try to read a key to prove
            // the storage is the PARENT's, not a fresh empty one.
            const keys = [];
            for (let i = 0; i < store.length; i += 1) {
                keys.push(store.key(i));
            }
            probe.localStorage = 'reached';
            probe.cookieValue = keys.join(',');
        } else {
            probe.localStorage = 'null';
        }
    } catch (err) {
        probe.localStorage = 'blocked';
        probe.localStorageError = String(err);
    }
    try {
        // document.cookie on an opaque origin throws SecurityError. If
        // it does NOT throw, the frame has access to same-origin cookies.
        const c = document.cookie;
        probe.cookieReadable = typeof c === 'string';
        probe.cookieValue = c;
    } catch (err) {
        probe.cookieReadable = false;
        probe.cookieValue = String(err);
    }
    try {
        const idb = window.indexedDB;
        if (idb) {
            // indexedDB is a standard global and is present even on an
            // opaque origin. The barrier is at the OPEN level: opening a
            // database on an opaque origin fails. Try to open one — if
            // it SUCCEEDS, R1 was violated.
            probe.indexedDB = await new Promise((resolve) => {
                try {
                    var req = idb.open('screen-probe-' + Date.now(), 1);
                    req.onsuccess = function () { resolve('opened'); };
                    req.onerror = function () { resolve('blocked'); };
                } catch (err) {
                    resolve('blocked');
                }
                // Timeout: if neither fires, treat as blocked.
                setTimeout(() => resolve('blocked'), 500);
            });
        } else {
            probe.indexedDB = 'null';
        }
    } catch (err) {
        probe.indexedDB = 'blocked';
        probe.indexedDBError = String(err);
    }
    try {
        const ss = window.sessionStorage;
        if (ss) {
            probe.sessionStorage = 'reached';
        } else {
            probe.sessionStorage = 'null';
        }
    } catch (err) {
        probe.sessionStorage = 'blocked';
        probe.sessionStorageError = String(err);
    }
    parent.postMessage(probe, '*');
}