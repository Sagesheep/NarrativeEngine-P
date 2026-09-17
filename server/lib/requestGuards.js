import net from 'net';

/**
 * Request guards — keep the local API reachable only by the app itself.
 *
 * The server has no authentication: it exists to serve the app running on the
 * same machine. Two browser tricks let an arbitrary web page reach it anyway,
 * and the CORS allowlist stops neither:
 *
 *  1. Cross-site requests. A page on any site can auto-submit a form at
 *     `http://127.0.0.1:3001/api/vault/reset` (CORS only stops the page from
 *     READING the reply, the request still lands), and it can wrap the API in
 *     a sandboxed <iframe>, whose origin the browser reports as the string
 *     "null". Browsers stamp every such request with
 *     `Sec-Fetch-Site: cross-site`, so the API refuses those unless the
 *     Origin is one the operator explicitly allowlisted.
 *
 *  2. DNS rebinding. A page at `http://attacker.example:3001` whose DNS record
 *     flips to 127.0.0.1 after it loads gets SAME-origin access to this
 *     server, so CORS and Sec-Fetch-Site both wave it through. The one thing
 *     that still gives it away is the Host header, which names the attacker's
 *     domain. The API only answers requests addressed to a loopback name, the
 *     address it is bound to, or a host the operator allowlisted.
 *
 * Non-browser clients (curl, supertest, Playwright's request fixture) send no
 * Sec-Fetch-Site header and pass: a local process can already do anything it
 * likes to the data directory, so the guards target browsers only.
 */

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '[::]', '']);

/** `example.com:3001` → `example.com`; `[::1]:3001` → `[::1]`. */
export function hostnameOf(hostHeader) {
    if (typeof hostHeader !== 'string') return '';
    const host = hostHeader.trim().toLowerCase();
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        return end === -1 ? '' : host.slice(0, end + 1);
    }
    const colon = host.indexOf(':');
    return colon === -1 ? host : host.slice(0, colon);
}

/**
 * @param {string|undefined} hostHeader the raw Host header
 * @param {{ bindHost?: string, allowedHosts?: string[] }} opts
 *   bindHost — the address the server listens on (`HOST` env, default loopback).
 *   allowedHosts — extra hostnames the operator trusts (`ALLOWED_HOSTS` env).
 */
export function isAllowedHost(hostHeader, { bindHost = '127.0.0.1', allowedHosts = [] } = {}) {
    const hostname = hostnameOf(hostHeader);
    if (!hostname) return false;
    if (LOOPBACK_HOSTNAMES.has(hostname)) return true;

    const bind = String(bindHost ?? '').trim().toLowerCase();
    if (bind && (hostname === bind || hostname === `[${bind}]`)) return true;

    if (allowedHosts.some((h) => String(h).trim().toLowerCase() === hostname)) return true;

    // Bound to every interface: a LAN client addresses the box by IP. An IP
    // literal cannot be rebound (rebinding needs a DNS name), so it is safe.
    if (WILDCARD_BINDS.has(bind)) {
        const bare = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
        return net.isIP(bare) !== 0;
    }
    return false;
}

export function createHostGuard(opts = {}) {
    return function hostGuard(req, res, next) {
        if (isAllowedHost(req.headers.host, opts)) return next();
        res.status(403).json({ error: 'Request addressed to an unexpected host' });
    };
}

/**
 * True unless the browser says the request is cross-site AND its Origin is
 * not allowlisted. `same-origin`, `same-site`, `none` (typed URL, bookmark)
 * and an absent header (non-browser client) all pass.
 */
export function isAllowedFetchSite(headers, allowedOrigins) {
    if (headers['sec-fetch-site'] !== 'cross-site') return true;
    const origin = headers.origin;
    return typeof origin === 'string' && allowedOrigins.has(origin);
}

/** @param {Set<string>} allowedOrigins the same set the cors middleware reflects */
export function createFetchSiteGuard(allowedOrigins) {
    return function fetchSiteGuard(req, res, next) {
        if (isAllowedFetchSite(req.headers, allowedOrigins)) return next();
        res.status(403).json({ error: 'Cross-site requests to the API are not allowed' });
    };
}
