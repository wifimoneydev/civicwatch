'use strict';

// Runs the real Supabase migration inside PGlite (Postgres compiled to WASM)
// on top of a minimal Supabase stub, then exercises the access rules as the
// anon and authenticated roles. This proves the SQL logic; it does not prove
// the live project was configured — run `npm run check:supabase` for that.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const stubSql = fs.readFileSync(path.join(root, 'tests/fixtures/supabase-stub.sql'), 'utf8');
const migrationSql = fs.readFileSync(
    path.join(root, 'supabase/migrations/001_incidents_storage_realtime.sql'), 'utf8');

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

let db;

// Run one statement as a Supabase API role, optionally as a signed-in user.
async function as(role, userId, sql, params = []) {
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId || '']);
    await db.exec(`set role ${role}`);
    try {
        return await db.query(sql, params);
    } finally {
        await db.exec('reset role');
    }
}

const asAlice = (sql, params) => as('authenticated', ALICE, sql, params);
const asBob = (sql, params) => as('authenticated', BOB, sql, params);
const asAnon = (sql, params) => as('anon', null, sql, params);

const INSERT = `insert into public.incidents
    (title, description, category, latitude, longitude, photo_path)
    values ($1, $2, $3, $4, $5, $6) returning *`;

function report(overrides = {}) {
    const r = {
        title: 'Two-car collision',
        description: 'Collision at the junction, one lane blocked.',
        category: 'accident',
        latitude: 6.5244,
        longitude: 3.3792,
        photo_path: null,
        ...overrides,
    };
    return [r.title, r.description, r.category, r.latitude, r.longitude, r.photo_path];
}

before(async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite();
    await db.exec(stubSql);
    await db.query('insert into auth.users (id, email) values ($1, $2), ($3, $4)',
        [ALICE, 'alice@example.test', BOB, 'bob@example.test']);
    await db.exec(migrationSql);
});

test('migration is idempotent (can be re-run in the SQL editor)', async () => {
    await db.exec(migrationSql);
    const { rows } = await db.query(
        "select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = 'incidents'");
    assert.equal(rows[0].n, 3);
});

test('row level security is enabled on incidents', async () => {
    const { rows } = await db.query(
        "select relrowsecurity from pg_class where oid = 'public.incidents'::regclass");
    assert.equal(rows[0].relrowsecurity, true);
});

test('signed-in user can submit a report; it is published as unverified', async () => {
    const { rows } = await asAlice(INSERT, report());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, ALICE, 'user_id defaults to auth.uid()');
    assert.equal(rows[0].verification_status, 'unverified');
    assert.ok(rows[0].created_at instanceof Date);
    assert.equal(rows[0].location_source, 'gps');
});

test('anonymous users cannot submit reports', async () => {
    await assert.rejects(asAnon(INSERT, report()), /permission denied/);
});

test('anonymous users see zero reports even when reports exist', async () => {
    const { rows: all } = await db.query('select count(*)::int as n from public.incidents');
    assert.ok(all[0].n > 0, 'precondition: table has rows');
    const { rows } = await asAnon('select * from public.incidents');
    assert.equal(rows.length, 0);
});

test("other signed-in users can browse a user's reports", async () => {
    const { rows } = await asBob('select user_id from public.incidents where user_id = $1', [ALICE]);
    assert.ok(rows.length >= 1);
});

test('cannot submit a report under another user id', async () => {
    await assert.rejects(
        asAlice(`insert into public.incidents (user_id, title, description, category, latitude, longitude)
                 values ($1, 'Spoofed report', 'Pretending to be someone else.', 'other', 0, 0)`, [BOB]),
        /row-level security/);
});

test('cannot mark a report verified when submitting', async () => {
    await assert.rejects(
        asAlice(`insert into public.incidents (title, description, category, latitude, longitude, verification_status)
                 values ('Self-verified', 'Trying to skip review entirely.', 'other', 0, 0, 'verified')`),
        /permission denied/);
});

test('cannot back-date a report or choose its id', async () => {
    await assert.rejects(
        asAlice(`insert into public.incidents (title, description, category, latitude, longitude, created_at)
                 values ('Back-dated', 'Pretending this happened last year.', 'other', 0, 0, now() - interval '1 year')`),
        /permission denied/);
    await assert.rejects(
        asAlice(`insert into public.incidents (id, title, description, category, latitude, longitude)
                 values (gen_random_uuid(), 'Chosen id', 'Client-chosen primary key.', 'other', 0, 0)`),
        /permission denied/);
});

test('reports cannot be edited by anyone through the API, including verification', async () => {
    await assert.rejects(asBob("update public.incidents set title = 'Hijacked'"), /permission denied/);
    await assert.rejects(asAlice("update public.incidents set title = 'Edited'"), /permission denied/);
    await assert.rejects(
        asAlice("update public.incidents set verification_status = 'verified'"), /permission denied/);
});

test("users cannot delete another user's reports but can delete their own", async () => {
    const { rows: [mine] } = await asAlice(INSERT, report({ title: 'To be deleted' }));
    const bobTry = await asBob('delete from public.incidents where id = $1', [mine.id]);
    assert.equal(bobTry.affectedRows, 0);
    const { rows: still } = await db.query('select 1 from public.incidents where id = $1', [mine.id]);
    assert.equal(still.length, 1);
    const aliceTry = await asAlice('delete from public.incidents where id = $1', [mine.id]);
    assert.equal(aliceTry.affectedRows, 1);
});

test('validation rejects bad input', async () => {
    const cases = [
        [{ category: 'protest' }, /incidents_category_valid/],
        [{ title: '  ' }, /incidents_title_length/],
        [{ description: 'short' }, /incidents_description_length/],
        [{ latitude: 91 }, /incidents_latitude_range/],
        [{ longitude: -181 }, /incidents_longitude_range/],
        [{ photo_path: `${BOB}/photo.jpg` }, /incidents_photo_path_owned/],
        [{ photo_path: `${ALICE}/../x.jpg` }, /incidents_photo_path_owned/],
        [{ photo_path: `${ALICE}/photo.gif` }, /incidents_photo_path_owned/],
    ];
    for (const [overrides, expected] of cases) {
        await assert.rejects(asAlice(INSERT, report(overrides)), expected, JSON.stringify(overrides));
    }
    const { rows } = await asAlice(INSERT, report({ photo_path: `${ALICE}/3f2a9c1e-photo.jpg` }));
    assert.equal(rows.length, 1, 'own-folder photo path is accepted');
});

test('category, recency and owner indexes exist', async () => {
    const { rows } = await db.query(
        "select indexname from pg_indexes where schemaname = 'public' and tablename = 'incidents'");
    const names = rows.map((r) => r.indexname);
    for (const idx of ['incidents_created_at_idx', 'incidents_category_created_at_idx',
        'incidents_user_id_created_at_idx']) {
        assert.ok(names.includes(idx), `missing ${idx}`);
    }
});

test('incidents table is in the Realtime publication', async () => {
    const { rows } = await db.query(
        "select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'incidents'");
    assert.equal(rows.length, 1);
});

test('photo bucket is public-read with 5 MB and image-only limits', async () => {
    const { rows } = await db.query("select * from storage.buckets where id = 'incident-photos'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].public, true);
    assert.equal(Number(rows[0].file_size_limit), 5 * 1024 * 1024);
    assert.deepEqual(rows[0].allowed_mime_types, ['image/jpeg', 'image/png', 'image/webp']);
});

test('photo uploads are restricted to the signed-in user\'s own folder', async () => {
    const upload = (who, name, bucket = 'incident-photos') =>
        who(`insert into storage.objects (bucket_id, name) values ($1, $2)`, [bucket, name]);

    await upload(asAlice, `${ALICE}/a1.jpg`);
    await upload(asAlice, `${ALICE}/a2.webp`);

    await assert.rejects(upload(asAlice, `${BOB}/x.jpg`), /row-level security/, 'other user folder');
    await assert.rejects(upload(asAlice, 'x.jpg'), /row-level security/, 'bucket root');
    await assert.rejects(upload(asAlice, `${ALICE}/nested/x.jpg`), /row-level security/, 'nested folder');
    await assert.rejects(upload(asAlice, `${ALICE}/x.exe`), /row-level security/, 'non-image extension');
    await assert.rejects(upload(asAnon, `${ALICE}/anon.jpg`), /row-level security/, 'signed-out user');

    await db.exec("insert into storage.buckets (id, name) values ('other', 'other') on conflict do nothing");
    await assert.rejects(upload(asAlice, `${ALICE}/x.jpg`, 'other'), /row-level security/, 'other bucket');
});

test('users can list and delete only their own photo objects', async () => {
    await asBob(`insert into storage.objects (bucket_id, name) values ('incident-photos', $1)`, [`${BOB}/b1.jpg`]);

    const { rows: aliceSees } = await asAlice('select name from storage.objects');
    assert.ok(aliceSees.length > 0);
    assert.ok(aliceSees.every((r) => r.name.startsWith(`${ALICE}/`)), 'Alice sees only her objects');

    const { rows: anonSees } = await asAnon('select name from storage.objects');
    assert.equal(anonSees.length, 0, 'bucket cannot be listed anonymously');

    const bobDeletes = await asBob('delete from storage.objects where name = $1', [`${ALICE}/a1.jpg`]);
    assert.equal(bobDeletes.affectedRows, 0);
    const aliceDeletes = await asAlice('delete from storage.objects where name = $1', [`${ALICE}/a1.jpg`]);
    assert.equal(aliceDeletes.affectedRows, 1);
});
