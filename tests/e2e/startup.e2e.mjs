// Start-up behaviour as on an Android device: cordova.js present and the app
// starting on deviceready (fake cordova.js from the harness).
//   npm run test:e2e:startup
//
// MOCKED Supabase. Checks that normal start-up restores the session and shows
// login or the feed, never diagnostics, including with an old #/diagnostics
// hash, and that diagnostics stays reachable and shows the build.

import { USERS, MOCK_PASSWORD, visibleExpr, openPage, installMock, installRealtimeShim, login, run } from './harness.mjs';

const A = USERS['alice@example.test'];
const screen = (page) => page.eval(`['loading','auth','main','diagnostics'].filter(n => !document.getElementById('screen-' + n).hidden).join(',')`);

async function startupPhase({ cdp, base, check }) {
    console.log('\nMOCKED start-up with a Cordova-like deviceready');
    const page = await openPage(cdp);
    await installRealtimeShim(page);
    await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*.supabase.co/*' }] });
    installMock(page, cdp);

    // 1. Fresh install, no session.
    await page.goto(`${base}/index.html`);
    check('Cordova path: window.cordova is defined (fake cordova.js loaded)', await page.eval("!!window.cordova && window.cordova.platformId === 'android'"));
    check('before deviceready the loading screen is shown, not diagnostics', (await screen(page)) === 'loading', await screen(page));
    check('no session: login screen after deviceready', await page.waitFor(visibleExpr('form-login')));
    check('only the login screen is visible', (await screen(page)) === 'auth', await screen(page));
    check('version tag is visible on the login screen', /^Version 1\.0\.0 · \S+$/.test(await page.eval("document.querySelector('#screen-auth [data-build-tag]').textContent")),
        await page.eval("document.querySelector('#screen-auth [data-build-tag]').textContent"));

    // 2. Old diagnostics hash, signed out.
    await page.goto(`${base}/index.html#/diagnostics`);
    check('old #/diagnostics hash, signed out: starts at login', await page.waitFor(visibleExpr('form-login')) && (await screen(page)) === 'auth', await screen(page));
    check('…and the hash is reset', (await page.hash()) === '#/login', await page.hash());

    // 3. Diagnostics still reachable from the login screen.
    await page.eval("document.querySelector('#screen-auth a[href=\"#/diagnostics\"]').click()");
    check('diagnostics opens from the login screen link', await page.waitFor(visibleExpr('screen-diagnostics')));
    check('diagnostics shows the app version and commit', /^1\.0\.0 · commit \S+/.test(await page.text('chk-version')), await page.text('chk-version'));
    check('diagnostics reports deviceready fired on android', (await page.text('chk-ready')) === 'fired' && (await page.text('chk-platform')) === 'android');
    await page.eval("document.dispatchEvent(new Event('backbutton'))");
    check('Android back leaves diagnostics for login', await page.waitFor(visibleExpr('form-login')));

    // 4. Existing session.
    await login(page, A.email, MOCK_PASSWORD);
    await page.waitFor(visibleExpr('view-feed'));
    await page.goto(`${base}/index.html`);
    check('existing session: restored straight to the feed', await page.waitFor(visibleExpr('view-feed')) && (await screen(page)) === 'main', await screen(page));

    // 5. Old diagnostics hash, signed in.
    await page.goto(`${base}/index.html#/diagnostics`);
    check('old #/diagnostics hash, signed in: starts at the feed', await page.waitFor(visibleExpr('view-feed')) && (await screen(page)) === 'main', await screen(page));

    // 6. Diagnostics from Profile while signed in, then back.
    await page.eval("location.hash = '#/profile'");
    await page.waitFor(visibleExpr('view-profile'));
    check('version tag is visible on Profile', /^Version 1\.0\.0/.test(await page.eval("document.querySelector('#view-profile [data-build-tag]').textContent")));
    await page.eval("document.querySelector('#view-profile a[href=\"#/diagnostics\"]').click()");
    check('diagnostics opens from Profile', await page.waitFor(visibleExpr('screen-diagnostics')));
    await page.click('diag-back');
    check('diagnostics back arrow returns to Profile', await page.waitFor(visibleExpr('view-profile')));
}

await run([startupPhase], { fakeCordova: true });
