// Live access-policy check with two real, confirmed test accounts.
//   npm run check:policies
//
// Prompts for both accounts (passwords are read without echo and never
// printed or stored). Uses only the publishable key, exactly like the app.
// Creates one clearly labelled temporary report and one tiny photo, and
// deletes both before exiting.
//
// Non-interactive alternative (beware: values may end up in shell history):
//   CW_A_EMAIL=… CW_A_PASSWORD=… CW_B_EMAIL=… CW_B_PASSWORD=… npm run check:policies

import { loadConfig, newClient, credentials, describeError as describe } from './lib/live.mjs';

const BUCKET = 'incident-photos';
// Tiny JPEG-typed test payload. Storage checks the declared content type and size, not the image data.
const TINY_JPEG = Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=',
    'base64');

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg, detail) => { failures += 1; console.log(`  FAIL  ${msg}${detail ? ` -> ${detail}` : ''}`); };
const expect = (cond, msg, detail) => (cond ? pass(msg) : fail(msg, detail));

async function main() {
    console.log('CivicWatch live policy check (two accounts)\n');
    const cfg = loadConfig();
    if (!cfg.ok) { cfg.errors.forEach((e) => fail('config.js', e)); return; }

    const credA = await credentials('A', 'CW_A');
    const credB = await credentials('B', 'CW_B');
    if (credA.email === credB.email) { fail('two different accounts are required'); return; }
    console.log();

    const A = newClient(cfg);
    const B = newClient(cfg);
    const anon = newClient(cfg);

    const signA = await A.auth.signInWithPassword(credA);
    const signB = await B.auth.signInWithPassword(credB);
    credA.password = credB.password = ''; // drop from memory as soon as possible
    if (signA.error || signB.error) {
        if (signA.error) fail(`sign in as A (${credA.email})`, describe(signA.error));
        if (signB.error) fail(`sign in as B (${credB.email})`, describe(signB.error));
        console.log('        -> Both accounts must exist and have confirmed their email.');
        return;
    }
    const idA = signA.data.user.id;
    const idB = signB.data.user.id;
    pass(`signed in as A (${credA.email}) and B (${credB.email})`);

    let reportId = null;
    let photoPathB = null;
    try {
        // A submits a report as themself.
        const created = await A.from('incidents').insert({
            title: '[policy-check] temporary test report',
            description: 'Automated access-policy check. Deleted automatically.',
            category: 'other', latitude: 0, longitude: 0, location_source: 'manual',
        }).select().single();
        expect(!created.error, 'A can submit a report as themself', describe(created.error));
        if (created.error) return;
        reportId = created.data.id;
        expect(created.data.user_id === idA, 'the report is owned by A');
        expect(created.data.verification_status === 'unverified', 'new reports are unverified');

        // Shared browsing.
        const seenByB = await B.from('incidents').select('id').eq('id', reportId);
        expect(!seenByB.error && seenByB.data.length === 1, "B can browse A's report", describe(seenByB.error));
        const seenByAnon = await anon.from('incidents').select('id').eq('id', reportId);
        expect(!seenByAnon.error && seenByAnon.data.length === 0, 'signed-out requests see no reports', describe(seenByAnon.error));

        // My Reports isolation.
        const bMine = await B.from('incidents').select('id').eq('user_id', idB);
        expect(!bMine.error && !bMine.data.some((r) => r.id === reportId), "B's My Reports query does not include A's report");

        // Impersonation and verification.
        const spoof = await A.from('incidents').insert({
            user_id: idB, title: '[policy-check] spoofed', description: 'Should be rejected by RLS.',
            category: 'other', latitude: 0, longitude: 0,
        }).select();
        expect(!!spoof.error, 'A cannot submit a report as B', spoof.error ? describe(spoof.error) : 'INSERT SUCCEEDED');
        if (!spoof.error && spoof.data) await A.from('incidents').delete().in('id', spoof.data.map((r) => r.id));

        const selfVerify = await A.from('incidents').insert({
            title: '[policy-check] self-verified', description: 'Should be rejected: column not insertable.',
            category: 'other', latitude: 0, longitude: 0, verification_status: 'verified',
        }).select();
        expect(!!selfVerify.error, 'A cannot submit a report already marked verified',
            selfVerify.error ? describe(selfVerify.error) : 'INSERT SUCCEEDED');
        if (!selfVerify.error && selfVerify.data) await A.from('incidents').delete().in('id', selfVerify.data.map((r) => r.id));

        const verifyOwn = await A.from('incidents').update({ verification_status: 'verified' }).eq('id', reportId).select();
        expect(!!verifyOwn.error || verifyOwn.data.length === 0, 'A cannot mark their own report verified', describe(verifyOwn.error));

        const editOther = await B.from('incidents').update({ title: '[policy-check] hijacked' }).eq('id', reportId).select();
        expect(!!editOther.error || editOther.data.length === 0, "B cannot edit A's report", describe(editOther.error));

        const deleteOther = await B.from('incidents').delete().eq('id', reportId).select();
        const stillThere = await A.from('incidents').select('id, title, verification_status').eq('id', reportId).single();
        expect(!stillThere.error && stillThere.data, "B cannot delete A's report", describe(deleteOther.error));
        expect(stillThere.data && stillThere.data.verification_status === 'unverified'
            && stillThere.data.title === '[policy-check] temporary test report', "A's report is unchanged");

        // Storage ownership.
        const intoA = await B.storage.from(BUCKET).upload(`${idA}/policy-check-${Date.now()}.jpg`, TINY_JPEG, { contentType: 'image/jpeg' });
        expect(!!intoA.error, "B cannot upload into A's photo folder", intoA.error ? describe(intoA.error) : 'UPLOAD SUCCEEDED');
        if (!intoA.error) await B.storage.from(BUCKET).remove([intoA.data.path]);

        photoPathB = `${idB}/policy-check-${Date.now()}.jpg`;
        const own = await B.storage.from(BUCKET).upload(photoPathB, TINY_JPEG, { contentType: 'image/jpeg' });
        expect(!own.error, 'B can upload a JPEG into their own folder', describe(own.error));
        if (!own.error) {
            const url = B.storage.from(BUCKET).getPublicUrl(photoPathB).data.publicUrl;
            const res = await fetch(url);
            expect(res.ok, 'uploaded photo is readable by public URL', `HTTP ${res.status}`);
        } else photoPathB = null;

        const notImage = await B.storage.from(BUCKET).upload(`${idB}/policy-check-${Date.now()}.jpg`, Buffer.from('not an image'),
            { contentType: 'text/plain' });
        expect(!!notImage.error, 'non-image content types are rejected', notImage.error ? describe(notImage.error) : 'UPLOAD SUCCEEDED');
        if (!notImage.error) await B.storage.from(BUCKET).remove([notImage.data.path]);

        const tooBig = await B.storage.from(BUCKET).upload(`${idB}/policy-check-big-${Date.now()}.jpg`,
            Buffer.alloc(5 * 1024 * 1024 + 1024), { contentType: 'image/jpeg' });
        expect(!!tooBig.error, 'files over 5 MB are rejected', tooBig.error ? describe(tooBig.error) : 'UPLOAD SUCCEEDED');
        if (!tooBig.error) await B.storage.from(BUCKET).remove([tooBig.data.path]);
    } finally {
        if (photoPathB) {
            const removed = await B.storage.from(BUCKET).remove([photoPathB]);
            expect(!removed.error, 'cleanup: B deleted their test photo', describe(removed.error));
        }
        if (reportId) {
            const removed = await A.from('incidents').delete().eq('id', reportId).select();
            expect(!removed.error && removed.data.length === 1, 'cleanup: A deleted their own test report', describe(removed.error));
        }
        await A.auth.signOut();
        await B.auth.signOut();
    }
}

await main();
console.log(failures === 0 ? '\nRESULT: all live policy checks passed.' : `\nRESULT: ${failures} live policy check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
