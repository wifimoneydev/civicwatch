'use strict';

// Auth validation, error messages, the session controller (driven by a fake
// supabase-js client) and the My Reports query.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const Auth = require(path.join(root, 'www/js/auth-logic.js'));
const { createSessionController } = require(path.join(root, 'www/js/session.js'));
const { fetchMyReports } = require(path.join(root, 'www/js/my-reports.js'));

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const ALICE = { id: 'a1111111-1111-4111-8111-111111111111', email: 'alice@example.test' };
const BOB = { id: 'b2222222-2222-4222-8222-222222222222', email: 'bob@example.test' };
const sessionFor = (user) => ({ access_token: 'x', refresh_token: 'y', expires_at: 9e9, user });
const networkError = () => Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 });

// Minimal stand-in for supabase.auth, mimicking supabase-js event behaviour.
function fakeClient({ stored = null, getSessionResult, confirmEmail = false, signOutError = null, users = [ALICE, BOB] } = {}) {
    let listener = null;
    const calls = [];
    const emit = (event, session) => listener && listener(event, session);
    const auth = {
        onAuthStateChange(cb) { listener = cb; return { data: { subscription: { unsubscribe() {} } } }; },
        async getSession() {
            calls.push('getSession');
            return getSessionResult || { data: { session: stored }, error: null };
        },
        async signInWithPassword({ email, password }) {
            calls.push(`signIn:${email}`);
            const user = users.find((u) => u.email === email);
            if (!user || password !== 'right-pass') {
                return { data: { user: null, session: null },
                    error: { name: 'AuthApiError', status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' } };
            }
            stored = sessionFor(user);
            emit('SIGNED_IN', stored);
            return { data: { user, session: stored }, error: null };
        },
        async signUp({ email }) {
            calls.push(`signUp:${email}`);
            const user = { id: 'c3333333-3333-4333-8333-333333333333', email };
            if (confirmEmail) return { data: { user, session: null }, error: null };
            stored = sessionFor(user);
            emit('SIGNED_IN', stored);
            return { data: { user, session: stored }, error: null };
        },
        async signOut(opts = {}) {
            calls.push(`signOut:${opts.scope || 'global'}`);
            stored = null;
            emit('SIGNED_OUT', null);
            return { error: opts.scope ? null : signOutError };
        },
    };
    return { auth, calls, emit, removeAllChannels() { calls.push('removeAllChannels'); } };
}

function controller(client, options) {
    const events = [];
    const ctl = createSessionController(client, {
        onSignedIn: (user, prev) => events.push(['in', user.id, prev ? prev.id : null]),
        onSignedOut: (reason) => events.push(['out', reason]),
    }, options);
    return { ctl, events };
}

describe('validation', () => {
    test('login requires a valid email and a password; email is normalised', () => {
        assert.deepEqual(Auth.validateLogin({ email: '', password: '' }).errors,
            { email: 'Enter your email address.', password: 'Enter your password.' });
        assert.equal(Auth.validateLogin({ email: 'not-an-email', password: 'x' }).errors.email, 'Enter a valid email address.');
        const ok = Auth.validateLogin({ email: '  Alice@Example.TEST ', password: 'anything' });
        assert.equal(ok.ok, true);
        assert.equal(ok.values.email, 'alice@example.test');
    });

    test('signup enforces password length, letters+numbers and confirmation', () => {
        const base = { email: 'a@example.test' };
        assert.match(Auth.validateSignup({ ...base, password: 'abc12', confirm: 'abc12' }).errors.password, /at least 8/);
        assert.match(Auth.validateSignup({ ...base, password: 'abcdefgh', confirm: 'abcdefgh' }).errors.password, /letter and one number/);
        assert.match(Auth.validateSignup({ ...base, password: 'x1'.repeat(40), confirm: 'x1'.repeat(40) }).errors.password, /at most 72/);
        assert.equal(Auth.validateSignup({ ...base, password: 'abcdefg1', confirm: 'abcdefg2' }).errors.confirm, 'Passwords do not match.');
        assert.equal(Auth.validateSignup({ ...base, password: 'abcdefg1', confirm: 'abcdefg1' }).ok, true);
    });
});

describe('error messages', () => {
    test('maps Supabase auth errors to readable text', () => {
        const cases = [
            [{ code: 'invalid_credentials', message: 'Invalid login credentials' }, /incorrect/],
            [{ message: 'Invalid login credentials' }, /incorrect/],
            [{ code: 'email_not_confirmed' }, /confirm your email/],
            [{ code: 'user_already_exists' }, /already exists/],
            [{ code: 'over_email_send_rate_limit' }, /Too many emails/],
            [{ code: 'weak_password' }, /too weak/],
            [networkError(), /internet connection/],
            [new TypeError('Failed to fetch'), /internet connection/],
            [{ status: 503, message: 'upstream' }, /server had a problem/],
            [{ message: 'something odd' }, /Something went wrong/],
        ];
        for (const [error, expected] of cases) assert.match(Auth.friendlyAuthError(error), expected, JSON.stringify(error));
    });

    test('recognises expired-token errors from data requests', () => {
        assert.equal(Auth.isSessionExpiredError({ code: 'PGRST301', message: 'JWT expired' }), true);
        assert.equal(Auth.isSessionExpiredError({ message: 'x' }, 401), true);
        assert.equal(Auth.isSessionExpiredError({ code: '42501', message: 'permission denied' }, 403), false);
    });
});

describe('session controller', () => {
    test('restores a stored session before anything else', async () => {
        const client = fakeClient({ stored: sessionFor(ALICE) });
        const { ctl } = controller(client);
        const res = await ctl.start();
        assert.equal(res.status, 'signed_in');
        assert.equal(res.user.id, ALICE.id);
        assert.equal(ctl.getUser().id, ALICE.id);
    });

    test('no stored session means signed out', async () => {
        const { ctl } = controller(fakeClient());
        assert.deepEqual(await ctl.start(), { status: 'signed_out', expired: false });
        assert.equal(ctl.getUser(), null);
    });

    test('a rejected refresh on start-up is reported as expired', async () => {
        const client = fakeClient({ getSessionResult: { data: { session: null },
            error: { name: 'AuthApiError', status: 400, code: 'refresh_token_not_found' } } });
        const { ctl } = controller(client);
        assert.deepEqual(await ctl.start(), { status: 'signed_out', expired: true });
    });

    test('a stored session removed during start-up (refresh rejected by Supabase) is reported as expired', async () => {
        const client = fakeClient();
        client.auth.getSession = async () => {
            client.emit('SIGNED_OUT', null); // what supabase-js does when the init refresh is rejected
            return { data: { session: null }, error: null };
        };
        const { ctl, events } = controller(client);
        assert.deepEqual(await ctl.start(), { status: 'signed_out', expired: true });
        await tick();
        assert.deepEqual(events, [], 'no duplicate signed-out event');
    });

    test('a stored session that supabase-js discarded before start() is reported as expired', async () => {
        const { ctl } = controller(fakeClient(), { hadStoredSession: true });
        assert.deepEqual(await ctl.start(), { status: 'signed_out', expired: true });
        assert.deepEqual(await ctl.start(), { status: 'signed_out', expired: false }, 'only the first restore');
    });

    test('a network failure on start-up is "offline", not signed out, and can be retried', async () => {
        const client = fakeClient({ getSessionResult: { data: { session: null }, error: networkError() } });
        const { ctl } = controller(client);
        assert.equal((await ctl.start()).status, 'offline');
        assert.equal(ctl.getUser(), null, 'no protected access while offline');
    });

    test('login success signs in exactly once', async () => {
        const { ctl, events } = controller(fakeClient());
        await ctl.start();
        const res = await ctl.signIn(ALICE.email, 'right-pass');
        await tick();
        assert.equal(res.ok, true);
        assert.deepEqual(events, [['in', ALICE.id, null]]);
    });

    test('incorrect password does not sign in', async () => {
        const { ctl, events } = controller(fakeClient());
        await ctl.start();
        const res = await ctl.signIn(ALICE.email, 'wrong-pass');
        await tick();
        assert.equal(res.ok, false);
        assert.equal(res.error.code, 'invalid_credentials');
        assert.equal(ctl.getUser(), null);
        assert.deepEqual(events, []);
    });

    test('signup with email confirmation ON returns no session and does not sign in', async () => {
        const { ctl, events } = controller(fakeClient({ confirmEmail: true }));
        await ctl.start();
        const res = await ctl.signUp('new@example.test', 'abcdefg1');
        await tick();
        assert.deepEqual(res, { status: 'confirm_email', email: 'new@example.test' });
        assert.equal(ctl.getUser(), null);
        assert.deepEqual(events, []);
    });

    test('signup with email confirmation OFF signs in immediately', async () => {
        const { ctl, events } = controller(fakeClient({ confirmEmail: false }));
        await ctl.start();
        const res = await ctl.signUp('new@example.test', 'abcdefg1');
        await tick();
        assert.equal(res.status, 'signed_in');
        assert.equal(events.length, 1);
        assert.equal(events[0][0], 'in');
    });

    test('logout reports reason "user" once', async () => {
        const client = fakeClient({ stored: sessionFor(ALICE) });
        const { ctl, events } = controller(client);
        await ctl.start();
        const res = await ctl.signOut();
        await tick();
        assert.equal(res.error, null);
        assert.equal(ctl.getUser(), null);
        assert.deepEqual(events, [['out', 'user']]);
    });

    test('logout still ends the local session when the server is unreachable', async () => {
        const client = fakeClient({ stored: sessionFor(ALICE), signOutError: networkError() });
        const { ctl, events } = controller(client);
        await ctl.start();
        const res = await ctl.signOut();
        await tick();
        assert.ok(res.error, 'error is surfaced for a warning');
        assert.ok(client.calls.includes('signOut:local'), 'falls back to a local sign-out');
        assert.equal(ctl.getUser(), null);
        assert.deepEqual(events, [['out', 'user']]);
    });

    test('a session ended by Supabase (failed background refresh) is reported as expired', async () => {
        const client = fakeClient({ stored: sessionFor(ALICE) });
        const { ctl, events } = controller(client);
        await ctl.start();
        client.emit('SIGNED_OUT', null);
        await tick();
        assert.deepEqual(events, [['out', 'expired']]);
    });

    test('expire() after a 401 ends the session locally with reason "expired"', async () => {
        const client = fakeClient({ stored: sessionFor(ALICE) });
        const { ctl, events } = controller(client);
        await ctl.start();
        await ctl.expire();
        await tick();
        assert.ok(client.calls.includes('signOut:local'));
        assert.deepEqual(events, [['out', 'expired']]);
    });

    test('switching accounts reports the previous user so state can be reset', async () => {
        const client = fakeClient();
        const { ctl, events } = controller(client);
        await ctl.start();
        await ctl.signIn(ALICE.email, 'right-pass');
        await ctl.signOut();
        await ctl.signIn(BOB.email, 'right-pass');
        await tick();
        assert.deepEqual(events, [['in', ALICE.id, null], ['out', 'user'], ['in', BOB.id, null]]);
        assert.equal(ctl.getUser().id, BOB.id);
    });
});

describe('My Reports query', () => {
    function fakeQueryClient(rows) {
        const log = [];
        const builder = {
            select(cols) { log.push(['select', cols]); return builder; },
            eq(col, val) { log.push(['eq', col, val]); return builder; },
            order(col, opts) { log.push(['order', col, opts]); return builder; },
            limit(n) { log.push(['limit', n]); return Promise.resolve({ data: rows, error: null, status: 200 }); },
        };
        return { log, from(table) { log.push(['from', table]); return builder; } };
    }

    test('filters by the signed-in user id, newest first', async () => {
        const client = fakeQueryClient([]);
        const res = await fetchMyReports(client, ALICE.id);
        assert.deepEqual(res.rows, []);
        assert.deepEqual(client.log.filter((c) => c[0] !== 'select'), [
            ['from', 'incidents'],
            ['eq', 'user_id', ALICE.id],
            ['order', 'created_at', { ascending: false }],
            ['limit', 50],
        ]);
    });

    test("never returns another user's rows, even if the server sent them", async () => {
        const client = fakeQueryClient([
            { id: '1', user_id: ALICE.id, title: 'Mine' },
            { id: '2', user_id: BOB.id, title: 'Not mine' },
        ]);
        const res = await fetchMyReports(client, ALICE.id);
        assert.deepEqual(res.rows.map((r) => r.title), ['Mine']);
    });

    test('refuses to run without a user id', async () => {
        await assert.rejects(fetchMyReports(fakeQueryClient([]), undefined), /user id/);
    });
});
