// Feed screen, incident details, in-app notifications and the Realtime
// subscription. app.js owns routing and calls start()/stop() around sessions.
(function () {
    'use strict';

    var F = window.CivicWatchFeed;
    var R = window.CivicWatchReport;
    var $ = function (id) { return document.getElementById(id); };
    var TOAST_MS = 10000;

    var deps = null;
    var feed = null;
    var notifier = null;
    var subscription = null;
    var live = 'off';            // off | connecting | live | error | closed
    var needsCatchUp = false;    // connection dropped: refresh once it is back
    var items = {};              // report id -> list item element (reused between renders)
    var detailToken = 0;
    var toastTimer = null;
    var toastExtra = 0;

    // ------------------------------------------------------------ shared item

    function publicUrl(photoPath) {
        return deps.client.storage.from(deps.photoBucket).getPublicUrl(photoPath).data.publicUrl;
    }

    function statusBadge(status) {
        var badge = document.createElement('span');
        badge.className = 'badge badge-' + status;
        badge.textContent = status === 'verified' ? 'Verified' : status === 'rejected' ? 'Rejected' : 'Unverified';
        return badge;
    }

    // A tappable report summary. Built with textContent only: report text is
    // user input. opts.showCoords adds the coordinates (My Reports).
    function buildReportItem(row, opts) {
        opts = opts || {};
        var li = document.createElement('li');
        li.className = 'report-item';
        var link = document.createElement('a');
        link.className = 'report-link';
        link.href = '#/incident/' + encodeURIComponent(row.id);
        if (row.photo_path) {
            var img = document.createElement('img');
            img.className = 'report-photo';
            img.alt = '';
            img.loading = 'lazy';
            img.onerror = function () { img.remove(); };
            img.src = publicUrl(row.photo_path);
            link.appendChild(img);
        }
        var title = document.createElement('h3');
        title.textContent = row.title;
        var meta = document.createElement('p');
        meta.className = 'muted';
        var when = opts.absoluteTime
            ? new Date(row.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
            : F.relativeTime(row.created_at);
        meta.textContent = R.categoryLabel(row.category) + ' · ' + when;
        meta.title = new Date(row.created_at).toLocaleString();
        link.appendChild(title);
        link.appendChild(meta);
        if (opts.showCoords) {
            var coords = document.createElement('p');
            coords.className = 'muted coords-text';
            coords.textContent = Number(row.latitude).toFixed(5) + ', ' + Number(row.longitude).toFixed(5) +
                (row.location_source === 'gps' ? ' (GPS)' : ' (entered manually)');
            link.appendChild(coords);
        }
        link.appendChild(statusBadge(row.verification_status));
        li.appendChild(link);
        return li;
    }

    // ------------------------------------------------------------ feed

    function errorText(error) {
        return deps.isNetworkError(error) ? "Can't reach the server. Check your internet connection." : 'Reports could not be loaded.';
    }

    function renderFeed(s) {
        if (s.error && deps.isExpiredError(s.error, s.lastStatus)) { deps.onSessionExpired(); return; }

        Array.prototype.forEach.call($('feed-filters').children, function (chip) {
            var active = chip.getAttribute('data-category') === s.category;
            chip.classList.toggle('active', active);
            chip.setAttribute('aria-pressed', active ? 'true' : 'false');
        });

        var empty = s.loaded && !s.rows.length && !s.error && !s.loading;
        $('feed-loading').hidden = !(s.loading && !s.rows.length);
        $('feed-error').hidden = !(s.error && !s.rows.length);
        if (s.error && !s.rows.length) $('feed-error-text').textContent = errorText(s.error);
        $('feed-empty').hidden = !empty;
        if (empty) {
            var label = s.category === 'all' ? '' : R.categoryLabel(s.category) + ' ';
            $('feed-empty-title').textContent = 'No ' + label + 'reports yet';
            $('feed-empty-text').textContent = s.category === 'all'
                ? 'Nobody has reported an incident yet. Reports from all users appear here.'
                : 'Try another category, or check back later.';
        }

        var list = $('feed-list');
        var keep = {};
        s.rows.forEach(function (row, i) {
            var li = items[row.id] || (items[row.id] = buildReportItem(row));
            keep[row.id] = true;
            if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
        });
        Object.keys(items).forEach(function (id) {
            if (!keep[id]) { items[id].remove(); delete items[id]; }
        });

        $('feed-more').hidden = !s.hasMore;
        $('feed-more').disabled = s.loadingMore;
        $('feed-more').textContent = s.loadingMore ? 'Loading…' : 'Load more';
        $('feed-more-error').textContent = s.moreError ? errorText(s.moreError)
            : (s.error && s.rows.length ? 'Could not refresh. ' + errorText(s.error) : '');
        $('feed-refresh').disabled = s.loading || s.refreshing;
        $('feed-refresh').textContent = s.loading || s.refreshing ? 'Refreshing…' : 'Refresh';
    }

    function setLive(status) {
        live = status;
        var el = $('feed-live');
        if (status === 'live') {
            el.className = 'live live-on';
            el.textContent = 'Live: new reports appear automatically';
            if (needsCatchUp && feed.getState().loaded) feed.refresh(); // fetch anything missed while offline
            needsCatchUp = false;
        } else if (status === 'connecting') {
            el.className = 'live live-connecting';
            el.textContent = 'Connecting to live updates…';
        } else {
            el.className = 'live live-off';
            el.textContent = 'Live updates unavailable. Tap Refresh to check for new reports.';
            needsCatchUp = true;
        }
    }

    function onInsert(row) {
        // Decide before adding: the filter must see the event exactly once.
        var notify = notifier.shouldNotify(row);
        feed.addRealtime(row);
        if (notify) showToast(row);
    }

    function subscribe() {
        if (subscription) subscription.stop();
        subscription = F.createIncidentSubscription(deps.client, { onInsert: onInsert, onStatus: setLive });
    }

    // ------------------------------------------------------------ notifications

    function showToast(row) {
        var visible = !$('toast').hidden;
        toastExtra = visible ? toastExtra + 1 : 0;
        $('toast-kicker').textContent = 'New ' + R.categoryLabel(row.category) + ' report' +
            (toastExtra ? ' · ' + toastExtra + ' more' : '');
        $('toast-title').textContent = row.title;
        $('toast').setAttribute('data-id', row.id);
        $('toast').hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(hideToast, TOAST_MS);
    }

    function hideToast() {
        clearTimeout(toastTimer);
        $('toast').hidden = true;
        $('toast').removeAttribute('data-id');
        toastExtra = 0;
    }

    // ------------------------------------------------------------ details

    function showIncident(id) {
        var token = ++detailToken;
        $('incident-article').hidden = true;
        $('incident-missing').hidden = true;
        $('incident-loading').hidden = false;
        F.fetchIncident(deps.client, id).then(function (res) {
            if (token !== detailToken) return; // a newer report was opened, or logged out
            $('incident-loading').hidden = true;
            if (res.error) {
                if (deps.isExpiredError(res.error, res.status)) { deps.onSessionExpired(); return; }
                $('incident-missing-title').textContent = "Couldn't load this report";
                $('incident-missing-text').textContent = errorText(res.error);
                $('incident-retry').hidden = false;
                $('incident-missing').hidden = false;
                return;
            }
            if (!res.row) {
                $('incident-missing-title').textContent = 'Report unavailable';
                $('incident-missing-text').textContent = 'This report does not exist or has been removed.';
                $('incident-retry').hidden = true;
                $('incident-missing').hidden = false;
                return;
            }
            renderIncident(res.row);
        }, function () {
            if (token !== detailToken) return;
            $('incident-loading').hidden = true;
            $('incident-missing-title').textContent = "Couldn't load this report";
            $('incident-missing-text').textContent = 'Something went wrong.';
            $('incident-retry').hidden = false;
            $('incident-missing').hidden = false;
        });
    }

    function renderIncident(row) {
        var img = $('incident-photo');
        $('incident-photo-error').hidden = true;
        img.onerror = null;
        img.removeAttribute('src');
        img.hidden = !row.photo_path;
        if (row.photo_path) {
            img.alt = 'Photo of the incident: ' + row.title;
            img.onerror = function () { img.hidden = true; $('incident-photo-error').hidden = false; };
            img.src = publicUrl(row.photo_path);
        }
        $('incident-category').textContent = R.categoryLabel(row.category);
        var badge = statusBadge(row.verification_status);
        $('incident-status').className = badge.className;
        $('incident-status').textContent = badge.textContent;
        $('incident-title').textContent = row.title;
        $('incident-time').textContent = 'Reported ' + new Date(row.created_at).toLocaleString(undefined,
            { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }) +
            ' (' + F.relativeTime(row.created_at) + ')';
        $('incident-description').textContent = row.description;
        $('incident-lat').textContent = Number(row.latitude).toFixed(6);
        $('incident-lng').textContent = Number(row.longitude).toFixed(6);
        $('incident-source').textContent = row.location_source === 'gps' ? 'GPS (phone location)' : 'Entered manually';
        var user = deps.getUser();
        $('incident-own').hidden = !(user && row.user_id === user.id);
        $('incident-article').hidden = false;
    }

    function clearIncident() {
        detailToken += 1;
        $('incident-article').hidden = true;
        $('incident-missing').hidden = true;
        $('incident-loading').hidden = true;
        ['incident-title', 'incident-description', 'incident-time', 'incident-lat', 'incident-lng',
            'incident-source', 'incident-category', 'incident-status'].forEach(function (id) { $(id).textContent = ''; });
        $('incident-photo').removeAttribute('src');
    }

    // ------------------------------------------------------------ public

    // After sign-in: subscribe to new reports. Notifications only cover
    // reports created from now on.
    function start() {
        stop();
        notifier.start(Date.now());
        subscribe();
    }

    // On logout / account change: drop the subscription and every trace of
    // the previous user's feed, details and notifications.
    function stop() {
        if (subscription) { subscription.stop(); subscription = null; }
        notifier.reset();
        feed.reset();
        hideToast();
        clearIncident();
        needsCatchUp = false;
        live = 'off';
        $('feed-live').className = 'live live-connecting';
        $('feed-live').textContent = 'Connecting to live updates…';
    }

    function showFeed() {
        var s = feed.getState();
        if (!s.loaded && !s.loading) feed.refresh();
        else if (live !== 'live' && !s.loading && !s.refreshing) feed.refresh(); // no live updates: re-check
    }

    // App came back to the foreground or the network returned.
    function resume() {
        if (!deps.getUser()) return;
        var s = feed.getState();
        if (s.loaded && !s.loading && !s.refreshing) feed.refresh();
        if (live !== 'live' && live !== 'connecting') subscribe();
    }

    function init(dependencies) {
        deps = dependencies;
        notifier = F.createNotificationFilter({ getUserId: function () { var u = deps.getUser(); return u && u.id; } });
        feed = F.createFeedController({
            fetchPage: function (category, cursor) { return F.fetchFeedPage(deps.client, category, cursor); },
            onChange: renderFeed
        });

        var filters = $('feed-filters');
        [{ value: 'all', label: 'All' }].concat(R.CATEGORIES).forEach(function (c) {
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'chip';
            chip.setAttribute('data-category', c.value);
            chip.textContent = c.label;
            chip.addEventListener('click', function () { feed.setCategory(c.value); });
            filters.appendChild(chip);
        });

        $('feed-refresh').addEventListener('click', function () { feed.refresh(); });
        $('feed-retry').addEventListener('click', function () { feed.refresh(); });
        $('feed-more').addEventListener('click', function () { feed.loadMore(); });
        $('incident-retry').addEventListener('click', function () {
            var m = location.hash.match(/^#\/incident\/(.+)$/);
            if (m) showIncident(decodeURIComponent(m[1]));
        });
        $('toast-open').addEventListener('click', function () {
            var id = $('toast').getAttribute('data-id');
            hideToast();
            if (id) deps.go('incident/' + id);
        });
        $('toast-close').addEventListener('click', hideToast);
        renderFeed(feed.getState());
    }

    window.CivicWatchFeedView = {
        init: init, start: start, stop: stop, showFeed: showFeed, showIncident: showIncident,
        resume: resume, buildReportItem: buildReportItem
    };
})();
