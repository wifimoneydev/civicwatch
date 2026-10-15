// Diagnostics screen: confirms the APK runs, native plugins load and the
// backend is reachable. Reachable from the login screen and Profile.
(function () {
    'use strict';

    function mark(id, state, text) {
        var el = document.getElementById(id);
        el.textContent = text;
        el.className = state === true ? 'ok' : state === false ? 'fail' : 'muted';
    }

    // Translate Supabase/PostgREST errors into something actionable.
    function describeBackendError(error) {
        var msg = (error && error.message) || String(error);
        if (error && error.code === 'PGRST205') return 'incidents table not found: run the SQL setup';
        if (error && error.code === '42501') return 'permission denied: re-run the SQL setup';
        if (/Invalid API key|No API key/i.test(msg)) return 'API key rejected: check config.js';
        if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'network error (offline or blocked)';
        return msg;
    }

    function checkBackend() {
        var backend = window.CivicWatch && window.CivicWatch.backend;
        if (!backend) {
            mark('chk-config', false, 'client script missing');
            mark('chk-backend', false, 'skipped');
            return;
        }
        if (!backend.client) {
            mark('chk-config', false, backend.configured ? backend.problem : 'not set: edit www/js/config.js');
            mark('chk-backend', false, 'skipped');
            return;
        }
        mark('chk-config', true, 'ok');
        mark('chk-backend', null, 'checking…');

        // Any non-error response proves the URL, key, Data API and incidents
        // table are reachable (signed out, RLS returns zero rows).
        backend.client.from('incidents').select('id').limit(1).then(function (res) {
            if (res.error) mark('chk-backend', false, describeBackendError(res.error));
            else mark('chk-backend', true, 'connected');
        }, function (err) {
            mark('chk-backend', false, describeBackendError(err));
        });
    }

    function buildLabel() {
        var b = window.CIVICWATCH_BUILD || {};
        return (b.version || '?') + ' · commit ' + (b.commit || '?') + (b.run ? ' · CI run ' + b.run : '') +
            (b.builtAt ? ' · built ' + b.builtAt : '');
    }

    function run() {
        var isCordova = !!window.cordova;
        mark('chk-version', true, buildLabel());
        mark('chk-ready', isCordova, isCordova ? 'fired' : 'not running in Cordova (browser)');
        mark('chk-platform', true, (window.cordova && window.cordova.platformId) || 'browser');
        mark('chk-camera', !!navigator.camera, navigator.camera ? 'available' : 'not available');
        mark('chk-geo', 'geolocation' in navigator, 'geolocation' in navigator ? 'available' : 'not available');
        checkBackend();
    }

    window.CivicWatchDiagnostics = { run: run, buildLabel: buildLabel };
})();
