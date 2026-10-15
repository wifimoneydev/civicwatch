// End-to-end auth flow test: drives the real www/ app in headless Chrome via
// the DevTools protocol (no extra npm dependencies).
//
//   npm run test:e2e
//
// MOCK phase: Supabase responses are faked inside the browser (Fetch domain),
//   so signup / login / logout / restore / expiry can be exercised without
//   creating real accounts. Proves the UI logic, not the live server.
// LIVE phase: talks to the real project in www/js/config.js, but only with
//   requests that create no accounts and send no email (wrong password for a
//   non-existent address, an invalid stored session, route guards).

import crypto from 'node:crypto';
import {
    SUPABASE_URL, STORAGE_KEY, USERS, MOCK_PASSWORD, visibleExpr, openPage, installMock, installRealtimeShim, makeSession,
    count, isPasswordLogin, lastIncidents, tokenSubject, login, run,
} from './harness.mjs';

async function mockPhase({ cdp, base, check }) {
    console.log('\nMOCK phase (Supabase responses faked in the browser)');
    const page = await openPage(cdp);
    await installRealtimeShim(page);
    await page.send('Fetch.enable', { patterns: [{ urlPattern: `${SUPABASE_URL}/*` }] });
    const mock = installMock(page, cdp);
    const A = USERS['alice@example.test'];
    const B = USERS['bob@example.test'];

    await page.goto(`${base}/index.html`);
    check('fresh start shows the login screen', await page.waitFor(visibleExpr('form-login')));
    check('signed-in area is hidden', !(await page.visible('screen-main')));

    await page.eval("location.hash = '#/my-reports'");
    await page.waitFor("location.hash === '#/login'");
    check('My Reports is protected (redirects to login)', (await page.hash()) === '#/login' && !(await page.visible('screen-main')));
    await page.eval("location.hash = '#/report'");
    await page.waitFor("location.hash === '#/login'");
    check('Report is protected (redirects to login)', (await page.hash()) === '#/login');

    await page.click('login-submit');
    check('empty login shows field errors', (await page.text('login-email-error')) === 'Enter your email address.'
        && (await page.text('login-password-error')) === 'Enter your password.');
    check('invalid form sends no request', count(mock, isPasswordLogin) === 0);

    await login(page, A.email, 'wrong-password');
    check('incorrect password shows a readable error',
        await page.waitFor("document.getElementById('login-error').textContent.includes('Email or password is incorrect')"),
        await page.text('login-error'));
    check('password field is cleared after a failed login', (await page.eval("document.getElementById('login-password').value")) === '');

    const before = count(mock, isPasswordLogin);
    await page.fill('login-email', A.email);
    await page.fill('login-password', MOCK_PASSWORD);
    await page.eval(`(() => { const f = document.getElementById('form-login');
        f.requestSubmit(); f.requestSubmit(); document.getElementById('login-submit').click(); })()`);
    check('button shows a loading state while signing in',
        (await page.eval("document.getElementById('login-submit').disabled")) === true
        && (await page.text('login-submit')) === 'Logging in…');
    check('login lands on the feed', await page.waitFor(`${visibleExpr('view-feed')} && location.hash === '#/feed'`));
    check('rapid repeated submits send exactly one login request', count(mock, isPasswordLogin) - before === 1,
        `sent ${count(mock, isPasswordLogin) - before}`);
    check('credentials are not left in the hidden login form',
        (await page.eval("document.getElementById('login-password').value")) === '');

    await page.eval("location.hash = '#/my-reports'");
    check('My Reports shows the empty state', await page.waitFor(visibleExpr('my-reports-empty')));
    let q = lastIncidents(mock);
    check("My Reports queries only Alice's reports", q && q.url.includes(`user_id=eq.${A.id}`), q && q.url);
    check("My Reports request uses Alice's access token", q && tokenSubject(q.auth) === A.id, q && q.auth.slice(0, 20));

    await page.eval("location.hash = '#/profile'");
    await page.waitFor(visibleExpr('view-profile'));
    check('profile shows the signed-in email', (await page.text('profile-email')) === A.email);

    await page.eval("location.hash = '#/my-reports'");
    await page.waitFor(visibleExpr('my-reports-empty'));
    await page.eval("document.dispatchEvent(new Event('backbutton'))");
    check('Android back button returns to the feed', await page.waitFor("location.hash === '#/feed'"));

    const loginsBeforeReload = count(mock, isPasswordLogin);
    const loadBefore = await page.loads();
    await page.goto(`${base}/index.html#/feed`);
    check('page was genuinely reloaded', (await page.loads()) !== loadBefore);
    check('session is restored after an app restart (reload)', await page.waitFor(visibleExpr('view-feed')));
    check('restoring does not re-send the password', count(mock, isPasswordLogin) === loginsBeforeReload);

    await page.eval("location.hash = '#/profile'");
    await page.waitFor(visibleExpr('logout-button'));
    await page.click('logout-button');
    check('logout returns to the login screen', await page.waitFor(visibleExpr('form-login')));
    check('logout calls the Supabase logout endpoint', count(mock, (e) => e.key === 'POST /auth/v1/logout') >= 1);
    check('logout removes the stored session', !(await page.storageHasSession()));
    check("logout clears Alice's profile and report views",
        (await page.text('profile-email')) === '' && (await page.text('my-reports-list')) === '');

    await page.goto(`${base}/index.html`);
    check('after logout + restart the app stays logged out', await page.waitFor(visibleExpr('form-login')));

    await login(page, B.email, MOCK_PASSWORD);
    await page.waitFor(visibleExpr('view-feed'));
    await page.eval("location.hash = '#/my-reports'");
    await page.waitFor(visibleExpr('my-reports-empty'));
    q = lastIncidents(mock);
    check("second account's My Reports queries only Bob's reports", q && q.url.includes(`user_id=eq.${B.id}`) && !q.url.includes(A.id), q && q.url);
    check("second account's request uses Bob's token, not Alice's", q && tokenSubject(q.auth) === B.id);
    await page.eval("location.hash = '#/profile'");
    await page.waitFor(visibleExpr('view-profile'));
    check('profile shows the second account, not the first', (await page.text('profile-email')) === B.email);

    mock.incidentsMode = '401';
    await page.eval("location.hash = '#/my-reports'");
    check('a 401 from the API signs out with an "expired" message',
        await page.waitFor(`${visibleExpr('form-login')} && document.getElementById('banner-text').textContent.includes('expired')`));
    check('the stored session is removed after a 401', !(await page.storageHasSession()));
    mock.incidentsMode = 'ok';

    const expired = makeSession(A, -60);
    await page.eval(`localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(expired))})`);
    mock.refreshMode = 'reject';
    await page.goto(`${base}/index.html#/feed`);
    check('expired session + rejected refresh -> login with "expired" message',
        await page.waitFor(`${visibleExpr('form-login')} && document.getElementById('banner-text').textContent.includes('expired')`));
    check('rejected refresh removes the stored session', !(await page.storageHasSession()));

    await page.eval(`localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(expired))})`);
    mock.refreshMode = 'network';
    await page.goto(`${base}/index.html#/feed`);
    check('network failure: "still trying" message while supabase-js retries',
        await page.waitFor("document.getElementById('loading-text').textContent.includes('Still trying')", '', 10000));
    check('network failure while restoring shows Retry, not protected screens',
        await page.waitFor(`${visibleExpr('loading-retry')} && !${visibleExpr('screen-main')}`, '', 45000),
        await page.text('loading-text'));
    check('the stored session is kept for a retry', await page.storageHasSession());
    mock.refreshMode = 'ok';
    await page.click('loading-retry');
    check('Retry restores the session once the network is back', await page.waitFor(visibleExpr('view-feed')));

    await page.eval("location.hash = '#/profile'");
    await page.waitFor(visibleExpr('logout-button'));
    await page.click('logout-button');
    await page.waitFor(visibleExpr('form-login'));

    await page.send('Network.enable');
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await login(page, A.email, MOCK_PASSWORD);
    check('login while offline shows an offline message',
        await page.waitFor("document.getElementById('login-error').textContent.includes('offline')"), await page.text('login-error'));
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

    await page.eval("location.hash = '#/signup'");
    await page.waitFor(visibleExpr('form-signup'));
    const signupsBefore = count(mock, (e) => e.key === 'POST /auth/v1/signup');
    await page.fill('signup-email', 'confirm-new@example.test');
    await page.fill('signup-password', 'abcdefg1');
    await page.fill('signup-confirm', 'abcdefg2');
    await page.click('signup-submit');
    check('signup rejects mismatched passwords', (await page.text('signup-confirm-error')) === 'Passwords do not match.');
    await page.fill('signup-password', 'short1');
    await page.fill('signup-confirm', 'short1');
    await page.click('signup-submit');
    check('signup rejects short passwords', (await page.text('signup-password-error')).includes('at least 8'));
    check('invalid signup sends no request', count(mock, (e) => e.key === 'POST /auth/v1/signup') === signupsBefore);

    await page.fill('signup-password', 'abcdefg1');
    await page.fill('signup-confirm', 'abcdefg1');
    await page.click('signup-submit');
    check('signup button shows a loading state', (await page.text('signup-submit')) === 'Creating account…');
    check('confirmation ON: signup shows "Check your email"',
        await page.waitFor(`${visibleExpr('signup-done')} && document.getElementById('signup-done-text').textContent.includes('confirm-new@example.test')`));
    check('confirmation ON: user is NOT signed in', !(await page.visible('screen-main')) && !(await page.storageHasSession()));
    check('signup password fields are cleared', (await page.eval("document.getElementById('signup-password').value")) === '');
    await page.click('signup-done-login');
    await page.waitFor(visibleExpr('form-login'));
    check('login form is prefilled with the new email', (await page.eval("document.getElementById('login-email').value")) === 'confirm-new@example.test');

    await page.eval("location.hash = '#/signup'");
    await page.waitFor(visibleExpr('form-signup'));
    await page.fill('signup-email', 'instant@example.test');
    await page.fill('signup-password', 'abcdefg1');
    await page.fill('signup-confirm', 'abcdefg1');
    await page.click('signup-submit');
    check('confirmation OFF: signup signs in immediately', await page.waitFor(visibleExpr('view-feed')));
    check('confirmation OFF: welcome message shown', (await page.text('banner-text')).includes('Account created'));

    const unhandled = mock.log.filter((e) => !e.key.startsWith('OPTIONS ') && ![
        'POST /auth/v1/token', 'POST /auth/v1/signup', 'POST /auth/v1/logout', 'GET /rest/v1/incidents',
    ].includes(e.key)).map((e) => e.key);
    check('no unexpected backend calls', unhandled.length === 0, unhandled.join(', '));
}

async function livePhase({ cdp, base, check }) {
    console.log(`\nLIVE phase (${SUPABASE_URL}; no accounts created, no email sent)`);
    const page = await openPage(cdp);
    await page.goto(`${base}/index.html`);
    check('live: fresh start shows the login screen', await page.waitFor(visibleExpr('form-login')));

    const email = `cw-e2e-${crypto.randomUUID().slice(0, 8)}@example.invalid`;
    await login(page, email, `Wrong-${crypto.randomUUID()}`);
    check('live: wrong credentials -> "Email or password is incorrect."',
        await page.waitFor("document.getElementById('login-error').textContent === 'Email or password is incorrect.'", '', 15000),
        await page.text('login-error'));
    check('live: not signed in after the failed attempt', !(await page.visible('screen-main')) && !(await page.storageHasSession()));

    const bogus = makeSession({ id: crypto.randomUUID(), email }, -60);
    await page.eval(`localStorage.setItem(${JSON.stringify(STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(bogus))})`);
    await page.goto(`${base}/index.html#/my-reports`);
    check('live: invalid stored session is rejected by Supabase -> login + "expired"',
        await page.waitFor(`${visibleExpr('form-login')} && document.getElementById('banner-text').textContent.includes('expired')`, '', 15000));
    check('live: rejected session is removed from storage', !(await page.storageHasSession()));
    check('live: protected route redirected to login', (await page.hash()) === '#/login');
}

await run(process.argv.includes('--mock-only') ? [mockPhase] : [mockPhase, livePhase]);
