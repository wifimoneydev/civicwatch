'use strict';

// Static checks on the Cordova scaffold. These run in CI before the Android
// build so misconfiguration fails fast with a readable message.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const pkg = JSON.parse(read('package.json'));
const configXml = read('config.xml');
const indexHtml = read('www/index.html');
const workflow = read('.github/workflows/build-apk.yml');

function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name);
        return e.isDirectory() ? walk(full) : [full];
    });
}

test('config.xml declares app id, name and the index page', () => {
    assert.match(configXml, /<widget id="com\.civicwatch\.app"/);
    assert.match(configXml, /<name>CivicWatch<\/name>/);
    assert.match(configXml, /<content src="index\.html" \/>/);
});

test('config.xml version matches package.json', () => {
    const m = configXml.match(/<widget[^>]*\sversion="([^"]+)"/);
    assert.ok(m, 'widget version missing');
    assert.equal(m[1], pkg.version);
});

test('config.xml does not allow unrestricted network access or navigation', () => {
    assert.doesNotMatch(configXml, /<access origin="\*"/);
    assert.doesNotMatch(configXml, /<allow-navigation href="\*"/);
    assert.doesNotMatch(configXml, /<allow-navigation href="https?:\/\/\*/);
});

test('cordova toolchain and plugins are pinned to exact versions', () => {
    for (const name of ['cordova', 'cordova-android', ...Object.keys(pkg.cordova.plugins)]) {
        const v = pkg.devDependencies[name];
        assert.ok(v, `${name} missing from devDependencies`);
        assert.match(v, /^\d+\.\d+\.\d+$/, `${name} must be pinned exactly, got "${v}"`);
    }
    assert.deepEqual(pkg.cordova.platforms, ['android']);
});

test('index.html has a strict Content Security Policy', () => {
    const m = indexHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
    assert.ok(m, 'CSP meta tag missing');
    const csp = m[1];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'(;|$)/, 'script-src must be self only');
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.match(csp, /connect-src[^;]*https:\/\/\*\.supabase\.co/);
    assert.match(csp, /connect-src[^;]*wss:\/\/\*\.supabase\.co/);
});

test('www contains no inline scripts (CSP would block them)', () => {
    for (const file of walk(path.join(root, 'www')).filter((f) => f.endsWith('.html'))) {
        const html = fs.readFileSync(file, 'utf8');
        const inline = html.match(/<script(?![^>]*\ssrc=)[^>]*>/g);
        assert.equal(inline, null, `inline <script> in ${path.relative(root, file)}`);
    }
});

test('no Supabase secret or service-role key is bundled in www', () => {
    for (const file of walk(path.join(root, 'www'))) {
        const text = fs.readFileSync(file, 'utf8');
        const rel = path.relative(root, file);
        assert.doesNotMatch(text, /sb_secret_[A-Za-z0-9_-]{8,}/, `Supabase secret key in ${rel}`);
        for (const token of text.match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g) || []) {
            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
            assert.notEqual(payload.role, 'service_role', `service_role JWT in ${rel}`);
        }
    }
});

test('index.html loads only bundled scripts, in dependency order', () => {
    const srcs = [...indexHtml.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(srcs, [
        'cordova.js',
        `vendor/supabase-js-${pkg.devDependencies['@supabase/supabase-js']}.js`,
        'js/config.js',
        'js/config-check.js',
        'js/supabase-client.js',
        'js/auth-logic.js',
        'js/session.js',
        'js/my-reports.js',
        'js/report-logic.js',
        'js/report-submit.js',
        'js/photo.js',
        'js/report-view.js',
        'js/feed.js',
        'js/feed-view.js',
        'js/diagnostics.js',
        'js/app.js',
    ]);
    for (const src of srcs) assert.doesNotMatch(src, /^(https?:)?\/\//, `remote script ${src}`);
});

test('vendored supabase-js is the exact pinned npm build', () => {
    const version = pkg.devDependencies['@supabase/supabase-js'];
    assert.match(version, /^\d+\.\d+\.\d+$/, 'supabase-js must be pinned exactly');
    const vendored = fs.readFileSync(path.join(root, `www/vendor/supabase-js-${version}.js`));
    const upstream = fs.readFileSync(path.join(root, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js'));
    assert.ok(vendored.equals(upstream), 'run npm run vendor:supabase');
    const files = fs.readdirSync(path.join(root, 'www/vendor')).filter((f) => f.startsWith('supabase-js-'));
    assert.deepEqual(files, [`supabase-js-${version}.js`], 'stale vendored copies present');
});

test('CI workflow uses the toolchain cordova-android requires', () => {
    const defaults = JSON.parse(read('node_modules/cordova-android/framework/cdv-gradle-config-defaults.json'));
    assert.match(workflow, new RegExp(`GRADLE_VERSION: '${defaults.GRADLE_VERSION.replace(/\./g, '\\.')}'`));
    assert.match(workflow, new RegExp(`platforms;android-${defaults.SDK_VERSION}`));
    assert.match(workflow, new RegExp(`build-tools;${defaults.MIN_BUILD_TOOLS_VERSION.replace(/\./g, '\\.')}`));
    assert.match(workflow, /JAVA_VERSION: '17'/);
});
