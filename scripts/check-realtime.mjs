// Live Realtime check with two confirmed test accounts, using the app's own
// feed module (www/js/feed.js): subscription, notification filter, category
// query and incident lookup.
//   npm run check:realtime
//
// Account A creates one clearly labelled temporary report; account B must
// receive it through Supabase Realtime. The report is deleted at the end.
//
// Non-interactive alternative (beware: values may end up in shell history):
//   CW_A_EMAIL=… CW_A_PASSWORD=… CW_B_EMAIL=… CW_B_PASSWORD=… npm run check:realtime

import path from 'node:path';
import { createRequire } from 'node:module';
import { root, loadConfig, newClient, credentials, reporter, describeError } from './lib/live.mjs';

const require = createRequire(import.meta.url);
const F = require(path.join(root, 'www/js/feed.js'));
const t = reporter();
const TABLE_COLUMNS = ['id', 'user_id', 'title', 'description', 'category', 'latitude', 'longitude',
    'location_source', 'photo_path', 'verification_status', 'created_at'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function watch(client, label) {
    const w = { label, status: null, rows: [] };
    w.sub = F.createIncidentSubscription(client, {
        onInsert: (row) => w.rows.push({ row, at: Date.now() }),
        onStatus: (s) => { w.status = s; },
    });
    return w;
}

async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await sleep(100); }
    return fn();
}

async function main() {
    console.log('CivicWatch live Realtime check (two accounts, temporary data)\n');
    const cfg = loadConfig();
    if (!cfg.ok) { cfg.errors.forEach((e) => t.fail('config.js', e)); return; }

    const credA = await credentials('A', 'CW_A');
    const credB = await credentials('B', 'CW_B');
    if (credA.email === credB.email) { t.fail('two different accounts are required'); return; }
    console.log();

    const A = newClient(cfg);
    const B = newClient(cfg);
    const anon = newClient(cfg);
    const signA = await A.auth.signInWithPassword(credA);
    const signB = await B.auth.signInWithPassword(credB);
    credA.password = credB.password = '';
    if (signA.error || signB.error) {
        if (signA.error) t.fail(`sign in as A (${credA.email})`, describeError(signA.error));
        if (signB.error) t.fail(`sign in as B (${credB.email})`, describeError(signB.error));
        return;
    }
    const idA = signA.data.user.id;
    const idB = signB.data.user.id;
    t.pass(`signed in as A (${credA.email}) and B (${credB.email})`);

    const watchers = [watch(A, 'A'), watch(B, 'B'), watch(anon, 'signed-out')];
    const [wA, wB, wAnon] = watchers;
    const filterA = F.createNotificationFilter({ getUserId: () => idA });
    const filterB = F.createNotificationFilter({ getUserId: () => idB });
    let reportId = null;

    try {
        const connected = await waitFor(() => wA.status === 'live' && wB.status === 'live', 15000);
        t.expect(connected, 'A and B subscribed to live incident inserts', `A=${wA.status} B=${wB.status}`);
        if (!connected) return;
        filterA.start();
        filterB.start();

        const insertedAt = Date.now();
        const created = await A.from('incidents').insert({
            title: `[realtime-check] temporary report ${new Date().toISOString().slice(11, 19)}`,
            description: 'Automated Realtime check. Deleted automatically.',
            category: 'rioting', latitude: 0, longitude: 0, location_source: 'manual',
        }).select('id, category').single();
        t.expect(!created.error, 'A submitted a temporary Rioting report', describeError(created.error));
        if (created.error) return;
        reportId = created.data.id;

        const gotB = await waitFor(() => wB.rows.some((e) => e.row.id === reportId), 15000);
        const eventB = wB.rows.find((e) => e.row.id === reportId);
        t.expect(gotB, `B received the new report via Realtime${eventB ? ` (${eventB.at - insertedAt} ms)` : ''}`);
        if (eventB) {
            t.expect(filterB.shouldNotify(eventB.row), 'B would be notified (another user, new report)');
            t.expect(!filterB.shouldNotify(eventB.row), 'a duplicate event would not notify B again');
            const extra = Object.keys(eventB.row).filter((k) => !TABLE_COLUMNS.includes(k));
            t.expect(extra.length === 0, 'event carries only report columns (no emails or account details)', extra.join(', '));
        }

        const gotA = await waitFor(() => wA.rows.some((e) => e.row.id === reportId), 5000);
        if (gotA) t.expect(!filterA.shouldNotify(wA.rows.find((e) => e.row.id === reportId).row), "A's own report would not notify A");
        else t.pass("A did not receive their own event (nothing to notify either way)");

        await sleep(2000);
        t.expect(!wAnon.rows.some((e) => e.row.id === reportId), 'a signed-out client received nothing (RLS applies to Realtime)');

        const riot = await F.fetchFeedPage(B, 'rioting', null, 50);
        t.expect(!riot.error && riot.rows.some((r) => r.id === reportId), "B finds it in the Rioting feed", describeError(riot.error));
        const fight = await F.fetchFeedPage(B, 'fighting', null, 50);
        t.expect(!fight.error && !fight.rows.some((r) => r.id === reportId), 'it is not in the Fighting feed', describeError(fight.error));
        const detail = await F.fetchIncident(B, reportId);
        t.expect(detail.row && detail.row.description.startsWith('Automated Realtime check') && detail.row.verification_status === 'unverified',
            'B can open its details (unverified)', describeError(detail.error));
    } finally {
        watchers.forEach((w) => w.sub.stop());
        await sleep(500);
        const open = [A, B, anon].reduce((n, c) => n + c.getChannels().length, 0);
        t.expect(open === 0, 'cleanup: all Realtime channels removed', `${open} still open`);
        if (reportId) {
            const del = await A.from('incidents').delete().eq('id', reportId).select();
            t.expect(!del.error && del.data.length === 1, 'cleanup: temporary report deleted', describeError(del.error));
        }
        await Promise.all([A.auth.signOut(), B.auth.signOut()]);
        [A, B, anon].forEach((c) => c.realtime.disconnect());
    }
}

await main();
console.log(t.failures === 0 ? '\nRESULT: all live Realtime checks passed.' : `\nRESULT: ${t.failures} live Realtime check(s) failed.`);
process.exit(t.failures === 0 ? 0 : 1);
