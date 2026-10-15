// Live check of incident submission against your Supabase project, using the
// app's own validation and submit code (www/js/report-logic.js and
// www/js/report-submit.js).
//   npm run check:report
//
// Signs in with ONE confirmed test account (password read without echo).
// Creates a clearly labelled temporary report with a tiny photo, verifies it,
// forces a save failure to prove the uploaded photo is cleaned up, then
// deletes everything it created.
//
// Non-interactive alternative (beware: values may end up in shell history):
//   CW_A_EMAIL=… CW_A_PASSWORD=… npm run check:report

import path from 'node:path';
import { createRequire } from 'node:module';
import { root, loadConfig, newClient, credentials, reporter, describeError } from './lib/live.mjs';

const require = createRequire(import.meta.url);
const R = require(path.join(root, 'www/js/report-logic.js'));
const { submitReport, BUCKET } = require(path.join(root, 'www/js/report-submit.js'));
const { fetchMyReports } = require(path.join(root, 'www/js/my-reports.js'));

// Tiny JPEG-typed payload: Storage checks the declared type and size only.
const TINY_JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=',
    'base64');
const photo = () => ({ blob: new Blob([TINY_JPEG], { type: 'image/jpeg' }) });

const t = reporter();

async function publicStatus(client, photoPath) {
    const url = client.storage.from(BUCKET).getPublicUrl(photoPath).data.publicUrl;
    const res = await fetch(url);
    return { status: res.status, type: res.headers.get('content-type') || '' };
}

async function main() {
    console.log('CivicWatch live submission check (one account, temporary data)\n');
    const cfg = loadConfig();
    if (!cfg.ok) { cfg.errors.forEach((e) => t.fail('config.js', e)); return; }

    const cred = await credentials('A', 'CW_A');
    console.log();
    const client = newClient(cfg);
    const signIn = await client.auth.signInWithPassword(cred);
    cred.password = '';
    if (signIn.error) {
        t.fail(`sign in as ${cred.email}`, `${describeError(signIn.error)} (the account must exist and be confirmed)`);
        return;
    }
    const userId = signIn.data.user.id;
    t.pass(`signed in as ${cred.email}`);

    const check = R.validateReport({
        title: '[report-check] temporary test report',
        description: 'Automated submission check. Deleted automatically.',
        category: 'other', latitude: '6.5244', longitude: '3.3792', locationSource: 'manual',
    });
    t.expect(check.ok, 'test report passes the app validation', JSON.stringify(check.errors));

    let created = null;
    try {
        // 1. Real submission with a photo.
        const stages = [];
        const res = await submitReport(client, { userId, values: check.values, photo: photo(), onProgress: (s) => stages.push(s) });
        t.expect(res.ok, 'report with photo is saved', res.ok ? '' : `${res.stage}: ${describeError(res.error)}`);
        if (!res.ok) return;
        created = res;
        t.expect(stages.join(',') === 'upload,save', 'photo uploaded before the report is saved');
        t.expect(res.report.user_id === userId, 'report belongs to the signed-in user');
        t.expect(res.report.verification_status === 'unverified', 'report is unverified');
        t.expect(new RegExp(`^${userId}/[0-9a-f-]{36}\\.jpg$`).test(res.report.photo_path), "photo stored as <user id>/<uuid>.jpg in the user's folder",
            res.report.photo_path);
        t.expect(res.report.latitude === 6.5244 && res.report.longitude === 3.3792 && res.report.location_source === 'manual',
            'coordinates and location source saved exactly');

        const pub = await publicStatus(client, res.report.photo_path);
        t.expect(pub.status === 200 && pub.type.startsWith('image/jpeg'), 'photo is readable by its public URL', `${pub.status} ${pub.type}`);

        const mine = await fetchMyReports(client, userId);
        t.expect(!mine.error && mine.rows.some((r) => r.id === res.report.id), 'My Reports query returns the new report', describeError(mine.error));

        // 2. Upload succeeds but the database rejects the report.
        const bad = { ...check.values, category: 'not-a-category' }; // bypasses app validation on purpose
        const failed = await submitReport(client, { userId, values: bad, photo: photo() });
        t.expect(!failed.ok && failed.stage === 'save', 'database rejection is reported as a save failure',
            failed.ok ? 'UNEXPECTEDLY SAVED' : describeError(failed.error));
        t.expect(failed.photoCleanup === 'removed', 'the orphaned photo was deleted', failed.photoCleanup);
        if (failed.photoPath) {
            const gone = await publicStatus(client, failed.photoPath);
            t.expect(gone.status !== 200, 'the orphaned photo is no longer downloadable', `HTTP ${gone.status}`);
        }
        if (failed.ok) await client.from('incidents').delete().eq('id', failed.report.id);
    } finally {
        if (created) {
            const del = await client.from('incidents').delete().eq('id', created.report.id).select();
            t.expect(!del.error && del.data.length === 1, 'cleanup: temporary report deleted', describeError(del.error));
            const rm = await client.storage.from(BUCKET).remove([created.report.photo_path]);
            t.expect(!rm.error, 'cleanup: temporary photo deleted', describeError(rm.error));
            const gone = await publicStatus(client, created.report.photo_path);
            t.expect(gone.status !== 200, 'cleanup: photo no longer downloadable', `HTTP ${gone.status}`);
        }
        await client.auth.signOut();
    }
}

await main();
console.log(t.failures === 0 ? '\nRESULT: all live submission checks passed.' : `\nRESULT: ${t.failures} live submission check(s) failed.`);
process.exit(t.failures === 0 ? 0 : 1);
