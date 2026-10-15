// Validates the Supabase settings in config.js. Shared by the app (browser
// global) and by the Node unit tests / connection check (CommonJS).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CivicWatchConfigCheck = factory();
})(this, function () {
    'use strict';

    var PLACEHOLDERS = ['YOUR_SUPABASE_URL', 'YOUR_SUPABASE_PUBLISHABLE_KEY'];
    var URL_PATTERN = /^https:\/\/[a-z0-9]{20}\.supabase\.co$/;

    function decodeJwtRole(token) {
        try {
            var part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
            var json = typeof atob === 'function'
                ? atob(part)
                : Buffer.from(part, 'base64').toString('utf8');
            return JSON.parse(json).role || null;
        } catch (e) {
            return null;
        }
    }

    function isBlank(value) {
        return typeof value !== 'string' || value.trim() === '' || PLACEHOLDERS.indexOf(value.trim()) !== -1;
    }

    // Returns { ok, configured, errors, url, key }.
    // configured === false means the placeholders have not been replaced yet.
    function validateConfig(cfg) {
        cfg = cfg || {};
        var errors = [];
        var url = typeof cfg.SUPABASE_URL === 'string' ? cfg.SUPABASE_URL.trim().replace(/\/+$/, '') : '';
        var key = typeof cfg.SUPABASE_PUBLISHABLE_KEY === 'string' ? cfg.SUPABASE_PUBLISHABLE_KEY.trim() : '';
        var configured = !isBlank(cfg.SUPABASE_URL) && !isBlank(cfg.SUPABASE_PUBLISHABLE_KEY);

        if (isBlank(cfg.SUPABASE_URL)) {
            errors.push('SUPABASE_URL is not set in www/js/config.js.');
        } else if (!URL_PATTERN.test(url)) {
            errors.push('SUPABASE_URL must look like https://<project-ref>.supabase.co');
        }

        if (isBlank(cfg.SUPABASE_PUBLISHABLE_KEY)) {
            errors.push('SUPABASE_PUBLISHABLE_KEY is not set in www/js/config.js.');
        } else if (key.indexOf('sb_secret_') === 0) {
            errors.push('SUPABASE_PUBLISHABLE_KEY is a SECRET key. Remove it now and use the publishable key.');
        } else if (/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/.test(key)) {
            var role = decodeJwtRole(key);
            if (role !== 'anon') {
                errors.push('SUPABASE_PUBLISHABLE_KEY is a "' + role + '" JWT. Only the publishable (or legacy anon) key may be used.');
            }
        } else if (key.indexOf('sb_publishable_') !== 0) {
            errors.push('SUPABASE_PUBLISHABLE_KEY should start with sb_publishable_');
        }

        return { ok: errors.length === 0, configured: configured, errors: errors, url: url, key: key };
    }

    return { validateConfig: validateConfig };
});
