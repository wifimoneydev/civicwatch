'use strict';

// Report validation (cross-checked against the real database constraints in
// PGlite), helpers, and the submit flow's upload / save / cleanup behaviour.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const R = require(path.join(root, 'www/js/report-logic.js'));
const { submitReport } = require(path.join(root, 'www/js/report-submit.js'));

const USER = '11111111-1111-4111-8111-111111111111';
const valid = { title: 'Two-car collision', description: 'Collision at the junction, one lane blocked.',
    category: 'accident', latitude: '6.5244', longitude: '3.3792', locationSource: 'gps' };

describe('validateReport', () => {
    test('accepts a complete report and returns database-ready values', () => {
        const r = R.validateReport({ ...valid, title: '  Two-car collision  ' });
        assert.equal(r.ok, true, JSON.stringify(r.errors));
        assert.deepEqual(r.values, { title: 'Two-car collision', description: valid.description, category: 'accident',
            latitude: 6.5244, longitude: 3.3792, location_source: 'gps' });
    });

    test('every field is required and has a readable message', () => {
        const r = R.validateReport({});
        assert.deepEqual(Object.keys(r.errors).sort(), ['category', 'description', 'location', 'title']);
        assert.match(r.errors.location, /use your location or enter coordinates/);
    });

    test('never substitutes coordinates: missing or partial location is an error', () => {
        assert.ok(R.validateReport({ ...valid, latitude: '', longitude: '' }).errors.location);
        assert.ok(R.validateReport({ ...valid, longitude: '' }).errors.location);
        assert.equal(R.validateReport({ ...valid, latitude: '', longitude: '' }).values.latitude, null);
    });

    test('coordinate ranges and formats', () => {
        const loc = (latitude, longitude) => R.validateReport({ ...valid, latitude, longitude }).errors.location;
        assert.equal(loc('-90', '-180'), undefined);
        assert.equal(loc('90', '180'), undefined);
        assert.equal(loc('0', '0'), undefined, 'zero is a real coordinate');
        assert.match(loc('90.0001', '0'), /Latitude must be between/);
        assert.match(loc('0', '-180.5'), /Longitude must be between/);
        assert.match(loc('6,5244', '3.3'), /decimal numbers/);
        assert.match(loc('abc', '3.3'), /decimal numbers/);
        assert.match(loc('1e2', '3.3'), /decimal numbers/);
    });

    test('location source is gps only when the GPS fix was used', () => {
        assert.equal(R.validateReport({ ...valid, locationSource: 'gps' }).values.location_source, 'gps');
        assert.equal(R.validateReport({ ...valid, locationSource: undefined }).values.location_source, 'manual');
    });

    test('lengths count characters like Postgres (emoji = 1)', () => {
        assert.match(R.validateReport({ ...valid, title: '😀😀' }).errors.title, /at least 3/);
        assert.equal(R.validateReport({ ...valid, title: '😀😀😀' }).ok, true);
        assert.equal(R.validateReport({ ...valid, title: '😀'.repeat(120) }).ok, true);
    });
});

describe('validation agrees with the database constraints', () => {
    let db;
    before(async () => {
        const { PGlite } = await import('@electric-sql/pglite');
        db = new PGlite();
        await db.exec(fs.readFileSync(path.join(root, 'tests/fixtures/supabase-stub.sql'), 'utf8'));
        await db.query('insert into auth.users (id) values ($1)', [USER]);
        await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations/001_incidents_storage_realtime.sql'), 'utf8'));
    });

    async function dbAccepts(v) {
        await db.query("select set_config('request.jwt.claim.sub', $1, false)", [USER]);
        await db.exec('begin; set local role authenticated');
        try {
            await db.query(`insert into public.incidents (title, description, category, latitude, longitude, location_source)
                values ($1, $2, $3, $4, $5, $6)`, [v.title, v.description, v.category, v.latitude, v.longitude, v.location_source]);
            return true;
        } catch {
            return false;
        } finally {
            await db.exec('rollback');
        }
    }

    const cases = [];
    for (const n of [2, 3, 120, 121]) cases.push({ title: 'x'.repeat(n) });
    for (const n of [9, 10, 2000, 2001]) cases.push({ description: 'y'.repeat(n) });
    cases.push({ title: '  ab  ' }, { title: 'ab😀' }, { title: '😀😀' }, { description: '😀'.repeat(10) });
    for (const category of ['accident', 'fighting', 'rioting', 'fire', 'theft', 'other', 'Accident', 'protest']) cases.push({ category });
    for (const [latitude, longitude] of [['-90', '-180'], ['90', '180'], ['90.000001', '0'], ['0', '180.000001'], ['-90.5', '0']]) {
        cases.push({ latitude, longitude });
    }

    test('for every boundary case, the app accepts exactly what the database accepts', async () => {
        for (const overrides of cases) {
            const input = { ...valid, ...overrides };
            const check = R.validateReport(input);
            // Send what the app would send; for rejected input send the raw trimmed values.
            const values = check.ok ? check.values : {
                title: String(input.title).trim(), description: String(input.description).trim(), category: input.category,
                latitude: Number(input.latitude), longitude: Number(input.longitude), location_source: 'gps',
            };
            assert.equal(await dbAccepts(values), check.ok, `disagreement for ${JSON.stringify(overrides)}`);
        }
    });

    test('every app category is allowed by the database (and nothing else)', async () => {
        const { rows } = await db.query(
            "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'incidents_category_valid'");
        const dbCategories = [...rows[0].def.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]).sort();
        assert.deepEqual(R.CATEGORIES.map((c) => c.value).sort(), dbCategories);
        for (const c of ['accident', 'fighting', 'rioting']) assert.ok(dbCategories.includes(c), `missing ${c}`);
    });
});

describe('helpers', () => {
    test('fitWithin keeps the aspect ratio and never upscales', () => {
        assert.deepEqual(R.fitWithin(4000, 3000, 1600), { width: 1600, height: 1200 });
        assert.deepEqual(R.fitWithin(3000, 4000, 1600), { width: 1200, height: 1600 });
        assert.deepEqual(R.fitWithin(800, 600, 1600), { width: 800, height: 600 });
        const r = R.fitWithin(4032, 1816, 1600);
        assert.ok(Math.abs(r.width / r.height - 4032 / 1816) < 0.01);
    });

    test('geolocation errors map to actionable messages', () => {
        assert.match(R.describeGeoError({ code: 1 }), /permission was denied/);
        assert.match(R.describeGeoError({ code: 2 }), /not available/);
        assert.match(R.describeGeoError({ code: 3 }), /took too long/);
        assert.match(R.describeGeoError({}), /enter the coordinates/i);
    });

    test('camera cancellation is recognised', () => {
        assert.equal(R.isCameraCancel('No Image Selected'), true);
        assert.equal(R.isCameraCancel('Selection did not complete!'), true);
        assert.equal(R.isCameraCancel('Unable to create bitmap!'), false);
    });

    test('photo limits match the storage bucket', () => {
        const sql = fs.readFileSync(path.join(root, 'supabase/migrations/001_incidents_storage_realtime.sql'), 'utf8');
        assert.match(sql, new RegExp(`'incident-photos', true, ${R.LIMITS.PHOTO_MAX_BYTES},`));
        for (const t of R.PHOTO_TYPES) assert.ok(sql.includes(`'${t}'`), t);
    });
});

describe('submitReport', () => {
    const values = R.validateReport(valid).values;
    const photo = { blob: new Blob([Buffer.from('jpeg-bytes')], { type: 'image/jpeg' }) };
    const netError = () => ({ message: 'TypeError: Failed to fetch', code: '' });

    // Fake supabase client recording every call. `plan` controls outcomes.
    function fakeClient(plan = {}) {
        const calls = [];
        const saved = [];
        const query = (table) => {
            const filters = [];
            const q = {
                insert(row) { calls.push(['insert', table, row]); q._row = row; return q; },
                select() { return q; },
                eq(col, val) { filters.push([col, val]); return q; },
                gte() { return q; },
                limit() {
                    calls.push(['lookup', filters.slice()]);
                    if (plan.lookup === 'error') return Promise.resolve({ data: null, error: netError() });
                    const match = saved.filter((r) => filters.every(([c, v]) => r[c] === v));
                    return Promise.resolve({ data: match, error: null });
                },
                async single() {
                    if (plan.insert === 'reject') return { data: null, status: 400, error: { code: '23514', message: 'violates check constraint' } };
                    if (plan.insert === 'expired') return { data: null, status: 401, error: { code: 'PGRST301', message: 'JWT expired' } };
                    const row = { id: 'r1', ...q._row, verification_status: 'unverified', created_at: new Date().toISOString() };
                    if (plan.insert === 'lost-after-save') { saved.push(row); return { data: null, status: 0, error: netError() }; }
                    if (plan.insert === 'network') return { data: null, status: 0, error: netError() };
                    saved.push(row);
                    return { data: row, status: 201, error: null };
                },
            };
            return q;
        };
        return {
            calls,
            from: query,
            storage: {
                from: (bucket) => ({
                    async upload(p, body, opts) {
                        calls.push(['upload', bucket, p, opts.contentType, opts.upsert]);
                        if (plan.upload === 'network') return { data: null, error: { message: 'Failed to fetch' } };
                        if (plan.upload === 'too-large') return { data: null, error: { statusCode: '413', message: 'The object exceeded the maximum allowed size' } };
                        return { data: { path: p }, error: null };
                    },
                    async remove(paths) { calls.push(['remove', bucket, paths]); return { data: [], error: null }; },
                }),
            },
        };
    }

    const kinds = (client) => client.calls.map((c) => c[0]);

    test('uploads to <user id>/<random uuid>.jpg, then saves the report with that path', async () => {
        const client = fakeClient();
        const stages = [];
        const res = await submitReport(client, { userId: USER, values, photo, onProgress: (s) => stages.push(s) });
        assert.equal(res.ok, true);
        assert.deepEqual(stages, ['upload', 'save']);
        const [, bucket, photoPath, contentType, upsert] = client.calls[0];
        assert.equal(bucket, 'incident-photos');
        assert.match(photoPath, new RegExp(`^${USER}/[0-9a-f-]{36}\\.jpg$`));
        assert.equal(contentType, 'image/jpeg');
        assert.equal(upsert, false, 'never overwrite an existing object');
        const insert = client.calls.find((c) => c[0] === 'insert')[2];
        assert.equal(insert.user_id, USER);
        assert.equal(insert.photo_path, photoPath);
        assert.equal(insert.location_source, 'gps');
        assert.equal(res.report.verification_status, 'unverified');
    });

    test('two submissions never reuse a file name', async () => {
        const client = fakeClient();
        await submitReport(client, { userId: USER, values, photo });
        await submitReport(client, { userId: USER, values, photo });
        const paths = client.calls.filter((c) => c[0] === 'upload').map((c) => c[2]);
        assert.notEqual(paths[0], paths[1]);
    });

    test('a report without a photo saves photo_path = null and uploads nothing', async () => {
        const client = fakeClient();
        const res = await submitReport(client, { userId: USER, values, photo: null });
        assert.equal(res.ok, true);
        assert.deepEqual(kinds(client), ['insert']);
        assert.equal(client.calls[0][2].photo_path, null);
    });

    test('upload failure: nothing is saved', async () => {
        for (const upload of ['network', 'too-large']) {
            const client = fakeClient({ upload });
            const res = await submitReport(client, { userId: USER, values, photo });
            assert.equal(res.ok, false);
            assert.equal(res.stage, 'upload');
            assert.deepEqual(kinds(client), ['upload'], upload);
        }
    });

    test('save rejected by the server: the uploaded photo is deleted', async () => {
        const client = fakeClient({ insert: 'reject' });
        const res = await submitReport(client, { userId: USER, values, photo });
        assert.equal(res.ok, false);
        assert.equal(res.stage, 'save');
        assert.equal(res.photoCleanup, 'removed');
        const uploaded = client.calls[0][2];
        assert.deepEqual(client.calls.find((c) => c[0] === 'remove')[2], [uploaded]);
    });

    test('connection lost after the database saved the report: treated as success, photo kept', async () => {
        const client = fakeClient({ insert: 'lost-after-save' });
        const res = await submitReport(client, { userId: USER, values, photo });
        assert.equal(res.ok, true);
        assert.equal(res.recovered, true);
        assert.ok(!kinds(client).includes('remove'), 'must not delete the photo of a saved report');
    });

    test('connection lost and the outcome cannot be checked: photo kept, error shown', async () => {
        const client = fakeClient({ insert: 'network', lookup: 'error' });
        const res = await submitReport(client, { userId: USER, values, photo });
        assert.equal(res.ok, false);
        assert.equal(res.photoCleanup, 'kept');
        assert.ok(!kinds(client).includes('remove'));
    });

    test('connection lost and lookup confirms nothing was saved: photo deleted', async () => {
        const client = fakeClient({ insert: 'network' });
        const res = await submitReport(client, { userId: USER, values, photo });
        assert.equal(res.ok, false);
        assert.equal(res.photoCleanup, 'removed');
    });

    test('lost connection on a report without a photo: a saved report is found, not duplicated', async () => {
        const client = fakeClient({ insert: 'lost-after-save' });
        const res = await submitReport(client, { userId: USER, values, photo: null });
        assert.equal(res.ok, true);
        assert.equal(kinds(client).filter((k) => k === 'insert').length, 1);
    });

    test('expired token on save reports HTTP 401 so the app can sign out', async () => {
        const res = await submitReport(fakeClient({ insert: 'expired' }), { userId: USER, values, photo: null });
        assert.equal(res.ok, false);
        assert.equal(res.status, 401);
    });

    test('refuses to run without a user id', async () => {
        await assert.rejects(submitReport(fakeClient(), { userId: null, values, photo: null }), /user id/);
    });
});
