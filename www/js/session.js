// Session controller: wraps supabase.auth so the UI has one place that knows
// who is signed in. Works with any object exposing the supabase-js auth API,
// which lets the unit tests drive it with a fake client.
//
// hooks.onSignedIn(user, previousUser)  - a (different) user is now signed in
// hooks.onSignedOut(reason)             - reason: 'user' (pressed log out) or
//                                         'expired' (session ended by itself)
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./auth-logic.js'));
    else root.CivicWatchSession = factory(root.CivicWatchAuth);
})(this, function (Auth) {
    'use strict';

    // options.hadStoredSession: a session existed in storage when the app
    // launched, so if none can be restored it has expired.
    function createSessionController(client, hooks, options) {
        var hadStoredSession = !!(options && options.hadStoredSession);
        var user = null;
        var listening = false;
        var userSigningOut = false;
        // Incremented by every start/sign-in/sign-up/sign-out. Auth events are
        // handled asynchronously, so an event emitted during an earlier action
        // (e.g. SIGNED_IN for the previous account) must not be applied after
        // a newer action has already changed who is signed in.
        var epoch = 0;
        // supabase-js refreshes an expired stored session while it starts up;
        // if that refresh is rejected it deletes the session and emits
        // SIGNED_OUT before getSession() resolves. Remember that, so start()
        // can say "expired" instead of silently showing the login screen.
        var restoring = false;
        var storedSessionEnded = false;

        function applySession(session) {
            if (!session || !session.user) return;
            var previous = user;
            user = session.user;
            if (!previous || previous.id !== user.id) hooks.onSignedIn(user, previous);
        }

        function endSession(reason) {
            if (!user) return;
            user = null;
            hooks.onSignedOut(reason);
        }

        function onAuthEvent(event, session) {
            if (event === 'INITIAL_SESSION') return; // handled by start()
            if (session && session.user) applySession(session);
            else if (event === 'SIGNED_OUT') endSession(userSigningOut ? 'user' : 'expired');
        }

        // Restores a stored session (refreshing it if needed) before any
        // protected screen is shown. Resolves to:
        //   { status: 'signed_in', user } | { status: 'signed_out', expired }
        //   | { status: 'offline', error }  (session kept; call start() again)
        async function start() {
            epoch += 1;
            if (!listening) {
                // Defer handling: supabase-js warns against calling auth
                // methods synchronously inside this callback.
                client.auth.onAuthStateChange(function (event, session) {
                    if (restoring && event === 'SIGNED_OUT') storedSessionEnded = true;
                    var emittedIn = epoch;
                    setTimeout(function () {
                        if (emittedIn === epoch) onAuthEvent(event, session);
                    }, 0);
                });
                listening = true;
            }
            var result;
            restoring = true;
            storedSessionEnded = false;
            try {
                result = await client.auth.getSession();
            } catch (e) {
                result = { data: { session: null }, error: e };
            } finally {
                restoring = false;
            }
            var session = result && result.data && result.data.session;
            if (session && session.user) {
                user = session.user;
                return { status: 'signed_in', user: user };
            }
            user = null;
            if (result && result.error && Auth.isNetworkError(result.error)) {
                return { status: 'offline', error: result.error };
            }
            var expired = !!(result && result.error) || storedSessionEnded || hadStoredSession;
            hadStoredSession = false; // only meaningful for the first restore
            return { status: 'signed_out', expired: expired };
        }

        async function signIn(email, password) {
            epoch += 1;
            try {
                var res = await client.auth.signInWithPassword({ email: email, password: password });
                if (res.error) return { ok: false, error: res.error };
                applySession(res.data.session);
                return { ok: true, user: res.data.user };
            } catch (e) {
                return { ok: false, error: e };
            }
        }

        // With email confirmation ON, Supabase returns a user but NO session:
        // the user is not signed in until they confirm and log in.
        async function signUp(email, password) {
            epoch += 1;
            try {
                var res = await client.auth.signUp({ email: email, password: password });
                if (res.error) return { status: 'error', error: res.error };
                if (res.data && res.data.session) {
                    applySession(res.data.session);
                    return { status: 'signed_in', user: res.data.session.user };
                }
                return { status: 'confirm_email', email: email };
            } catch (e) {
                return { status: 'error', error: e };
            }
        }

        // Always ends the local session, even if the server cannot be reached.
        async function signOut() {
            epoch += 1;
            userSigningOut = true;
            var error = null;
            try {
                var res = await client.auth.signOut();
                error = res && res.error;
                if (error) await client.auth.signOut({ scope: 'local' });
            } catch (e) {
                error = e;
                try { await client.auth.signOut({ scope: 'local' }); } catch (ignored) { /* already local-only */ }
            } finally {
                endSession('user');
                userSigningOut = false;
            }
            return { error: error };
        }

        // Called when a data request is rejected because the token is invalid.
        async function expire() {
            if (!user) return;
            epoch += 1;
            try { await client.auth.signOut({ scope: 'local' }); } catch (ignored) { /* best effort */ }
            endSession('expired');
        }

        return {
            start: start,
            signIn: signIn,
            signUp: signUp,
            signOut: signOut,
            expire: expire,
            getUser: function () { return user; }
        };
    }

    return { createSessionController: createSessionController };
});
