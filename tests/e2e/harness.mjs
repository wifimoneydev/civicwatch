// Shared helpers for the headless-Chrome end-to-end tests: static server,
// Chrome launcher, a tiny DevTools-protocol client and a fake Supabase.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const www = path.join(root, 'www');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(www, 'js/config.js'), 'utf8'), sandbox);
export const SUPABASE_URL = sandbox.window.CIVICWATCH_CONFIG.SUPABASE_URL.replace(/\/+$/, '');
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];
export const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

export function createReporter() {
    let failures = 0;
    return {
        check(name, ok, detail) {
            if (ok) console.log(`  PASS  ${name}`);
            else { failures += 1; console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`); }
        },
        fail(message) { failures += 1; console.log(`  FAIL  ${message}`); },
        get failures() { return failures; },
    };
}

// ------------------------------------------------------------------ static server

// opts.fakeCordova: serve a stand-in cordova.js that behaves like Cordova on
// Android at start-up (defines window.cordova, fires deviceready later), so
// the app's deviceready start-up path is exercised.
const FAKE_CORDOVA = `window.cordova = { platformId: 'android', version: 'e2e-fake' };
document.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () { document.dispatchEvent(new Event('deviceready')); }, 150);
});`;

export function serve(opts = {}) {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain' };
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
        if (rel === 'cordova.js' && opts.fakeCordova) {
            res.writeHead(200, { 'content-type': 'text/javascript' });
            res.end(FAKE_CORDOVA);
            return;
        }
        const file = path.join(www, rel);
        if (!file.startsWith(www) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404); res.end(); return; // cordova.js is absent in a browser, as intended
        }
        res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ------------------------------------------------------------------ Chrome + CDP

export async function launchChrome() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-e2e-'));
    const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('Chrome did not start')), 15000);
        proc.stderr.on('data', (d) => {
            buf += d;
            const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
            if (m) { clearTimeout(timer); resolve(m[1]); }
        });
    });
    return { proc, profile, wsUrl };
}

export function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    let nextId = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
        } else listeners.forEach((fn) => fn(msg));
    };
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    return new Promise((resolve) => { ws.onopen = () => resolve({ ws, send, on: (fn) => listeners.push(fn) }); });
}

// Each phase gets its own browser context (separate localStorage/cookies).
export async function openPage(cdp) {
    const { browserContextId } = await cdp.send('Target.createBrowserContext');
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    await send('Page.enable');
    await send('Runtime.enable');
    const page = {
        sessionId,
        browserContextId,
        send,
        async eval(expression) {
            const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
            return r.result.value;
        },
        async waitFor(expression, label, timeout = 8000) {
            const start = Date.now();
            for (;;) {
                try { if (await page.eval(expression)) return true; } catch { /* page navigating */ }
                if (Date.now() - start > timeout) return false;
                await new Promise((r) => setTimeout(r, 50));
            }
        },
        // Full page load every time (a hash-only change would not restart the
        // app), so this genuinely simulates closing and reopening it.
        async goto(url) {
            await send('Page.navigate', { url: 'about:blank' });
            await page.waitFor("location.href === 'about:blank'", 'blank');
            await send('Page.navigate', { url });
            return page.waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`, 'load');
        },
        // Counts full page loads, to prove a restart really happened.
        loads: () => page.eval('performance.getEntriesByType("navigation").length && (window.__cwLoadId || (window.__cwLoadId = Math.random()))'),
        fill: (id, value) => page.eval(`(() => { const el = document.getElementById(${JSON.stringify(id)});
            el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`),
        click: (id) => page.eval(`document.getElementById(${JSON.stringify(id)}).click()`),
        text: (id) => page.eval(`document.getElementById(${JSON.stringify(id)}).textContent`),
        visible: (id) => page.eval(`(() => { let el = document.getElementById(${JSON.stringify(id)});
            for (; el; el = el.parentElement) if (el.hidden) return false; return true; })()`),
        hash: () => page.eval('location.hash'),
        storageHasSession: () => page.eval(`localStorage.getItem(${JSON.stringify(STORAGE_KEY)}) !== null`),
    };
    return page;
}

export const visibleExpr = (id) => `(() => { let el = document.getElementById(${JSON.stringify(id)});
    if (!el) return false; for (; el; el = el.parentElement) if (el.hidden) return false; return true; })()`;

// ------------------------------------------------------------------ mock Supabase

export const MOCK_PASSWORD = `Mock-${crypto.randomUUID()}`; // random per run; not a real credential
export const USERS = {
    'alice@example.test': { id: 'a1111111-1111-4111-8111-111111111111', email: 'alice@example.test' },
    'bob@example.test': { id: 'b2222222-2222-4222-8222-222222222222', email: 'bob@example.test' },
};

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
export function makeSession(user, expiresIn = 3600) {
    const exp = Math.floor(Date.now() / 1000) + expiresIn;
    const fullUser = { ...user, aud: 'authenticated', role: 'authenticated', email_confirmed_at: '2026-10-01T00:00:00Z',
        created_at: '2026-10-01T00:00:00Z', app_metadata: { provider: 'email' }, user_metadata: {}, identities: [] };
    return {
        access_token: `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: user.id, email: user.email, exp, role: 'authenticated', aud: 'authenticated' })}.sig`,
        token_type: 'bearer', expires_in: expiresIn, expires_at: exp, refresh_token: `refresh-${user.id}`, user: fullUser,
    };
}

// Fake Supabase served from inside the browser via the CDP Fetch domain.
// mock.* fields switch behaviours per test; mock.log records every request.
export function installMock(page, cdp) {
    const mock = {
        refreshMode: 'ok', incidentsMode: 'ok', uploadMode: 'ok', insertMode: 'ok',
        log: [], delayMs: 300, incidents: [], objects: new Map(),
    };
    const cors = [
        { name: 'Access-Control-Allow-Origin', value: '*' },
        { name: 'Access-Control-Allow-Headers', value: '*' },
        { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' },
        { name: 'Access-Control-Expose-Headers', value: 'content-range' },
    ];
    const respond = (requestId, status, body, extraHeaders = []) => page.send('Fetch.fulfillRequest', {
        requestId, responseCode: status,
        responseHeaders: [...cors, { name: 'Content-Type', value: 'application/json' }, ...extraHeaders],
        body: Buffer.from(body === undefined ? '' : JSON.stringify(body)).toString('base64'),
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bodyBytes = (request) => (request.postDataEntries || [])
        .reduce((n, e) => n + (e.bytes ? Buffer.from(e.bytes, 'base64').length : 0), 0);
    const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    cdp.on(async (msg) => {
        if (msg.method !== 'Fetch.requestPaused' || msg.sessionId !== page.sessionId) return;
        const { requestId, request } = msg.params;
        const url = new URL(request.url);
        const key = `${request.method} ${url.pathname}`;
        const header = (name) => request.headers[name] || request.headers[name.toLowerCase()] || '';
        const auth = header('Authorization');
        const entry = { key, url: request.url, auth, grant: url.searchParams.get('grant_type'),
            contentType: header('Content-Type'), postData: request.postData, postDataEntries: request.postDataEntries,
            bytes: bodyBytes(request) };
        mock.log.push(entry);

        if (request.method === 'OPTIONS') return page.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: cors });

        if (key === 'POST /auth/v1/token' && entry.grant === 'password') {
            await sleep(mock.delayMs);
            const { email, password } = JSON.parse(request.postData || '{}');
            if (USERS[email] && password === MOCK_PASSWORD) return respond(requestId, 200, makeSession(USERS[email]));
            return respond(requestId, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        }
        if (key === 'POST /auth/v1/token' && entry.grant === 'refresh_token') {
            if (mock.refreshMode === 'network') return page.send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' });
            if (mock.refreshMode === 'reject') {
                return respond(requestId, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
            }
            const { refresh_token: rt } = JSON.parse(request.postData || '{}');
            const user = Object.values(USERS).find((u) => rt === `refresh-${u.id}`);
            return user ? respond(requestId, 200, makeSession(user))
                : respond(requestId, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
        }
        if (key === 'POST /auth/v1/signup') {
            await sleep(mock.delayMs);
            const { email } = JSON.parse(request.postData || '{}');
            const user = { id: 'c3333333-3333-4333-8333-333333333333', email };
            if (email.startsWith('confirm')) {
                // Email confirmation ON: GoTrue returns the user, no session.
                return respond(requestId, 200, { ...user, aud: 'authenticated', role: 'authenticated', identities: [{ id: user.id }],
                    confirmation_sent_at: new Date().toISOString(), created_at: new Date().toISOString() });
            }
            USERS[email] = user;
            return respond(requestId, 200, makeSession(user));
        }
        if (key === 'POST /auth/v1/logout') return respond(requestId, 204);

        // Storage: upload, delete, public read.
        const uploadPrefix = '/storage/v1/object/incident-photos/';
        if (request.method === 'POST' && url.pathname.startsWith(uploadPrefix)) {
            await sleep(mock.delayMs);
            const objectPath = decodeURIComponent(url.pathname.slice(uploadPrefix.length));
            entry.objectPath = objectPath;
            if (mock.uploadMode === 'network') return page.send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' });
            if (mock.uploadMode === 'too-large') {
                return respond(requestId, 413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
            }
            mock.objects.set(objectPath, entry);
            return respond(requestId, 200, { Key: `incident-photos/${objectPath}`, Id: crypto.randomUUID() });
        }
        if (key === 'DELETE /storage/v1/object/incident-photos') {
            const { prefixes = [] } = JSON.parse(request.postData || '{}');
            entry.removed = prefixes;
            prefixes.forEach((p) => mock.objects.delete(p));
            return respond(requestId, 200, prefixes.map((name) => ({ name })));
        }
        if (request.method === 'GET' && url.pathname.startsWith('/storage/v1/object/public/incident-photos/') && !url.pathname.includes('broken')) {
            return page.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
                responseHeaders: [...cors, { name: 'Content-Type', value: 'image/png' }], body: PNG_1PX });
        }

        // PostgREST: incidents.
        if (key === 'POST /rest/v1/incidents') {
            await sleep(mock.delayMs);
            if (mock.insertMode === 'network') return page.send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' });
            if (mock.insertMode === 'reject') {
                return respond(requestId, 400, { code: '23514', message: 'new row for relation "incidents" violates check constraint', details: null, hint: null });
            }
            const userId = JSON.parse(Buffer.from(auth.replace(/^Bearer /, '').split('.')[1], 'base64url')).sub;
            const row = { id: crypto.randomUUID(), verification_status: 'unverified', created_at: new Date().toISOString(),
                ...JSON.parse(request.postData || '{}') };
            entry.inserted = row;
            if (row.user_id !== userId) return respond(requestId, 403, { code: '42501', message: 'new row violates row-level security policy' });
            mock.incidents.push(row);
            const single = /vnd\.pgrst\.object/.test(header('Accept'));
            return respond(requestId, 201, single ? row : [row]);
        }
        if (key === 'GET /rest/v1/incidents') {
            if (mock.incidentsDelay) await sleep(mock.incidentsDelay(url));
            if (mock.incidentsMode === '401') return respond(requestId, 401, { code: 'PGRST301', message: 'JWT expired' });
            if (mock.incidentsMode === 'error500') return respond(requestId, 500, { code: 'XX000', message: 'mock server error' });
            if (mock.incidentsMode === 'network') return page.send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' });
            let rows = mock.incidents.slice();
            for (const [col, raw] of url.searchParams) {
                if (raw.startsWith('eq.')) rows = rows.filter((r) => String(r[col]) === raw.slice(3));
                if (raw.startsWith('gte.')) rows = rows.filter((r) => String(r[col]) >= raw.slice(4));
            }
            const or = url.searchParams.get('or');
            if (or) {
                // The feed's keyset filter: (created_at < ts) or (created_at = ts and id < id)
                const m = or.match(/^\(created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]+)\)\)$/);
                if (!m) return respond(requestId, 400, { code: 'PGRST100', message: `mock: unexpected or filter ${or}` });
                entry.cursor = m[1];
                rows = rows.filter((r) => r.created_at < m[1] || (r.created_at === m[1] && r.id < m[3]));
            }
            rows.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : (a.created_at < b.created_at ? 1 : -1)));
            const limit = Number(url.searchParams.get('limit'));
            if (limit) rows = rows.slice(0, limit);
            if (/vnd\.pgrst\.object/.test(header('Accept'))) {
                return rows.length === 1 ? respond(requestId, 200, rows[0])
                    : respond(requestId, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' });
            }
            return respond(requestId, 200, rows, [{ name: 'Content-Range', value: `0-${rows.length}/*` }]);
        }
        if (request.method === 'GET' && url.pathname.includes('/storage/v1/object/public/') && url.pathname.includes('broken')) {
            return respond(requestId, 404, { message: 'Object not found' });
        }
        return respond(requestId, 404, { message: `mock: unhandled ${key}` });
    });
    return mock;
}

export const count = (mock, pred) => mock.log.filter(pred).length;
export function tokenSubject(authHeader) {
    try { return JSON.parse(Buffer.from(authHeader.replace(/^Bearer /, '').split('.')[1], 'base64url')).sub; }
    catch { return null; }
}
export const isPasswordLogin = (e) => e.key === 'POST /auth/v1/token' && e.grant === 'password';
export const lastIncidents = (mock) => [...mock.log].reverse().find((e) => e.key === 'GET /rest/v1/incidents');

export async function login(page, email, password) {
    await page.fill('login-email', email);
    await page.fill('login-password', password);
    await page.click('login-submit');
}


// Starts the server + Chrome, runs phases, prints a summary and exits.
export async function run(phases, opts = {}) {
    const reporter = createReporter();
    const server = await serve(opts);
    const base = `http://127.0.0.1:${server.address().port}`;
    const chrome = await launchChrome();
    try {
        const cdp = await connect(chrome.wsUrl);
        for (const phase of phases) await phase({ cdp, base, check: reporter.check });
        cdp.ws.close();
    } catch (e) {
        reporter.fail(`harness error: ${e.stack || e.message}`);
    } finally {
        await new Promise((resolve) => { chrome.proc.once('exit', resolve); chrome.proc.kill(); });
        server.close();
        fs.rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    console.log(reporter.failures === 0 ? '\nRESULT: all e2e checks passed.' : `\nRESULT: ${reporter.failures} e2e check(s) failed.`);
    process.exit(reporter.failures === 0 ? 0 : 1);
}

// Stand-in for supabase-js Realtime channels, injected before the app loads.
// Only client.channel / removeChannel / removeAllChannels are replaced; the
// app code and supabase-js are otherwise untouched. Tests drive it through
// window.__rt: emit(row) delivers an INSERT, status(s) sends a channel status,
// active() counts open channels, autoStatus sets the status sent on subscribe.
export async function installRealtimeShim(page) {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        const rt = window.__rt = {
            channels: [], removed: 0, autoStatus: 'SUBSCRIBED',
            open() { return rt.channels.filter((c) => !c.removed); },
            active() { return rt.open().length; },
            emit(row) { rt.open().forEach((c) => c.handlers.forEach((h) => h({ eventType: 'INSERT', new: row }))); },
            status(s) { rt.open().forEach((c) => c.statusCb && c.statusCb(s)); },
        };
        let real;
        Object.defineProperty(window, 'supabase', {
            configurable: true,
            get() { return real; },
            set(lib) {
                const createClient = lib.createClient;
                real = Object.assign({}, lib, { createClient(...args) {
                    const client = createClient(...args);
                    client.channel = (name) => {
                        const c = { name, handlers: [], removed: false,
                            on(type, filter, cb) { c.filter = filter; c.handlers.push(cb); return c; },
                            subscribe(cb) { c.statusCb = cb; setTimeout(() => { if (!c.removed) cb(rt.autoStatus); }, 30); return c; } };
                        rt.channels.push(c);
                        return c;
                    };
                    const remove = (c) => { if (!c.removed) { c.removed = true; rt.removed += 1; } };
                    client.removeChannel = async (c) => { remove(c); return 'ok'; };
                    client.removeAllChannels = async () => { rt.channels.forEach(remove); return []; };
                    return client;
                } });
            },
        });
    })();` });
}
