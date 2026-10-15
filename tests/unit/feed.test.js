'use strict';

// Feed queries, pagination, category switching (incl. stale responses),
// incident lookup, notification filtering and Realtime subscription cleanup.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const F = require(path.join(__dirname, '..', '..', 'www/js/feed.js'));

const ME = 'a1111111-1111-4111-8111-111111111111';
const OTHER = 'b2222222-2222-4222-8222-222222222222';
const CATS = ['accident', 'fighting', 'rioting', 'fire', 'theft', 'other'];

function uuid(n) { return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`; }
function dataset(count, opts = {}) {
    const base = Date.parse('2026-10-01T00:00:00Z');
    return Array.from({ length: count }, (_, i) => ({
        id: uuid(i + 1),
        user_id: i % 2 ? ME : OTHER,
        title: `Report ${i + 1}`,
        category: opts.category || CATS[i % CATS.length],
        // opts.sameTime: every row shares one timestamp
        created_at: new Date(base + (opts.sameTime ? 0 : i * 60000)).toISOString(),
    }));
}

// Fake supabase client that really applies eq / lte / order / limit to rows.
function queryClient(rows) {
    const log = [];
    return {
        log,
        from(table) {
            const q = { filters: [], orders: [], lim: Infinity, table };
            const b = {
                select(cols) { q.cols = cols; return b; },
                eq(col, val) { q.filters.push((r) => String(r[col]) === String(val)); log.push(['eq', col, val]); return b; },
                // Understands exactly the keyset filter the app sends.
                or(expr) {
                    log.push(['or', expr]);
                    const m = expr.match(/^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([0-9a-f-]+)\)$/);
                    assert.ok(m && m[1] === m[2], `unexpected or() filter: ${expr}`);
                    q.filters.push((r) => r.created_at < m[1] || (r.created_at === m[1] && r.id < m[3]));
                    return b;
                },
                order(col, opt) { q.orders.push([col, opt.ascending]); log.push(['order', col, opt.ascending]); return b; },
                limit(n) {
                    log.push(['limit', n]);
                    let out = rows.filter((r) => q.filters.every((f) => f(r)));
                    out.sort((a, c) => {
                        for (const [col, asc] of q.orders) {
                            if (a[col] !== c[col]) return (a[col] < c[col] ? -1 : 1) * (asc ? 1 : -1);
                        }
                        return 0;
                    });
                    return Promise.resolve({ data: out.slice(0, n), error: null, status: 200 });
                },
                maybeSingle() {
                    const out = rows.filter((r) => q.filters.every((f) => f(r)));
                    return Promise.resolve({ data: out[0] || null, error: null, status: 200 });
                },
            };
            return b;
        },
    };
}

function controllerFor(client, pageSize = 10) {
    const states = [];
    const ctl = F.createFeedController({
        pageSize,
        fetchPage: (category, cursor) => F.fetchFeedPage(client, category, cursor, pageSize),
        onChange: (s) => states.push(s),
    });
    return { ctl, states };
}

const ids = (rows) => rows.map((r) => r.id);
const unique = (arr) => new Set(arr).size === arr.length;

describe('fetchFeedPage', () => {
    test('newest first, page size + 1, no category filter for "all"', async () => {
        const client = queryClient(dataset(3));
        const res = await F.fetchFeedPage(client, 'all', null, 10);
        assert.equal(res.rows[0].title, 'Report 3');
        assert.deepEqual(client.log, [['order', 'created_at', false], ['order', 'id', false], ['limit', 11]]);
    });

    test('the cursor filter is exact and rejects malformed cursor values', async () => {
        const client = queryClient(dataset(3));
        await F.fetchFeedPage(client, 'all', { id: uuid(2), created_at: '2026-10-01T00:01:00.123456+00:00' }, 10);
        assert.deepEqual(client.log.find((c) => c[0] === 'or'),
            ['or', `created_at.lt."2026-10-01T00:01:00.123456+00:00",and(created_at.eq."2026-10-01T00:01:00.123456+00:00",id.lt.${uuid(2)})`]);
        await assert.rejects(F.fetchFeedPage(client, 'all', { id: 'x),or(id.gt.0', created_at: '2026-10-01T00:00:00Z' }, 10), /invalid feed cursor/);
        await assert.rejects(F.fetchFeedPage(client, 'all', { id: uuid(1), created_at: '2026") or (1' }, 10), /invalid feed cursor/);
    });

    test('category is filtered in the database query', async () => {
        const client = queryClient(dataset(30));
        const res = await F.fetchFeedPage(client, 'rioting', null, 10);
        assert.ok(client.log.some((c) => c[0] === 'eq' && c[1] === 'category' && c[2] === 'rioting'));
        assert.ok(res.rows.length > 0 && res.rows.every((r) => r.category === 'rioting'));
    });
});

describe('pagination', () => {
    test('Load More walks every report exactly once, newest first', async () => {
        const all = dataset(25);
        const { ctl } = controllerFor(queryClient(all));
        await ctl.refresh();
        assert.equal(ctl.getState().rows.length, 10);
        assert.equal(ctl.getState().hasMore, true);
        await ctl.loadMore();
        assert.equal(ctl.getState().rows.length, 20);
        await ctl.loadMore();
        const s = ctl.getState();
        assert.equal(s.rows.length, 25);
        assert.equal(s.hasMore, false);
        assert.ok(unique(ids(s.rows)), 'no duplicates');
        assert.deepEqual(ids(s.rows), ids(all.slice().sort(F.newestFirst)));
    });

    test('exactly two full pages: no pointless third Load More', async () => {
        const { ctl } = controllerFor(queryClient(dataset(20)));
        await ctl.refresh();
        await ctl.loadMore();
        assert.equal(ctl.getState().rows.length, 20);
        assert.equal(ctl.getState().hasMore, false);
    });

    test('rows sharing one timestamp across a page boundary are not skipped', async () => {
        const all = dataset(15, { sameTime: true });
        const { ctl } = controllerFor(queryClient(all));
        await ctl.refresh();
        await ctl.loadMore();
        await ctl.loadMore();
        assert.equal(ctl.getState().rows.length, 15);
        assert.ok(unique(ids(ctl.getState().rows)));
    });

    test('Load More is ignored while a request is already running', async () => {
        const client = queryClient(dataset(40));
        const { ctl } = controllerFor(client);
        await ctl.refresh();
        await Promise.all([ctl.loadMore(), ctl.loadMore(), ctl.loadMore()]);
        assert.equal(ctl.getState().rows.length, 20);
    });
});

describe('categories', () => {
    test('changing category resets pagination and filters the query', async () => {
        const client = queryClient(dataset(90));
        const { ctl } = controllerFor(client);
        await ctl.refresh();
        await ctl.loadMore();
        assert.equal(ctl.getState().rows.length, 20);
        await ctl.setCategory('fighting');
        const s = ctl.getState();
        assert.equal(s.category, 'fighting');
        assert.equal(s.rows.length, 10, 'back to the first page');
        assert.ok(s.rows.every((r) => r.category === 'fighting'));
        assert.equal(s.hasMore, true, '15 fighting reports exist');
    });

    test('a slow response for a previous category never replaces the current one', async () => {
        const pending = {};
        const ctl = F.createFeedController({
            pageSize: 10,
            fetchPage: (category) => new Promise((resolve) => { pending[category] = resolve; }),
        });
        ctl.setCategory('fighting');
        ctl.setCategory('accident');
        pending.accident({ rows: [{ id: uuid(1), category: 'accident', created_at: '2026-10-02T00:00:00Z' }], error: null });
        await new Promise((r) => setImmediate(r));
        pending.fighting({ rows: [{ id: uuid(2), category: 'fighting', created_at: '2026-10-03T00:00:00Z' }], error: null });
        await new Promise((r) => setImmediate(r));
        const s = ctl.getState();
        assert.equal(s.category, 'accident');
        assert.deepEqual(s.rows.map((r) => r.category), ['accident']);
    });

    test('a slow Load More from the previous category is discarded', async () => {
        let release;
        const client = queryClient(dataset(60));
        const ctl = F.createFeedController({
            pageSize: 10,
            fetchPage: (category, cursor) => (cursor
                ? new Promise((resolve) => { release = () => F.fetchFeedPage(client, category, cursor, 10).then(resolve); })
                : F.fetchFeedPage(client, category, cursor, 10)),
        });
        await ctl.refresh();
        const more = ctl.loadMore();
        await ctl.setCategory('theft');
        release();
        await more;
        assert.ok(ctl.getState().rows.every((r) => r.category === 'theft'));
    });

    test('errors are reported, and a retry recovers', async () => {
        let fail = true;
        const client = queryClient(dataset(5));
        const ctl = F.createFeedController({
            fetchPage: (c, cur) => (fail ? Promise.resolve({ rows: [], error: { message: 'Failed to fetch' } }) : F.fetchFeedPage(client, c, cur)),
        });
        await ctl.refresh();
        assert.ok(ctl.getState().error);
        assert.equal(ctl.getState().loaded, false);
        fail = false;
        await ctl.refresh();
        assert.equal(ctl.getState().error, null);
        assert.equal(ctl.getState().rows.length, 5);
    });
});

describe('Realtime rows in the feed', () => {
    test('new rows are added once, at the top, only for the selected category', async () => {
        const { ctl } = controllerFor(queryClient(dataset(5)));
        await ctl.setCategory('rioting');
        const before = ctl.getState().rows.length;
        const fighting = { id: uuid(100), category: 'fighting', created_at: '2026-10-09T00:00:00Z' };
        const rioting = { id: uuid(101), category: 'rioting', created_at: '2026-10-09T00:00:00Z' };
        assert.equal(ctl.addRealtime(fighting), false, 'other category is ignored');
        assert.equal(ctl.addRealtime(rioting), true);
        assert.equal(ctl.addRealtime(rioting), false, 'duplicate event ignored');
        const s = ctl.getState();
        assert.equal(s.rows.length, before + 1);
        assert.equal(s.rows[0].id, rioting.id);
    });

    test('rows arriving before the first page loads are not added (the load will include them)', () => {
        const ctl = F.createFeedController({ fetchPage: () => new Promise(() => {}) });
        ctl.refresh();
        assert.equal(ctl.addRealtime({ id: uuid(1), category: 'fire', created_at: '2026-10-09T00:00:00Z' }), false);
    });

    test('reset clears everything and invalidates in-flight requests', async () => {
        let resolveLate;
        const ctl = F.createFeedController({ fetchPage: () => new Promise((r) => { resolveLate = r; }) });
        ctl.refresh();
        ctl.reset();
        resolveLate({ rows: [{ id: uuid(1), category: 'fire', created_at: '2026-10-09T00:00:00Z' }], error: null });
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(ctl.getState().rows, []);
        assert.equal(ctl.getState().loaded, false);
    });
});

describe('fetchIncident', () => {
    test('finds a report by id', async () => {
        const all = dataset(3);
        const res = await F.fetchIncident(queryClient(all), all[1].id);
        assert.equal(res.row.title, 'Report 2');
    });

    test('unknown or malformed ids are "not found" (malformed ids never hit the network)', async () => {
        const client = queryClient(dataset(3));
        assert.equal((await F.fetchIncident(client, uuid(999))).row, null);
        const before = client.log.length;
        assert.equal((await F.fetchIncident(client, 'abc')).row, null);
        assert.equal((await F.fetchIncident(client, "1' or '1'='1")).row, null);
        assert.equal(client.log.length, before);
    });
});

describe('notification filter', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    const row = (over) => ({ id: uuid(1), user_id: OTHER, category: 'rioting', created_at: '2026-10-15T12:00:05Z', ...over });

    test('another user\'s new report notifies exactly once', () => {
        const f = F.createNotificationFilter({ getUserId: () => ME });
        f.start(now);
        assert.equal(f.shouldNotify(row()), true);
        assert.equal(f.shouldNotify(row()), false, 'duplicate event');
    });

    test('own reports never notify', () => {
        const f = F.createNotificationFilter({ getUserId: () => ME });
        f.start(now);
        assert.equal(f.shouldNotify(row({ user_id: ME })), false);
    });

    test('reports older than the subscription never notify', () => {
        const f = F.createNotificationFilter({ getUserId: () => ME });
        f.start(now);
        assert.equal(f.shouldNotify(row({ created_at: '2026-10-14T12:00:00Z' })), false);
        assert.equal(f.shouldNotify(row({ id: uuid(2), created_at: '2026-10-15T11:59:00Z' })), true, 'small clock skew tolerated');
    });

    test('nothing notifies before start() or after reset()', () => {
        const f = F.createNotificationFilter({ getUserId: () => ME });
        assert.equal(f.shouldNotify(row()), false);
        f.start(now);
        f.reset();
        assert.equal(f.shouldNotify(row({ id: uuid(3) })), false);
    });
});

describe('Realtime subscription', () => {
    function fakeRealtimeClient() {
        const channels = [];
        return {
            channels,
            channel(name) {
                const c = { name, handlers: [], removed: false,
                    on(type, filter, cb) { c.type = type; c.filter = filter; c.handlers.push(cb); return c; },
                    subscribe(cb) { c.statusCb = cb; return c; },
                    emit(row) { c.handlers.forEach((h) => h({ eventType: 'INSERT', new: row })); } };
                channels.push(c);
                return c;
            },
            removeChannel(c) { c.removed = true; return Promise.resolve('ok'); },
        };
    }

    test('listens to INSERTs on public.incidents and maps statuses', () => {
        const client = fakeRealtimeClient();
        const statuses = [];
        const rows = [];
        F.createIncidentSubscription(client, { onInsert: (r) => rows.push(r), onStatus: (s) => statuses.push(s) });
        const c = client.channels[0];
        assert.equal(c.type, 'postgres_changes');
        assert.deepEqual(c.filter, { event: 'INSERT', schema: 'public', table: 'incidents' });
        c.statusCb('SUBSCRIBED');
        c.statusCb('CHANNEL_ERROR', new Error('x'));
        c.statusCb('TIMED_OUT');
        c.statusCb('CLOSED');
        assert.deepEqual(statuses, ['connecting', 'live', 'error', 'error', 'closed']);
        c.emit({ id: uuid(1) });
        assert.equal(rows.length, 1);
    });

    test('stop() removes the channel and silences late events and statuses', () => {
        const client = fakeRealtimeClient();
        const rows = [];
        const statuses = [];
        const sub = F.createIncidentSubscription(client, { onInsert: (r) => rows.push(r), onStatus: (s) => statuses.push(s) });
        sub.stop();
        sub.stop();
        const c = client.channels[0];
        assert.equal(c.removed, true);
        c.emit({ id: uuid(1) });
        c.statusCb('SUBSCRIBED');
        assert.deepEqual(rows, []);
        assert.deepEqual(statuses, ['connecting']);
        assert.equal(sub.isActive(), false);
    });
});

test('relative times', () => {
    const now = Date.parse('2026-10-15T12:00:00Z');
    assert.equal(F.relativeTime('2026-10-15T11:59:30Z', now), 'just now');
    assert.equal(F.relativeTime('2026-10-15T11:45:00Z', now), '15 min ago');
    assert.equal(F.relativeTime('2026-10-15T09:00:00Z', now), '3 h ago');
    assert.equal(F.relativeTime('2026-10-13T12:00:00Z', now), '2 d ago');
    assert.equal(F.relativeTime('bad', now), '');
});
