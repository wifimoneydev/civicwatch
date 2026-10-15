// CivicWatch app shell: hash router, auth screens, route guards and the
// signed-in area. Depends on the modules loaded before it in index.html
// (session, my-reports, report-view, feed-view, diagnostics).
(function () {
    'use strict';

    var Auth = window.CivicWatchAuth;
    var backend = window.CivicWatch.backend;
    var $ = function (id) { return document.getElementById(id); };

    var PUBLIC_ROUTES = ['login', 'signup', 'diagnostics'];
    var PROTECTED_ROUTES = ['feed', 'report', 'my-reports', 'profile', 'incident'];
    var TITLES = { feed: 'Incidents', report: 'Report an incident', 'my-reports': 'My Reports', profile: 'Profile',
        incident: 'Incident' };

    var state = {
        phase: 'loading',      // loading | offline | ready | unconfigured
        user: null,
        busy: {},              // form/action name -> true while a request is in flight
        myReportsRequest: 0,   // increments to invalidate in-flight My Reports loads
        listRoute: 'feed'      // list a report was opened from (feed | my-reports)
    };

    var session = backend.client
        ? window.CivicWatchSession.createSessionController(backend.client, {
            onSignedIn: handleSignedIn,
            onSignedOut: handleSignedOut
        }, { hadStoredSession: backend.hadStoredSession })
        : null;

    // ---------------------------------------------------------------- helpers

    function showBanner(text, kind) {
        $('banner-text').textContent = text;
        $('banner').className = 'banner banner-' + (kind || 'info');
        $('banner').hidden = false;
    }

    function hideBanner() { $('banner').hidden = true; }

    function showScreen(name) {
        ['loading', 'auth', 'main', 'diagnostics'].forEach(function (n) {
            $('screen-' + n).hidden = n !== name;
        });
    }

    // "#/incident/<id>" -> 'incident' (id via incidentIdFromHash()).
    function routeFromHash() {
        var r = location.hash.replace(/^#\/?/, '');
        if (/^incident\/[^/]+$/.test(r)) return 'incident';
        return PUBLIC_ROUTES.indexOf(r) !== -1 || (PROTECTED_ROUTES.indexOf(r) !== -1 && r !== 'incident') || r === 'back' ? r : null;
    }

    function incidentIdFromHash() {
        var m = location.hash.match(/^#\/incident\/([^/]+)$/);
        return m ? decodeURIComponent(m[1]) : null;
    }

    function go(route) {
        if (location.hash === '#/' + route) render();
        else location.hash = '#/' + route;
    }

    function replaceRoute(route) {
        history.replaceState(null, '', '#/' + route);
    }

    function setBusy(name, busy, button, busyText) {
        state.busy[name] = busy;
        if (!button) return;
        if (busy) {
            button.dataset.label = button.textContent;
            button.textContent = busyText;
        } else if (button.dataset.label) {
            button.textContent = button.dataset.label;
        }
        button.disabled = busy;
        button.setAttribute('aria-busy', busy ? 'true' : 'false');
        var form = button.form;
        if (form) {
            Array.prototype.forEach.call(form.elements, function (el) {
                if (el !== button) el.disabled = busy;
            });
        }
    }

    function showFieldErrors(prefix, errors, fields) {
        fields.forEach(function (field) {
            var message = errors[field] || '';
            $(prefix + '-' + field + '-error').textContent = message;
            $(prefix + '-' + field).setAttribute('aria-invalid', message ? 'true' : 'false');
        });
        var first = fields.filter(function (f) { return errors[f]; })[0];
        if (first) $(prefix + '-' + first).focus();
    }

    function clearForm(prefix, fields) {
        $('form-' + prefix).reset();
        showFieldErrors(prefix, {}, fields);
        $(prefix + '-error').textContent = '';
    }

    function isOffline() { return navigator.onLine === false; }

    function formatDate(iso) {
        var d = new Date(iso);
        return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    }

    // ---------------------------------------------------------------- session events

    function handleSignedIn(user, previous) {
        if (previous && previous.id !== user.id) resetUserState();
        state.user = user;
        state.phase = 'ready';
        hideBanner();
        // Do not leave credentials sitting in the hidden auth forms.
        clearForm('login', ['email', 'password']);
        clearForm('signup', ['email', 'password', 'confirm']);
        window.CivicWatchFeedView.start();
        var route = routeFromHash();
        if (!route || route === 'login' || route === 'signup') go('feed');
        else render();
    }

    function handleSignedOut(reason) {
        resetUserState();
        state.phase = 'ready';
        if (reason === 'expired') showBanner('Your session has expired. Please log in again.', 'warning');
        go('login');
    }

    // Wipes everything tied to the previous account so the next person to sign
    // in on this device cannot see it.
    function resetUserState() {
        state.user = null;
        state.myReportsRequest += 1;
        state.listRoute = 'feed';
        window.CivicWatchFeedView.stop();
        if (backend.client) backend.client.removeAllChannels();
        $('my-reports-list').textContent = '';
        ['my-reports-loading', 'my-reports-error', 'my-reports-empty'].forEach(function (id) { $(id).hidden = true; });
        $('profile-email').textContent = '';
        $('profile-since').textContent = '';
        $('profile-error').textContent = '';
        clearForm('login', ['email', 'password']);
        clearForm('signup', ['email', 'password', 'confirm']);
        $('signup-done').hidden = true;
        window.CivicWatchReportView.reset();
    }

    // ---------------------------------------------------------------- rendering

    function render() {
        var route = routeFromHash();

        if (route === 'back') {
            replaceRoute(state.user ? 'profile' : 'login');
            route = state.user ? 'profile' : 'login';
        }

        if (route === 'diagnostics') {
            showScreen('diagnostics');
            window.CivicWatchDiagnostics.run();
            return;
        }

        if (state.phase === 'loading' || state.phase === 'offline') {
            showScreen('loading');
            return;
        }

        if (!state.user) {
            if (!route || PROTECTED_ROUTES.indexOf(route) !== -1) {
                route = 'login';
                replaceRoute(route);
            }
            renderAuth(route);
            return;
        }

        if (!route || route === 'login' || route === 'signup') {
            route = 'feed';
            replaceRoute(route);
        }
        renderMain(route);
    }

    function renderAuth(route) {
        showScreen('auth');
        var isSignup = route === 'signup';
        $('tab-login').classList.toggle('active', !isSignup);
        $('tab-signup').classList.toggle('active', isSignup);
        $('tab-login').setAttribute('aria-current', isSignup ? 'false' : 'page');
        $('tab-signup').setAttribute('aria-current', isSignup ? 'page' : 'false');
        $('form-login').hidden = isSignup;
        $('form-signup').hidden = !isSignup || !$('signup-done').hidden;
        if (!isSignup) $('signup-done').hidden = true;

        if (state.phase === 'unconfigured') {
            $('auth-config-error').textContent = 'The app is not connected to its server yet (' +
                backend.problem + '). Open App diagnostics for details.';
            $('auth-config-error').hidden = false;
            $('login-submit').disabled = true;
            $('signup-submit').disabled = true;
        }
    }

    function renderMain(route) {
        showScreen('main');
        if (route === 'feed' || route === 'my-reports') state.listRoute = route;
        $('view-title').textContent = TITLES[route];
        $('main-back').hidden = route !== 'incident';
        PROTECTED_ROUTES.forEach(function (r) { $('view-' + r).hidden = r !== route; });
        var tabRoute = route === 'incident' ? state.listRoute : route;
        Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
            var active = tab.getAttribute('data-route') === tabRoute;
            tab.classList.toggle('active', active);
            if (active) tab.setAttribute('aria-current', 'page');
            else tab.removeAttribute('aria-current');
        });

        if (route === 'feed') window.CivicWatchFeedView.showFeed();
        if (route === 'my-reports') loadMyReports();
        if (route === 'profile') renderProfile();
        if (route === 'incident') window.CivicWatchFeedView.showIncident(incidentIdFromHash());
    }

    function renderProfile() {
        $('profile-email').textContent = state.user.email || '';
        $('profile-since').textContent = formatDate(state.user.created_at);
    }

    function loadMyReports() {
        var userId = state.user.id;
        var request = ++state.myReportsRequest;
        $('my-reports-list').textContent = '';
        $('my-reports-error').hidden = true;
        $('my-reports-empty').hidden = true;
        $('my-reports-loading').hidden = false;

        window.CivicWatchMyReports.fetchMyReports(backend.client, userId).then(function (res) {
            // Ignore responses for a previous user or an older request.
            if (request !== state.myReportsRequest || !state.user || state.user.id !== userId) return;
            $('my-reports-loading').hidden = true;

            if (res.error) {
                if (Auth.isSessionExpiredError(res.error, res.status)) {
                    session.expire();
                    return;
                }
                $('my-reports-error-text').textContent = Auth.isNetworkError(res.error)
                    ? "Can't reach the server. Check your internet connection."
                    : 'Your reports could not be loaded.';
                $('my-reports-error').hidden = false;
                return;
            }
            if (res.rows.length === 0) {
                $('my-reports-empty').hidden = false;
                return;
            }
            res.rows.forEach(function (row) {
                $('my-reports-list').appendChild(window.CivicWatchFeedView.buildReportItem(row, { showCoords: true, absoluteTime: true }));
            });
        });
    }

    // ---------------------------------------------------------------- actions

    function onLoginSubmit(event) {
        event.preventDefault();
        if (state.busy.login || !session) return;
        $('login-error').textContent = '';
        var v = Auth.validateLogin({ email: $('login-email').value, password: $('login-password').value });
        showFieldErrors('login', v.errors, ['email', 'password']);
        if (!v.ok) return;
        if (isOffline()) {
            $('login-error').textContent = "You're offline. Connect to the internet and try again.";
            return;
        }
        setBusy('login', true, $('login-submit'), 'Logging in…');
        session.signIn(v.values.email, v.values.password).then(function (res) {
            setBusy('login', false, $('login-submit'));
            if (!res.ok) {
                $('login-error').textContent = Auth.friendlyAuthError(res.error);
                $('login-password').value = '';
            }
        });
    }

    function onSignupSubmit(event) {
        event.preventDefault();
        if (state.busy.signup || !session) return;
        $('signup-error').textContent = '';
        var v = Auth.validateSignup({
            email: $('signup-email').value,
            password: $('signup-password').value,
            confirm: $('signup-confirm').value
        });
        showFieldErrors('signup', v.errors, ['email', 'password', 'confirm']);
        if (!v.ok) return;
        if (isOffline()) {
            $('signup-error').textContent = "You're offline. Connect to the internet and try again.";
            return;
        }
        setBusy('signup', true, $('signup-submit'), 'Creating account…');
        session.signUp(v.values.email, v.values.password).then(function (res) {
            setBusy('signup', false, $('signup-submit'));
            if (res.status === 'error') {
                $('signup-error').textContent = Auth.friendlyAuthError(res.error);
                return;
            }
            if (res.status === 'confirm_email') {
                // No session was returned: the user is NOT signed in yet.
                clearForm('signup', ['email', 'password', 'confirm']);
                $('signup-done-text').textContent = 'We sent a confirmation link to ' + res.email +
                    '. Open it, then come back here and log in.';
                $('form-signup').hidden = true;
                $('signup-done').hidden = false;
                $('login-email').value = res.email;
                return;
            }
            showBanner('Account created. Welcome to CivicWatch!', 'success');
        });
    }

    function onLogout() {
        if (state.busy.logout || !session) return;
        setBusy('logout', true, $('logout-button'), 'Logging out…');
        session.signOut().then(function (res) {
            setBusy('logout', false, $('logout-button'));
            if (res.error) {
                showBanner('Logged out on this device. The server could not be reached to end the session everywhere.', 'warning');
            }
        });
    }

    function restoreSession() {
        state.phase = 'loading';
        $('loading-text').textContent = 'Restoring your session…';
        $('loading-retry').hidden = true;
        $('loading-spinner').hidden = false;
        render();

        // supabase-js retries a failed refresh for up to ~30 s before giving up.
        var slowTimer = setTimeout(function () {
            if (state.phase === 'loading') {
                $('loading-text').textContent = 'Still trying to reach the server… Check your internet connection.';
            }
        }, 6000);

        session.start().then(function (res) {
            clearTimeout(slowTimer);
            if (res.status === 'offline') {
                state.phase = 'offline';
                $('loading-spinner').hidden = true;
                $('loading-text').textContent = "Can't reach the server to restore your session. Check your internet connection.";
                $('loading-retry').hidden = false;
                render();
                return;
            }
            state.phase = 'ready';
            state.user = res.status === 'signed_in' ? res.user : null;
            if (state.user) window.CivicWatchFeedView.start();
            if (res.status === 'signed_out' && res.expired) {
                showBanner('Your session has expired. Please log in again.', 'warning');
            }
            render();
        });
    }

    function backToList() { go(state.listRoute || 'feed'); }

    // Android hardware back button.
    function onBackButton() {
        var route = routeFromHash();
        if (route === 'diagnostics') go('back');
        else if (state.user && route === 'incident') backToList();
        else if (state.user && route && route !== 'feed') go('feed');
        else if (!state.user && route === 'signup') go('login');
        else if (navigator.app && navigator.app.exitApp) navigator.app.exitApp();
    }

    // ---------------------------------------------------------------- start-up

    function init() {
        // Clear a field's error as soon as the user edits it.
        ['login-email', 'login-password', 'signup-email', 'signup-password', 'signup-confirm'].forEach(function (id) {
            $(id).addEventListener('input', function () {
                $(id + '-error').textContent = '';
                $(id).setAttribute('aria-invalid', 'false');
            });
        });
        $('form-login').addEventListener('submit', onLoginSubmit);
        $('form-signup').addEventListener('submit', onSignupSubmit);
        $('logout-button').addEventListener('click', onLogout);
        $('my-reports-retry').addEventListener('click', loadMyReports);
        // Reload rather than retry in place: supabase-js caches a failed token
        // refresh for 60 s, so an in-place retry would just repeat the failure.
        // Everything is bundled locally, so a reload is instant.
        $('loading-retry').addEventListener('click', function () { location.reload(); });
        $('banner-close').addEventListener('click', hideBanner);
        window.addEventListener('hashchange', render);
        document.addEventListener('backbutton', onBackButton, false);
        $('main-back').addEventListener('click', backToList);
        // Catch up after the app returns to the foreground or the network
        // comes back (Realtime does not replay missed events).
        var onResume = function () { if (state.user) window.CivicWatchFeedView.resume(); };
        document.addEventListener('resume', onResume, false); // Cordova
        document.addEventListener('visibilitychange', function () { if (!document.hidden) onResume(); });
        window.addEventListener('online', onResume);

        if (session) {
            window.CivicWatchFeedView.init({
                client: backend.client,
                photoBucket: backend.PHOTO_BUCKET,
                getUser: function () { return state.user; },
                go: go,
                isNetworkError: Auth.isNetworkError,
                isExpiredError: Auth.isSessionExpiredError,
                onSessionExpired: function () { session.expire(); }
            });
            window.CivicWatchReportView.init({
                client: backend.client,
                getUser: function () { return state.user; },
                isNetworkError: Auth.isNetworkError,
                isExpiredError: Auth.isSessionExpiredError,
                onSessionExpired: function () { session.expire(); },
                onSubmitted: function () {
                    showBanner('Report submitted. Other signed-in users can now see it, labelled unverified.', 'success');
                    go('my-reports'); // reloads the list from the database
                }
            });
        }

        if (!session) {
            state.phase = 'unconfigured';
            render();
            return;
        }
        restoreSession();
    }

    // In Cordova wait for deviceready (plugins + back button); in a desktop
    // browser cordova.js is absent and deviceready never fires.
    if (window.cordova) document.addEventListener('deviceready', init, false);
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
