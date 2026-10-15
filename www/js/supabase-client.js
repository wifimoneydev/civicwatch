// Creates the single shared Supabase client for the app.
// If config.js still has placeholders (or the library failed to load), the
// client is null and CivicWatch.backend.problem explains why; the rest of the
// UI keeps working.
(function () {
    'use strict';

    var app = (window.CivicWatch = window.CivicWatch || {});
    var check = window.CivicWatchConfigCheck.validateConfig(window.CIVICWATCH_CONFIG);
    var problem = check.ok ? null : check.errors.join(' ');
    var client = null;
    var storageKey = null;
    var hadStoredSession = false;

    if (!problem && !(window.supabase && typeof window.supabase.createClient === 'function')) {
        problem = 'The Supabase library failed to load.';
    }

    if (!problem) {
        // Same key supabase-js would derive by default, set explicitly so the
        // app can tell whether a session was stored before the client starts.
        storageKey = 'sb-' + new URL(check.url).hostname.split('.')[0] + '-auth-token';
        try {
            hadStoredSession = window.localStorage.getItem(storageKey) !== null;
        } catch (e) {
            hadStoredSession = false;
        }
        try {
            client = window.supabase.createClient(check.url, check.key, {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: false,
                    storageKey: storageKey
                }
            });
        } catch (e) {
            problem = 'Could not create the Supabase client: ' + e.message;
        }
    }

    app.backend = {
        client: client,
        configured: check.configured,
        problem: problem,
        hadStoredSession: hadStoredSession,
        PHOTO_BUCKET: 'incident-photos'
    };

    // Use this everywhere instead of touching window.supabase directly.
    app.getSupabase = function () {
        if (!client) throw new Error(problem || 'Supabase is not configured.');
        return client;
    };
})();
