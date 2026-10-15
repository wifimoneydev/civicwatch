// End-to-end test of the incident reporting flow in headless Chrome.
//   npm run test:e2e:report
//
// MOCKED: Supabase (auth, storage, database) is faked inside the browser, so
// no live reports or photos are created. Geolocation is emulated by Chrome.
// What this cannot prove: the Android camera/gallery plugin, the real GPS
// chip, Android permission dialogs, and the live Supabase project. Those are
// covered by `npm run check:report` (live) and the phone checklist.

import {
    USERS, MOCK_PASSWORD, visibleExpr, openPage, installMock, installRealtimeShim, login, run,
} from './harness.mjs';

const A = USERS['alice@example.test'];
const B = USERS['bob@example.test'];

// Creates an image (or non-image) File inside the page and hands it to the
// "Choose photo" file input, exactly as a user selection would.
async function choosePhoto(page, kind) {
    return page.eval(`(async () => {
        const make = (w, h, type) => new Promise((resolve) => {
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const g = c.getContext('2d');
            const grad = g.createLinearGradient(0, 0, w, h);
            grad.addColorStop(0, '#0b1f3a'); grad.addColorStop(1, '#0f9d8f');
            g.fillStyle = grad; g.fillRect(0, 0, w, h);
            g.fillStyle = '#e8742a'; g.fillRect(w * 0.4, h * 0.4, w * 0.2, h * 0.2);
            c.toBlob(resolve, type, 0.92);
        });
        let file;
        if (${JSON.stringify(kind)} === 'large-png') {
            file = new File([await make(4000, 3000, 'image/png')], 'big.png', { type: 'image/png' });
        } else if (${JSON.stringify(kind)} === 'jpeg-with-exif') {
            // Splice an APP1 "Exif" segment carrying a marker into a real JPEG.
            const jpeg = new Uint8Array(await (await make(1200, 1800, 'image/jpeg')).arrayBuffer());
            const payload = new TextEncoder().encode('Exif\\0\\0GPS-TEST-MARKER-6.5244-3.3792');
            const len = payload.length + 2;
            const app1 = new Uint8Array([0xFF, 0xE1, (len >> 8) & 255, len & 255, ...payload]);
            const out = new Uint8Array(jpeg.length + app1.length);
            out.set(jpeg.subarray(0, 2), 0); out.set(app1, 2); out.set(jpeg.subarray(2), 2 + app1.length);
            file = new File([out], 'exif.jpg', { type: 'image/jpeg' });
        } else if (${JSON.stringify(kind)} === 'text') {
            file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
        } else {
            file = new File(['definitely not a jpeg'], 'broken.jpg', { type: 'image/jpeg' });
        }
        const input = document.getElementById('report-photo-input');
        const dt = new DataTransfer(); dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const text = new TextDecoder('latin1').decode(new Uint8Array(await file.arrayBuffer()));
        return { size: file.size, hasMarker: text.includes('GPS-TEST-MARKER') };
    })()`);
}

// Dimensions of the processed photo as previewed. (The app's CSP blocks
// fetch() of blob: URLs, so the bytes are checked on the uploaded request.)
const processedPhoto = (page) => page.eval(`(() => {
    const img = document.getElementById('report-photo-img');
    return { width: Number(img.dataset.width), height: Number(img.dataset.height),
        naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
        meta: document.getElementById('report-photo-meta').textContent };
})()`);

// The multipart upload body as received by the mock server.
function uploadedFile(entry) {
    const raw = Buffer.concat((entry.postDataEntries || []).map((e) => Buffer.from(e.bytes || '', 'base64')));
    const text = raw.toString('latin1');
    const part = text.match(/Content-Type: (image\/[a-z]+)\r\n\r\n/);
    const start = part ? text.indexOf(part[0]) + part[0].length : -1;
    const end = text.lastIndexOf('\r\n--');
    const file = start >= 0 && end > start ? raw.subarray(start, end) : Buffer.alloc(0);
    return { total: raw.length, type: part && part[1], size: file.length,
        soi: file[0] === 0xFF && file[1] === 0xD8, hasExif: file.includes('Exif'), hasMarker: file.includes('GPS-TEST-MARKER') };
}

async function fillValid(page, overrides = {}) {
    const v = { title: 'Two-car collision', category: 'accident',
        description: 'Collision at the junction, one lane blocked.', latitude: '6.5244', longitude: '3.3792', ...overrides };
    await page.fill('report-title', v.title);
    await page.eval(`document.getElementById('report-category').value = ${JSON.stringify(v.category)}`);
    await page.fill('report-description', v.description);
    await page.fill('report-latitude', v.latitude);
    await page.fill('report-longitude', v.longitude);
}

const value = (page, id) => page.eval(`document.getElementById(${JSON.stringify(id)}).value`);
const kinds = (mock, k) => mock.log.filter((e) => e.key.startsWith(k));
const uploads = (mock) => mock.log.filter((e) => e.key.startsWith('POST /storage/v1/object/incident-photos/'));
const inserts = (mock) => mock.log.filter((e) => e.key === 'POST /rest/v1/incidents');

async function setGeo(page, base, permission, position) {
    await page.send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: permission,
        origin: base, browserContextId: page.browserContextId });
    await page.send('Emulation.setGeolocationOverride', position || {});
}

async function reportPhase({ cdp, base, check }) {
    console.log('\nMOCKED report flow (fake Supabase, emulated geolocation)');
    const page = await openPage(cdp);
    await installRealtimeShim(page);
    await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://*.supabase.co/*' }] });
    const mock = installMock(page, cdp);
    mock.delayMs = 400;

    await page.goto(`${base}/index.html`);
    await page.waitFor(visibleExpr('form-login'));
    await login(page, A.email, MOCK_PASSWORD);
    await page.waitFor(visibleExpr('view-feed'));
    await page.eval("location.hash = '#/report'");
    check('report form is shown to a signed-in user', await page.waitFor(visibleExpr('form-report')));

    const categories = await page.eval("[...document.querySelectorAll('#report-category option')].map(o => o.value + ':' + o.textContent)");
    check('categories match the database (incl. Accident, Fighting, Rioting)', JSON.stringify(categories) === JSON.stringify(
        [':Choose a category', 'accident:Accident', 'fighting:Fighting', 'rioting:Rioting', 'fire:Fire', 'theft:Theft', 'other:Other']),
    JSON.stringify(categories));

    // --- validation
    await page.click('report-submit');
    const errors = await page.eval("['title','category','description','location'].map(f => document.getElementById('report-' + f + '-error').textContent)");
    check('empty submit shows an error for every required field', errors.every(Boolean), JSON.stringify(errors));
    check('invalid form sends nothing', uploads(mock).length === 0 && inserts(mock).length === 0);
    await page.fill('report-title', 'Fixed title');
    check("editing a field clears that field's error only", (await page.text('report-title-error')) === ''
        && (await page.text('report-description-error')) !== '');

    // --- location
    await setGeo(page, base, 'denied');
    await page.click('report-locate');
    check('location permission denied -> clear message',
        await page.waitFor("document.getElementById('report-location-status').textContent.includes('permission was denied')"),
        await page.text('report-location-status'));
    check('no coordinates are invented after a denial', (await value(page, 'report-latitude')) === '' && (await value(page, 'report-longitude')) === '');

    await setGeo(page, base, 'granted', {});
    await page.click('report-locate');
    check('location unavailable -> clear message',
        await page.waitFor("document.getElementById('report-location-status').textContent.includes('not available')"),
        await page.text('report-location-status'));
    check('still no coordinates after "unavailable"', (await value(page, 'report-latitude')) === '');

    await setGeo(page, base, 'granted', { latitude: 6.5244, longitude: 3.3792, accuracy: 15 });
    await page.click('report-locate');
    check('Use my location fills latitude and longitude', await page.waitFor("document.getElementById('report-latitude').value === '6.524400'")
        && (await value(page, 'report-longitude')) === '3.379200');
    check('accuracy is shown', (await page.text('report-location-status')).includes('±15 m'), await page.text('report-location-status'));

    await setGeo(page, base, 'granted', { latitude: 6.5, longitude: 3.3, accuracy: 2500 });
    await page.click('report-locate');
    check('imprecise fixes carry a warning',
        await page.waitFor("document.getElementById('report-location-status').textContent.includes('imprecise (±2.5 km)')"),
        await page.text('report-location-status'));

    await page.fill('report-latitude', '95');
    await page.fill('report-title', 'Range check');
    await page.click('report-submit');
    check('out-of-range manual latitude is rejected', (await page.text('report-location-error')).includes('Latitude must be between'));
    await page.fill('report-latitude', '6,5');
    await page.click('report-submit');
    check('ambiguous "6,5" is rejected, not guessed', (await page.text('report-location-error')).includes('decimal numbers'));
    check('still nothing sent', uploads(mock).length === 0 && inserts(mock).length === 0);

    // --- photo
    await choosePhoto(page, 'text');
    check('non-image file is rejected', await page.waitFor("document.getElementById('report-photo-error').textContent.includes('not an image')"));
    await choosePhoto(page, 'corrupt');
    check('unreadable image is rejected', await page.waitFor("document.getElementById('report-photo-error').textContent.includes('could not be opened')"));

    const big = await choosePhoto(page, 'large-png');
    check('large photo shows a preview', await page.waitFor(`${visibleExpr('report-photo-preview')} && document.getElementById('report-photo-img').naturalWidth > 0`));
    let p = await processedPhoto(page);
    check(`4000×3000 PNG (${(big.size / 1024 / 1024).toFixed(1)} MB) resized to 1600×1200, aspect kept`,
        p.width === 1600 && p.height === 1200 && p.naturalWidth === 1600 && p.naturalHeight === 1200, JSON.stringify(p));
    check('preview reports a JPEG with its size and dimensions', /^1600 × 1200 px · [\d.]+ (KB|MB) JPEG$/.test(p.meta), p.meta);

    await page.click('report-photo-remove');
    check('Remove clears the photo and shows the pick buttons again',
        !(await page.visible('report-photo-preview')) && (await page.visible('report-photo-pick')));

    const exifSource = await choosePhoto(page, 'jpeg-with-exif');
    await page.waitFor(`${visibleExpr('report-photo-preview')} && document.getElementById('report-photo-img').naturalWidth > 0`);
    p = await processedPhoto(page);
    check('source photo carried an EXIF location marker', exifSource.hasMarker);
    check('portrait 1200×1800 photo scaled to 1067×1600: still portrait, aspect ratio kept',
        p.width === 1067 && p.height === 1600 && Math.abs(p.width / p.height - 1200 / 1800) < 0.001, JSON.stringify(p));

    await page.click('report-photo-replace');
    check('Replace shows the pick buttons while keeping the current photo',
        (await page.visible('report-photo-pick')) && (await page.visible('report-photo-preview')));

    // --- upload failure
    await fillValid(page);
    mock.uploadMode = 'network';
    await page.click('report-submit');
    check('upload failure -> readable error', await page.waitFor("document.getElementById('report-error').textContent.includes(\"photo couldn't be uploaded\")", '', 10000),
        await page.text('report-error'));
    check('upload failure: no report is saved', inserts(mock).length === 0);
    check('upload failure: form input and photo are kept', (await value(page, 'report-title')) === 'Two-car collision'
        && (await value(page, 'report-latitude')) === '6.5244' && (await page.visible('report-photo-preview')));
    check('submit button is usable again', (await page.eval("document.getElementById('report-submit').disabled")) === false);

    // --- save rejected after a successful upload
    mock.uploadMode = 'ok';
    mock.insertMode = 'reject';
    await page.click('report-submit');
    check('save rejected -> readable error', await page.waitFor("document.getElementById('report-error').textContent.includes('could not be saved')", '', 10000),
        await page.text('report-error'));
    const orphan = uploads(mock).at(-1).objectPath;
    const removed = kinds(mock, 'DELETE /storage/v1/object/incident-photos').flatMap((e) => e.removed || []);
    check('save rejected: the just-uploaded photo is deleted', removed.includes(orphan), `${orphan} vs ${JSON.stringify(removed)}`);
    check('save rejected: form input is kept', (await value(page, 'report-description')).startsWith('Collision at the junction'));

    // --- success, with repeated taps
    mock.insertMode = 'ok';
    const uploadsBefore = uploads(mock).length;
    const insertsBefore = inserts(mock).length;
    await page.eval(`(() => { const f = document.getElementById('form-report');
        f.requestSubmit(); f.requestSubmit(); document.getElementById('report-submit').click(); })()`);
    check('submit shows progress and disables the button', (await page.text('report-submit')) === 'Submitting…'
        && (await page.eval("document.getElementById('report-submit').disabled")) === true);
    check('progress names the current step', await page.waitFor("/Uploading photo|Saving report/.test(document.getElementById('report-progress').textContent)"));
    check('success lands on My Reports', await page.waitFor(`location.hash === '#/my-reports' && ${visibleExpr('my-reports-list')}
        && document.getElementById('my-reports-list').children.length === 1`, '', 10000));
    check('repeated taps created exactly one upload and one report',
        uploads(mock).length - uploadsBefore === 1 && inserts(mock).length - insertsBefore === 1,
        `${uploads(mock).length - uploadsBefore} uploads, ${inserts(mock).length - insertsBefore} inserts`);

    const upload = uploads(mock).at(-1);
    const file = uploadedFile(upload);
    check('uploaded file is a JPEG under 5 MB', file.type === 'image/jpeg' && file.soi && file.size > 0 && file.size <= 5 * 1024 * 1024,
        JSON.stringify(file));
    check('uploaded file has no EXIF data (GPS marker from the source removed)', file.size > 0 && !file.hasExif && !file.hasMarker,
        JSON.stringify(file));
    const sent = JSON.parse(inserts(mock).at(-1).postData);
    check("photo stored as <Alice's id>/<uuid>.jpg", new RegExp(`^${A.id}/[0-9a-f-]{36}\\.jpg$`).test(upload.objectPath), upload.objectPath);
    check('report saved with the current user id and that photo path', sent.user_id === A.id && sent.photo_path === upload.objectPath);
    check('only permitted columns are sent (no verification_status, id, created_at)',
        JSON.stringify(Object.keys(sent).sort()) === JSON.stringify(
            ['category', 'description', 'latitude', 'location_source', 'longitude', 'photo_path', 'title', 'user_id']), JSON.stringify(Object.keys(sent)));
    check('typed coordinates are sent as numbers, marked manual', sent.latitude === 6.5244 && sent.longitude === 3.3792 && sent.location_source === 'manual',
        JSON.stringify(sent));
    check('success message mentions unverified', (await page.text('banner-text')).includes('unverified'));
    const item = await page.eval(`(() => { const li = document.querySelector('#my-reports-list li');
        return { text: li.textContent, img: li.querySelector('img') && li.querySelector('img').src }; })()`);
    check('My Reports shows the new report, coordinates and status', item.text.includes('Two-car collision') && item.text.includes('6.52440, 3.37920')
        && item.text.includes('Unverified'), item.text);
    check('My Reports shows the uploaded photo', !!item.img && item.img.endsWith(upload.objectPath), item.img);

    await page.eval("location.hash = '#/report'");
    await page.waitFor(visibleExpr('form-report'));
    check('form is cleared after success', (await value(page, 'report-title')) === '' && (await value(page, 'report-latitude')) === ''
        && !(await page.visible('report-photo-preview')));

    // --- GPS source + no photo + unsafe text
    await setGeo(page, base, 'granted', { latitude: 9.0765, longitude: 7.3986, accuracy: 8 });
    await fillValid(page, { title: '<img src=x onerror="window.__xss=1">Crowd <b>forming</b>', category: 'rioting',
        latitude: '', longitude: '' });
    await page.click('report-locate');
    await page.waitFor("document.getElementById('report-latitude').value === '9.076500'");
    await page.click('report-submit');
    await page.waitFor(`location.hash === '#/my-reports' && document.getElementById('my-reports-list').children.length === 2`, '', 10000);
    const sent2 = JSON.parse(inserts(mock).at(-1).postData);
    check('GPS-filled location is sent as source "gps"', sent2.location_source === 'gps' && sent2.latitude === 9.0765, JSON.stringify(sent2));
    check('report without a photo: photo_path null, nothing uploaded', sent2.photo_path === null);
    const xss = await page.eval(`(() => { const li = document.querySelector('#my-reports-list li');
        return { title: li.querySelector('h3').textContent, injected: window.__xss === 1,
            strayImg: !!li.querySelector('img[src="x"]'), bold: !!li.querySelector('b') }; })()`);
    check('user text is shown literally, never as HTML', xss.title.startsWith('<img src=x') && !xss.injected && !xss.strayImg && !xss.bold,
        JSON.stringify(xss));

    // --- draft and photo cleared on logout
    await page.eval("location.hash = '#/report'");
    await page.waitFor(visibleExpr('form-report'));
    await page.fill('report-title', 'Unsent draft by Alice');
    await choosePhoto(page, 'jpeg-with-exif');
    await page.waitFor(visibleExpr('report-photo-preview'));
    await page.eval("location.hash = '#/profile'");
    await page.waitFor(visibleExpr('logout-button'));
    await page.click('logout-button');
    await page.waitFor(visibleExpr('form-login'));
    await login(page, B.email, MOCK_PASSWORD);
    await page.waitFor(visibleExpr('view-feed'));
    await page.eval("location.hash = '#/report'");
    await page.waitFor(visibleExpr('form-report'));
    check("next user does not see the previous user's draft or photo",
        (await value(page, 'report-title')) === '' && !(await page.visible('report-photo-preview')));
    await page.eval("location.hash = '#/my-reports'");
    check("Bob's My Reports does not show Alice's reports", await page.waitFor(visibleExpr('my-reports-empty')));

    // --- offline
    await fillValid(page);
    await page.send('Network.enable');
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.eval("location.hash = '#/report'");
    await page.waitFor(visibleExpr('form-report'));
    const before = inserts(mock).length;
    await page.click('report-submit');
    check('offline submit: clear message, input kept', (await page.text('report-error')).includes("You're offline")
        && (await value(page, 'report-title')) === 'Two-car collision');
    check('offline submit sends nothing', inserts(mock).length === before);
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
}

await run([reportPhase]);
