// Form validation and readable error messages for authentication.
// Pure functions: shared by the app (browser global) and Node unit tests.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CivicWatchAuth = factory();
})(this, function () {
    'use strict';

    var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    var PASSWORD_MIN = 8;
    var PASSWORD_MAX = 72; // bcrypt limit used by Supabase Auth

    function normaliseEmail(email) {
        return typeof email === 'string' ? email.trim().toLowerCase() : '';
    }

    function emailError(email) {
        if (!email) return 'Enter your email address.';
        if (!EMAIL_PATTERN.test(email) || email.length > 254) return 'Enter a valid email address.';
        return null;
    }

    // Returns { ok, values, errors: { field: message } }.
    function validateLogin(input) {
        var email = normaliseEmail(input && input.email);
        var password = (input && input.password) || '';
        var errors = {};
        var e = emailError(email);
        if (e) errors.email = e;
        if (!password) errors.password = 'Enter your password.';
        return { ok: Object.keys(errors).length === 0, values: { email: email, password: password }, errors: errors };
    }

    function validateSignup(input) {
        var email = normaliseEmail(input && input.email);
        var password = (input && input.password) || '';
        var confirm = (input && input.confirm) || '';
        var errors = {};
        var e = emailError(email);
        if (e) errors.email = e;
        if (!password) errors.password = 'Choose a password.';
        else if (password.length < PASSWORD_MIN) errors.password = 'Use at least ' + PASSWORD_MIN + ' characters.';
        else if (password.length > PASSWORD_MAX) errors.password = 'Use at most ' + PASSWORD_MAX + ' characters.';
        else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) errors.password = 'Include at least one letter and one number.';
        if (!errors.password && confirm !== password) errors.confirm = 'Passwords do not match.';
        return { ok: Object.keys(errors).length === 0, values: { email: email, password: password }, errors: errors };
    }

    function messageOf(error) {
        return (error && (error.message || error.msg)) || String(error || '');
    }

    function isNetworkError(error) {
        if (!error) return false;
        if (error.name === 'AuthRetryableFetchError') return true;
        return /Failed to fetch|NetworkError|Network request failed|Load failed|fetch failed|ERR_INTERNET_DISCONNECTED/i
            .test(messageOf(error));
    }

    // Errors from data requests that mean the access token is no longer valid.
    function isSessionExpiredError(error, httpStatus) {
        if (!error) return false;
        if (error.code === 'PGRST301' || error.code === 'PGRST303') return true;
        if (httpStatus === 401) return true;
        return /JWT expired|invalid JWT|Invalid Refresh Token/i.test(messageOf(error));
    }

    var BY_CODE = {
        invalid_credentials: 'Email or password is incorrect.',
        email_not_confirmed: 'Please confirm your email first. Open the link we sent you, then log in.',
        user_already_exists: 'An account with this email already exists. Log in instead.',
        email_exists: 'An account with this email already exists. Log in instead.',
        weak_password: 'That password is too weak. Use at least 8 characters with letters and numbers.',
        email_address_invalid: 'That email address cannot be used. Try a different one.',
        over_email_send_rate_limit: 'Too many emails have been sent. Please wait a few minutes and try again.',
        over_request_rate_limit: 'Too many attempts. Please wait a moment and try again.',
        signup_disabled: 'New sign-ups are currently disabled.',
        email_provider_disabled: 'Email sign-in is currently disabled.',
        refresh_token_not_found: 'Your session has expired. Please log in again.',
        refresh_token_already_used: 'Your session has expired. Please log in again.',
        session_expired: 'Your session has expired. Please log in again.',
        session_not_found: 'Your session has expired. Please log in again.'
    };

    function friendlyAuthError(error) {
        if (!error) return '';
        if (isNetworkError(error)) return "Can't reach the server. Check your internet connection and try again.";
        if (error.code && BY_CODE[error.code]) return BY_CODE[error.code];
        var msg = messageOf(error);
        if (/Invalid login credentials/i.test(msg)) return BY_CODE.invalid_credentials;
        if (/Email not confirmed/i.test(msg)) return BY_CODE.email_not_confirmed;
        if (/already registered/i.test(msg)) return BY_CODE.user_already_exists;
        if (/rate limit/i.test(msg)) return BY_CODE.over_request_rate_limit;
        if (/Password should/i.test(msg)) return msg;
        if (error.status >= 500) return 'The server had a problem. Please try again shortly.';
        return 'Something went wrong. Please try again.';
    }

    return {
        PASSWORD_MIN: PASSWORD_MIN,
        validateLogin: validateLogin,
        validateSignup: validateSignup,
        friendlyAuthError: friendlyAuthError,
        isNetworkError: isNetworkError,
        isSessionExpiredError: isSessionExpiredError
    };
});
