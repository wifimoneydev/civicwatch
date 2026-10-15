// End-to-end test of the shared feed, category filters, incident details and
// in-app notifications in headless Chrome.
//   npm run test:e2e:feed
//
// MOCKED: Supabase REST/Storage is faked in the browser and Realtime channels
// are replaced by a stand-in (harness.installRealtimeShim) that the test
// drives. The real Realtime service is checked by `npm run check:realtime`.

import crypto from 'node:crypto';
import {
    USERS, MOCK_PASSWORD, visibleExpr, openPage, installMock, installRealtimeShim, login, run,
} from './harness.mjs';

const A = USERS['alice@example.test'];
const B = USERS['bob@example.test'];
const CAROL = 'c4444444-4444-4444-8444-444444444444';

// 25 existing reports: 12 Rioting, the rest Accident/Fighting/Fire/Other, none Theft.
function seed() {
    const cats = ['accident', 'fighting', 'fire', 'other'];
    const now = Date.now();
    return Array.from({ length: 25 }, (_, i) => {
        const user = i % 2 ? B.id : CAROL;
        return {
            id: crypto.randomUUID(),
            user_id: user,
            title: `Seed report ${String(i + 1).padStart(2, '0')}`,
            description: `Existing report number ${i + 1}.`,
            category: i < 12 ? 'rioting' : cats[i % 4],
            latitude: 6.5 + i / 100, longitude: 3.3 + i / 100, location_source: i % 2 ? 'gps' : 'manual',
            photo_path: i % 3 === 0 ? `${user}/seed-${i}.jpg` : null,
            verification_status: 'unverified',
            created_at: new Date(now - (i + 10) * 60000).toISOString(),
        };
    });
}

const listTitles = (page) => page.eval("[...document.querySelectorAll('#feed-list h3')].map(h => h.textContent)");
const feedGets = (mock) => mock.log.filter((e) => e.key === 'GET /rest/v1/incidents' && !new URL(e.url).searchParams.get('id'));
const toastVisible = (page) => page.visible('toast');

async function chip(page, category) {
    await page.eval(`document.querySelector('#feed-filters [data-category="${category}"]').click()`);
}

function realtimeRow(over) {
    return { id: crypto.randomUUID(), user_id: B.id, title: 'Crowd gathering near the market',
        description: 'A large crowd is gathering. Shops are closing.', category: 'rioting',
        latitude: 6.6, longitude: 3.35, location_source: 'gps', photo_path: null,
        verification_status: 'unverified', created_at: new Date().toISOString(), ...over };
}

async function feedPhase({ cdp, base, check }) {
    console.log('\nMOCKED feed, details and notifications (fake Supabase + Realtime stand-in)');
    const page = await openPage(cdp);
    await installRealtimeShim(page);
    await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*.supabase.co/*' }] });
    const mock = installMock(page, cdp);
    mock.delayMs = 150;
    const rows = seed();
    mock.incidents.push(...rows);
    const newest = rows.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

    await page.goto(`${base}/index.html`);
    await page.waitFor(visibleExpr('form-login'));
    await login(page, A.email, MOCK_PASSWORD);

    // --- feed basics
    check('feed loads 10 real reports, newest first', await page.waitFor("document.querySelectorAll('#feed-list li').length === 10"));
    check('order matches created_at desc', JSON.stringify(await listTitles(page)) === JSON.stringify(newest.slice(0, 10).map((r) => r.title)));
    const first = await page.eval(`(() => { const li = document.querySelector('#feed-list li');
        return { text: li.textContent, img: !!li.querySelector('img'), href: li.querySelector('a').getAttribute('href') }; })()`);
    check('items show title, category, time and Unverified', first.text.includes(newest[0].title) && first.text.includes('Rioting')
        && /min ago/.test(first.text) && first.text.includes('Unverified'), first.text);
    check('items link to the report details', first.href === `#/incident/${newest[0].id}`);
    const thumbs = await page.eval("document.querySelectorAll('#feed-list img').length");
    check('thumbnails shown for reports with photos', thumbs === newest.slice(0, 10).filter((r) => r.photo_path).length, `${thumbs}`);
    check('realtime subscription opened after login', await page.waitFor('window.__rt.active() === 1'));
    check('live indicator shows connected', await page.waitFor("document.getElementById('feed-live').textContent.startsWith('Live:')"));
    check('no notification for existing reports', !(await toastVisible(page)));

    // --- pagination
    await page.click('feed-more');
    check('Load more appends the next 10', await page.waitFor("document.querySelectorAll('#feed-list li').length === 20"));
    check('Load more uses a keyset cursor (not offsets)', !!feedGets(mock).at(-1).cursor);
    await page.click('feed-more');
    await page.waitFor("document.querySelectorAll('#feed-list li').length === 25");
    const all = await listTitles(page);
    check('all 25 reports, no duplicates, in order', all.length === 25 && new Set(all).size === 25
        && JSON.stringify(all) === JSON.stringify(newest.map((r) => r.title)));
    check('Load more disappears at the end', !(await page.visible('feed-more')));

    // --- categories
    await chip(page, 'rioting');
    check('Rioting filter: first page of Rioting only', await page.waitFor("document.querySelectorAll('#feed-list li').length === 10"));
    const riot = feedGets(mock).at(-1);
    check('filter is applied in the database query', new URL(riot.url).searchParams.get('category') === 'eq.rioting' && !riot.cursor);
    check('every shown item is Rioting', (await page.eval("[...document.querySelectorAll('#feed-list li')].every(li => li.textContent.includes('Rioting'))")));
    check('pagination reset for the new category', await page.visible('feed-more'));
    await page.click('feed-more');
    check('Rioting Load more reaches all 12', await page.waitFor("document.querySelectorAll('#feed-list li').length === 12"));
    check('Rioting chip marked as selected', await page.eval(`document.querySelector('[data-category="rioting"]').getAttribute('aria-pressed') === 'true'`));

    await chip(page, 'theft');
    check('empty category shows its own empty state', await page.waitFor(`${visibleExpr('feed-empty')} && document.getElementById('feed-empty-title').textContent === 'No Theft reports yet'`));

    mock.incidentsDelay = (url) => (url.searchParams.get('category') === 'eq.fighting' ? 1500 : 50);
    await chip(page, 'fighting');
    await chip(page, 'accident');
    await new Promise((r) => setTimeout(r, 2000)); // let the slow Fighting response arrive
    const shown = await page.eval("[...document.querySelectorAll('#feed-list li')].map(li => li.textContent)");
    check('a late response for a previous category is ignored', shown.length > 0 && shown.every((t) => t.includes('Accident')), JSON.stringify(shown));
    mock.incidentsDelay = null;

    mock.incidentsMode = 'error500';
    await chip(page, 'fire');
    check('load failure shows an error with Try again', await page.waitFor(`${visibleExpr('feed-error')} && ${visibleExpr('feed-retry')}`));
    check('error state is not the empty state', !(await page.visible('feed-empty')));
    mock.incidentsMode = 'ok';
    await page.click('feed-retry');
    check('Try again recovers', await page.waitFor("document.querySelectorAll('#feed-list li').length > 0 && !document.getElementById('feed-error').offsetParent"));

    await chip(page, 'all');
    await page.waitFor("document.querySelectorAll('#feed-list li').length === 10");
    const getsBefore = feedGets(mock).length;
    await page.click('feed-refresh');
    check('Refresh reloads from the database', await page.waitFor(`document.getElementById('feed-refresh').textContent === 'Refresh'`)
        && feedGets(mock).length === getsBefore + 1);

    // --- notifications
    const rowB = realtimeRow();
    mock.incidents.push(rowB);
    await page.eval(`window.__rt.emit(${JSON.stringify(rowB)})`);
    check("another user's new report shows a notification", await page.waitFor(visibleExpr('toast')));
    check('notification names the category and title', (await page.text('toast-kicker')) === 'New Rioting report'
        && (await page.text('toast-title')) === rowB.title);
    check('the new report appears at the top of the feed', (await listTitles(page))[0] === rowB.title);
    await page.eval(`window.__rt.emit(${JSON.stringify(rowB)})`);
    await new Promise((r) => setTimeout(r, 200));
    check('a duplicate event adds no duplicate row or notification',
        (await listTitles(page)).filter((t) => t === rowB.title).length === 1 && (await page.text('toast-kicker')) === 'New Rioting report');

    await page.click('toast-close');
    const own = realtimeRow({ user_id: A.id, title: 'My own new report', category: 'fire' });
    mock.incidents.push(own);
    await page.eval(`window.__rt.emit(${JSON.stringify(own)})`);
    await new Promise((r) => setTimeout(r, 300));
    check("the author's own report does not notify", !(await toastVisible(page)));
    check('…but it does appear in the feed', (await listTitles(page))[0] === 'My own new report');

    const old = realtimeRow({ title: 'Old replayed report', created_at: new Date(Date.now() - 86400000).toISOString() });
    await page.eval(`window.__rt.emit(${JSON.stringify(old)})`);
    await new Promise((r) => setTimeout(r, 300));
    check('events for reports older than the session do not notify', !(await toastVisible(page)));

    await chip(page, 'accident');
    // Wait for real Accident rows: [].every() is true on an empty list.
    check('Accident feed loaded before the live event', await page.waitFor(
        "document.querySelectorAll('#feed-list li').length > 0 && [...document.querySelectorAll('#feed-list li')].every(li => li.textContent.includes('Accident'))"));
    const fightRow = realtimeRow({ title: 'Fight outside the stadium', category: 'fighting' });
    mock.incidents.push(fightRow);
    await page.eval(`window.__rt.emit(${JSON.stringify(fightRow)})`);
    check('notification still appears while another category is selected', await page.waitFor(visibleExpr('toast')));
    check('…but the Accident feed is not changed', !(await listTitles(page)).includes(fightRow.title));

    // --- open from notification
    await page.click('toast-open');
    check('tapping the notification opens that report', await page.waitFor(`location.hash === '#/incident/${fightRow.id}' && ${visibleExpr('incident-article')}`));
    const detail = await page.eval(`({ title: document.getElementById('incident-title').textContent,
        cat: document.getElementById('incident-category').textContent, desc: document.getElementById('incident-description').textContent,
        lat: document.getElementById('incident-lat').textContent, lng: document.getElementById('incident-lng').textContent,
        status: document.getElementById('incident-status').textContent, src: document.getElementById('incident-source').textContent,
        time: document.getElementById('incident-time').textContent, back: !document.getElementById('main-back').hidden })`);
    check('details show title, category, description, coordinates, status, source and time',
        detail.title === fightRow.title && detail.cat === 'Fighting' && detail.desc === fightRow.description
        && detail.lat === '6.600000' && detail.lng === '3.350000' && detail.status === 'Unverified'
        && detail.src.startsWith('GPS') && detail.time.startsWith('Reported'), JSON.stringify(detail));
    check('a back button is shown on the details screen', detail.back);
    await page.click('main-back');
    check('Back returns to the feed with the selected category kept', await page.waitFor(`location.hash === '#/feed'`)
        && (await page.eval(`document.querySelector('[data-category="accident"]').getAttribute('aria-pressed') === 'true'`)));

    // --- details from the feed, photo handling, unsafe text
    await chip(page, 'all');
    await page.waitFor("document.querySelectorAll('#feed-list li').length >= 10");
    const withPhoto = newest.find((r) => r.photo_path);
    await page.eval(`location.hash = '#/incident/${withPhoto.id}'`);
    check('details show the photo', await page.waitFor(`${visibleExpr('incident-photo')} && document.getElementById('incident-photo').naturalWidth > 0`));
    await page.eval("document.dispatchEvent(new Event('backbutton'))");
    check('Android back from details returns to the feed', await page.waitFor("location.hash === '#/feed'"));

    const broken = realtimeRow({ user_id: CAROL, title: 'Report with a missing photo', photo_path: `${CAROL}/broken.jpg`,
        description: '<script>window.__xss = 1</script><img src=x onerror="window.__xss=1"> Line one\nLine two',
        created_at: new Date(Date.now() - 5 * 60000).toISOString() });
    mock.incidents.push(broken);
    await page.eval(`location.hash = '#/incident/${broken.id}'`);
    check('a photo that fails to load shows a message instead', await page.waitFor(`${visibleExpr('incident-photo-error')} && !${visibleExpr('incident-photo')}`));
    const safe = await page.eval(`({ text: document.getElementById('incident-description').textContent,
        html: document.getElementById('incident-description').innerHTML, xss: window.__xss === 1 })`);
    check('description is rendered as text, never as HTML', safe.text.startsWith('<script>') && !safe.html.includes('<script') && !safe.xss);

    await page.eval(`location.hash = '#/incident/${crypto.randomUUID()}'`);
    check('an unknown report shows "Report unavailable"', await page.waitFor(`${visibleExpr('incident-missing')} && document.getElementById('incident-missing-title').textContent === 'Report unavailable'`));
    await page.eval("location.hash = '#/incident/not-a-real-id'");
    check('a malformed link shows "Report unavailable" too', await page.waitFor(`${visibleExpr('incident-missing')} && !${visibleExpr('incident-article')}`));

    mock.incidentsMode = 'network';
    await page.eval(`location.hash = '#/incident/${withPhoto.id}'`);
    check('a network failure on details offers Try again', await page.waitFor(`${visibleExpr('incident-retry')} && document.getElementById('incident-missing-title').textContent === "Couldn't load this report"`));
    mock.incidentsMode = 'ok';
    await page.click('incident-retry');
    check('Try again loads the report', await page.waitFor(visibleExpr('incident-article')));

    // --- details from My Reports
    const mine = realtimeRow({ user_id: A.id, title: 'Alice report for My Reports', category: 'theft',
        created_at: new Date(Date.now() - 3 * 60000).toISOString() });
    mock.incidents.push(mine);
    await page.eval("location.hash = '#/my-reports'");
    await page.waitFor("document.querySelectorAll('#my-reports-list li').length >= 1");
    await page.eval(`document.querySelector('#my-reports-list a[href="#/incident/${mine.id}"]').click()`);
    check('a report opens from My Reports', await page.waitFor(`${visibleExpr('incident-article')} && document.getElementById('incident-title').textContent === '${mine.title}'`));
    check('details say when you submitted it', await page.visible('incident-own'));
    check('the My Reports tab stays highlighted', await page.eval(`document.querySelector('.tab[data-route="my-reports"]').classList.contains('active')`));
    await page.click('main-back');
    check('Back returns to My Reports', await page.waitFor("location.hash === '#/my-reports'"));

    // --- connection status, reconnect and resume
    await page.eval("location.hash = '#/feed'");
    await page.waitFor(visibleExpr('feed-list'));
    await page.eval("window.__rt.status('CHANNEL_ERROR')");
    check('a failed live connection is shown, separate from the list',
        await page.waitFor("document.getElementById('feed-live').textContent.startsWith('Live updates unavailable')")
        && (await page.eval("document.querySelectorAll('#feed-list li').length")) > 0 && !(await page.visible('feed-empty')));
    let before = feedGets(mock).length;
    await page.eval("window.__rt.status('SUBSCRIBED')");
    await page.waitFor("document.getElementById('feed-live').textContent.startsWith('Live:')");
    await new Promise((r) => setTimeout(r, 400));
    check('reconnecting refreshes the feed to catch missed reports', feedGets(mock).length > before);
    before = feedGets(mock).length;
    await page.eval("document.dispatchEvent(new Event('resume'))");
    check('resuming the app refreshes the feed', await new Promise((r) => setTimeout(r, 500)).then(() => feedGets(mock).length > before));
    before = feedGets(mock).length;
    await page.eval("window.dispatchEvent(new Event('online'))");
    check('regaining the network refreshes the feed', await new Promise((r) => setTimeout(r, 500)).then(() => feedGets(mock).length > before));
    await page.eval("window.__rt.status('CHANNEL_ERROR')");
    const channelsBefore = await page.eval('window.__rt.channels.length');
    await page.eval("document.dispatchEvent(new Event('resume'))");
    check('resuming with a dead connection re-subscribes (old channel removed)', await page.waitFor(`window.__rt.channels.length === ${channelsBefore + 1} && window.__rt.active() === 1`));

    // --- logout / account change
    const late = realtimeRow({ title: 'Arrives while Alice is logged in' });
    mock.incidents.push(late);
    await page.eval(`window.__rt.emit(${JSON.stringify(late)})`);
    await page.waitFor(visibleExpr('toast'));
    await page.eval("location.hash = '#/profile'");
    await page.waitFor(visibleExpr('logout-button'));
    await page.click('logout-button');
    await page.waitFor(visibleExpr('form-login'));
    check('logout removes every realtime subscription', (await page.eval('window.__rt.active()')) === 0);
    check('logout hides notifications and clears the feed', !(await toastVisible(page)) && (await page.eval("document.querySelectorAll('#feed-list li').length")) === 0);
    const afterLogout = realtimeRow({ title: 'Event after logout' });
    await page.eval(`window.__rt.emit(${JSON.stringify(afterLogout)})`);
    await new Promise((r) => setTimeout(r, 300));
    check('events after logout are ignored', !(await toastVisible(page)));

    await login(page, B.email, MOCK_PASSWORD);
    check('second account: exactly one new subscription', await page.waitFor("document.querySelectorAll('#feed-list li').length === 10 && window.__rt.active() === 1"));
    check('second account starts on All with a fresh feed', await page.eval(`document.querySelector('[data-category="all"]').getAttribute('aria-pressed') === 'true'`));
    const fromBob = realtimeRow({ user_id: B.id, title: 'Bob own report' });
    await page.eval(`window.__rt.emit(${JSON.stringify(fromBob)})`);
    await new Promise((r) => setTimeout(r, 300));
    check("Bob is not notified about Bob's own report", !(await toastVisible(page)));
    const fromAlice = realtimeRow({ user_id: A.id, title: 'Alice reports a fire', category: 'fire' });
    mock.incidents.push(fromAlice);
    await page.eval(`window.__rt.emit(${JSON.stringify(fromAlice)})`);
    check("Bob is notified about Alice's report", await page.waitFor(`${visibleExpr('toast')} && document.getElementById('toast-kicker').textContent === 'New Fire report'`));
}

await run([feedPhase]);
