// Shared incident feed: queries, pagination/category state, incident lookup,
// Realtime subscription and the in-app notification filter.
// Pure logic with injected dependencies, shared by the app and Node tests.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CivicWatchFeed = factory();
})(this, function () {
    'use strict';

    var PAGE_SIZE = 10;
    var LIST_COLUMNS = 'id, user_id, title, category, photo_path, verification_status, created_at';
    var DETAIL_COLUMNS = 'id, user_id, title, description, category, latitude, longitude, location_source, photo_path, verification_status, created_at';
    var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    function newestFirst(a, b) {
        if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    }

    var TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ][0-9:.]+(Z|[+-]\d{2}(:?\d{2})?)?$/;

    // Keyset filter for "rows after the cursor" in (created_at desc, id desc)
    // order: older timestamp, or the same timestamp with a smaller id. Exact
    // even when many rows share a timestamp. Values are validated before being
    // placed in the PostgREST filter string.
    function afterCursor(cursor) {
        if (!TIMESTAMP.test(cursor.created_at) || !UUID.test(cursor.id)) throw new Error('invalid feed cursor');
        var ts = '"' + cursor.created_at + '"';
        return 'created_at.lt.' + ts + ',and(created_at.eq.' + ts + ',id.lt.' + cursor.id + ')';
    }

    // One page of the feed, filtered in the database. `cursor` is the last row
    // already shown. Fetches one extra row to know whether there is a next page.
    async function fetchFeedPage(client, category, cursor, pageSize) {
        var size = pageSize || PAGE_SIZE;
        var q = client.from('incidents').select(LIST_COLUMNS);
        if (category && category !== 'all') q = q.eq('category', category);
        if (cursor) q = q.or(afterCursor(cursor));
        var res = await q
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .limit(size + 1);
        if (res.error) return { rows: [], error: res.error, status: res.status };
        return { rows: res.data || [], error: null, status: res.status };
    }

    // Resolves to { row } | { row: null } (not found) | { error, status }.
    async function fetchIncident(client, id) {
        if (!UUID.test(String(id || ''))) return { row: null };
        var res = await client.from('incidents').select(DETAIL_COLUMNS).eq('id', id).maybeSingle();
        if (res.error) return { row: null, error: res.error, status: res.status };
        return { row: res.data || null };
    }

    // Feed state. fetchPage(category, cursor) -> Promise<{ rows, error, status }>.
    // Every reset (category change / refresh) invalidates older in-flight
    // requests, so a slow response can never show the wrong category.
    function createFeedController(options) {
        var fetchPage = options.fetchPage;
        var pageSize = options.pageSize || PAGE_SIZE;
        var onChange = options.onChange || function () {};
        var token = 0;
        var s;

        function initial(category) {
            return { category: category || 'all', rows: [], hasMore: false, loaded: false,
                loading: false, refreshing: false, loadingMore: false, error: null, moreError: null, lastStatus: undefined };
        }
        s = initial();

        function snapshot() {
            return { category: s.category, rows: s.rows.slice(), hasMore: s.hasMore, loaded: s.loaded,
                loading: s.loading, refreshing: s.refreshing, loadingMore: s.loadingMore,
                error: s.error, moreError: s.moreError, lastStatus: s.lastStatus };
        }

        function emit() { onChange(snapshot()); }

        function merge(existing, incoming) {
            var seen = {};
            var out = [];
            existing.concat(incoming).forEach(function (row) {
                if (!seen[row.id]) { seen[row.id] = true; out.push(row); }
            });
            return out.sort(newestFirst);
        }

        // Reloads the first page for the current category.
        function refresh() {
            var mine = ++token;
            s.error = null;
            s.moreError = null;
            s.loadingMore = false;
            if (s.rows.length) s.refreshing = true; else s.loading = true;
            emit();
            return fetchPage(s.category, null).then(function (res) {
                if (mine !== token) return;
                s.loading = false;
                s.refreshing = false;
                s.lastStatus = res.status;
                if (res.error) { s.error = res.error; emit(); return; }
                s.rows = res.rows.slice(0, pageSize).sort(newestFirst);
                s.hasMore = res.rows.length > pageSize;
                s.loaded = true;
                emit();
            });
        }

        function setCategory(category) {
            if (category === s.category && (s.loaded || s.loading)) return Promise.resolve();
            s = initial(category);
            return refresh();
        }

        function loadMore() {
            if (!s.hasMore || s.loadingMore || s.loading || s.refreshing || !s.rows.length) return Promise.resolve();
            var mine = token;
            var cursor = s.rows[s.rows.length - 1];
            var before = s.rows.length;
            s.loadingMore = true;
            s.moreError = null;
            emit();
            return fetchPage(s.category, cursor).then(function (res) {
                if (mine !== token) return;
                s.loadingMore = false;
                s.lastStatus = res.status;
                if (res.error) { s.moreError = res.error; emit(); return; }
                s.rows = merge(s.rows, res.rows.slice(0, pageSize));
                // A further page exists if the extra row came back and this
                // request actually advanced the list.
                s.hasMore = res.rows.length > pageSize && s.rows.length > before;
                emit();
            });
        }

        // Adds a row received from Realtime. Returns true if the list changed.
        function addRealtime(row) {
            if (!row || !row.id || !s.loaded) return false;
            if (s.category !== 'all' && row.category !== s.category) return false;
            if (has(row.id)) return false;
            s.rows = merge(s.rows, [row]);
            emit();
            return true;
        }

        function has(id) {
            return s.rows.some(function (r) { return r.id === id; });
        }

        function reset() {
            token += 1;
            s = initial();
            emit();
        }

        return {
            refresh: refresh, setCategory: setCategory, loadMore: loadMore, addRealtime: addRealtime,
            has: has, reset: reset, getState: snapshot
        };
    }

    // Decides whether a Realtime insert deserves an in-app notification:
    // not the user's own report, not already notified (duplicate events), and
    // not older than the subscription (no alerts for existing reports).
    function createNotificationFilter(options) {
        var getUserId = options.getUserId;
        var notified = {};
        var since = null;
        var SKEW_MS = 2 * 60 * 1000; // tolerate device/server clock differences
        return {
            start: function (now) { since = now == null ? Date.now() : now; },
            reset: function () { notified = {}; since = null; },
            shouldNotify: function (row) {
                if (!row || !row.id || since === null) return false;
                if (notified[row.id]) return false;
                notified[row.id] = true;
                if (row.user_id && row.user_id === getUserId()) return false;
                var created = Date.parse(row.created_at);
                if (isFinite(created) && created < since - SKEW_MS) return false;
                return true;
            }
        };
    }

    // Subscribes to new incidents. Status: 'connecting' | 'live' | 'error' | 'closed'.
    // stop() removes the channel and silences any late callbacks.
    function createIncidentSubscription(client, handlers) {
        var active = true;
        var name = 'incidents-feed-' + Math.random().toString(36).slice(2, 10);
        var channel = client.channel(name);
        handlers.onStatus('connecting');
        channel
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'incidents' }, function (payload) {
                if (active && payload && payload.new) handlers.onInsert(payload.new);
            })
            .subscribe(function (status, err) {
                if (!active) return;
                if (status === 'SUBSCRIBED') handlers.onStatus('live');
                else if (status === 'CLOSED') handlers.onStatus('closed');
                else handlers.onStatus('error', err);
            });
        return {
            stop: function () {
                if (!active) return;
                active = false;
                client.removeChannel(channel);
            },
            isActive: function () { return active; }
        };
    }

    function relativeTime(iso, now) {
        var t = Date.parse(iso);
        if (!isFinite(t)) return '';
        var diff = Math.max(0, (now == null ? Date.now() : now) - t) / 1000;
        if (diff < 60) return 'just now';
        if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
        if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
        if (diff < 7 * 86400) return Math.floor(diff / 86400) + ' d ago';
        return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    return {
        PAGE_SIZE: PAGE_SIZE,
        fetchFeedPage: fetchFeedPage,
        fetchIncident: fetchIncident,
        createFeedController: createFeedController,
        createNotificationFilter: createNotificationFilter,
        createIncidentSubscription: createIncidentSubscription,
        relativeTime: relativeTime,
        newestFirst: newestFirst
    };
});
