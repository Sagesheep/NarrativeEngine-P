// Request guards — the two browser-only doors into an unauthenticated local API.
//
// Pins:
//   • Host header naming a non-loopback DNS name → 403 (DNS rebinding)
//   • loopback names, the bound address, ALLOWED_HOSTS and (on a wildcard
//     bind) IP literals → pass
//   • `Sec-Fetch-Site: cross-site` without an allowlisted Origin → 403 on
//     /api, whether it is a form POST (no Origin) or a sandboxed iframe
//     (Origin "null")
//   • same-origin / same-site / none / header absent → pass
//   • an allowlisted Origin passes even though it is cross-site
//   • the guard is scoped to /api: static assets are not affected
import { describe, it, expect } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import {
    hostnameOf, isAllowedHost, isAllowedFetchSite,
    createHostGuard, createFetchSiteGuard,
} from '../lib/requestGuards.js';

function buildApp({ bindHost, allowedHosts, allowedOrigins } = {}) {
    const app = express();
    app.use(createHostGuard({ bindHost, allowedHosts }));
    app.use('/api', createFetchSiteGuard(allowedOrigins ?? new Set(['http://localhost:5173'])));
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));
    app.post('/api/ping', (_req, res) => res.json({ ok: true }));
    app.get('/assets/x.png', (_req, res) => res.json({ asset: true }));
    return supertest(app);
}

describe('hostnameOf', () => {
    it('strips the port and lowercases', () => {
        expect(hostnameOf('LocalHost:3001')).toBe('localhost');
        expect(hostnameOf('127.0.0.1:3001')).toBe('127.0.0.1');
        expect(hostnameOf('example.com')).toBe('example.com');
    });
    it('keeps bracketed IPv6 literals intact', () => {
        expect(hostnameOf('[::1]:3001')).toBe('[::1]');
        expect(hostnameOf('[::1]')).toBe('[::1]');
    });
    it('is empty for a missing or malformed header', () => {
        expect(hostnameOf(undefined)).toBe('');
        expect(hostnameOf('[::1')).toBe('');
    });
});

describe('isAllowedHost', () => {
    it('accepts loopback names regardless of port', () => {
        expect(isAllowedHost('localhost:3001')).toBe(true);
        expect(isAllowedHost('127.0.0.1:41234')).toBe(true);
        expect(isAllowedHost('[::1]:3001')).toBe(true);
    });
    it('rejects any other DNS name on the default loopback bind', () => {
        expect(isAllowedHost('attacker.example:3001')).toBe(false);
        expect(isAllowedHost('192.168.1.20:3001')).toBe(false);
        expect(isAllowedHost(undefined)).toBe(false);
    });
    it('accepts the bound address itself', () => {
        expect(isAllowedHost('192.168.1.20:3001', { bindHost: '192.168.1.20' })).toBe(true);
        expect(isAllowedHost('192.168.1.21:3001', { bindHost: '192.168.1.20' })).toBe(false);
    });
    it('accepts operator-allowlisted hosts', () => {
        expect(isAllowedHost('dm-box.lan:3001', { allowedHosts: ['DM-Box.lan'] })).toBe(true);
    });
    it('on a wildcard bind accepts IP literals but still rejects DNS names', () => {
        expect(isAllowedHost('192.168.1.20:3001', { bindHost: '0.0.0.0' })).toBe(true);
        expect(isAllowedHost('[fe80::1]:3001', { bindHost: '::' })).toBe(true);
        expect(isAllowedHost('attacker.example:3001', { bindHost: '0.0.0.0' })).toBe(false);
    });
});

describe('isAllowedFetchSite', () => {
    const allowed = new Set(['http://localhost:5173']);
    it('passes when the header is absent (non-browser client)', () => {
        expect(isAllowedFetchSite({}, allowed)).toBe(true);
    });
    it('passes same-origin, same-site and none', () => {
        for (const site of ['same-origin', 'same-site', 'none']) {
            expect(isAllowedFetchSite({ 'sec-fetch-site': site }, allowed)).toBe(true);
        }
    });
    it('rejects cross-site without an allowlisted origin', () => {
        expect(isAllowedFetchSite({ 'sec-fetch-site': 'cross-site' }, allowed)).toBe(false);
        expect(isAllowedFetchSite({ 'sec-fetch-site': 'cross-site', origin: 'null' }, allowed)).toBe(false);
        expect(isAllowedFetchSite({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }, allowed)).toBe(false);
    });
    it('passes cross-site from an allowlisted origin', () => {
        expect(isAllowedFetchSite({ 'sec-fetch-site': 'cross-site', origin: 'http://localhost:5173' }, allowed)).toBe(true);
        expect(isAllowedFetchSite({ 'sec-fetch-site': 'cross-site', origin: 'null' }, new Set(['null']))).toBe(true);
    });
});

describe('host guard middleware', () => {
    it('rejects a rebinding Host with 403 before any route runs', async () => {
        const res = await buildApp().get('/api/ping').set('Host', 'attacker.example:3001');
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/unexpected host/i);
    });
    it('lets supertest through (loopback host, no Sec-Fetch-Site)', async () => {
        const res = await buildApp().get('/api/ping');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });
    it('lets the Vite proxy through (Host rewritten to localhost:3001)', async () => {
        const res = await buildApp().post('/api/ping').set('Host', 'localhost:3001');
        expect(res.status).toBe(200);
    });
});

describe('fetch-site guard middleware', () => {
    it('rejects a cross-site form POST (no Origin)', async () => {
        const res = await buildApp().post('/api/ping').set('Sec-Fetch-Site', 'cross-site');
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/cross-site/i);
    });
    it('rejects a sandboxed-iframe read (Origin "null")', async () => {
        const res = await buildApp().get('/api/ping')
            .set('Sec-Fetch-Site', 'cross-site').set('Origin', 'null');
        expect(res.status).toBe(403);
    });
    it('rejects an <img>-triggered GET from another site', async () => {
        const res = await buildApp().get('/api/ping')
            .set('Sec-Fetch-Site', 'cross-site').set('Sec-Fetch-Dest', 'image');
        expect(res.status).toBe(403);
    });
    it('passes the app itself (same-origin through the Vite proxy)', async () => {
        const res = await buildApp().post('/api/ping')
            .set('Host', 'localhost:3001').set('Sec-Fetch-Site', 'same-origin')
            .set('Origin', 'http://127.0.0.1:5173');
        expect(res.status).toBe(200);
    });
    it('passes an allowlisted cross-site origin (ALLOWED_ORIGINS / Electron null)', async () => {
        const electron = buildApp({ allowedOrigins: new Set(['null']) });
        const res = await electron.get('/api/ping')
            .set('Sec-Fetch-Site', 'cross-site').set('Origin', 'null');
        expect(res.status).toBe(200);
    });
    it('does not apply outside /api', async () => {
        const res = await buildApp().get('/assets/x.png').set('Sec-Fetch-Site', 'cross-site');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ asset: true });
    });
});
