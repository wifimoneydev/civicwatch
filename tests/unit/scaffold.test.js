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

test('index.html loads cordova.js before app scripts', () => {
    const cordova = indexHtml.indexOf('src="cordova.js"');
    const app = indexHtml.indexOf('src="js/app.js"');
    assert.ok(cordova > -1 && app > cordova);
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
        assert.doesNotMatch(text, /service_role/i, `service_role reference in ${rel}`);
        assert.doesNotMatch(text, /sb_secret_/, `Supabase secret key in ${rel}`);
    }
});

test('CI workflow uses the toolchain cordova-android requires', () => {
    const defaults = JSON.parse(read('node_modules/cordova-android/framework/cdv-gradle-config-defaults.json'));
    assert.match(workflow, new RegExp(`GRADLE_VERSION: '${defaults.GRADLE_VERSION.replace(/\./g, '\\.')}'`));
    assert.match(workflow, new RegExp(`platforms;android-${defaults.SDK_VERSION}`));
    assert.match(workflow, new RegExp(`build-tools;${defaults.MIN_BUILD_TOOLS_VERSION.replace(/\./g, '\\.')}`));
    assert.match(workflow, /JAVA_VERSION: '17'/);
});
