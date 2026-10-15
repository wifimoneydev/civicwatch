'use strict';

// Checks the Supabase configuration rules and the committed www/js/config.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');
const { validateConfig } = require(path.join(root, 'www/js/config-check.js'));

const URL = 'https://abcdefghijklmnopqrst.supabase.co';
const jwt = (payload) => [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'c2lnbmF0dXJl',
].join('.');

function loadCommittedConfig() {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'www/js/config.js'), 'utf8'), sandbox);
    return sandbox.window.CIVICWATCH_CONFIG;
}

test('placeholders are reported as not configured, without throwing', () => {
    const r = validateConfig({ SUPABASE_URL: 'YOUR_SUPABASE_URL', SUPABASE_PUBLISHABLE_KEY: 'YOUR_SUPABASE_PUBLISHABLE_KEY' });
    assert.equal(r.ok, false);
    assert.equal(r.configured, false);
    assert.equal(r.errors.length, 2);
    assert.equal(validateConfig(undefined).ok, false);
});

test('a project URL with a publishable key is accepted', () => {
    const r = validateConfig({ SUPABASE_URL: `${URL}/`, SUPABASE_PUBLISHABLE_KEY: ' sb_publishable_abc123XYZ ' });
    assert.equal(r.ok, true, r.errors.join('; '));
    assert.equal(r.url, URL, 'trailing slash trimmed');
    assert.equal(r.key, 'sb_publishable_abc123XYZ', 'whitespace trimmed');
});

test('a legacy anon JWT is accepted', () => {
    assert.equal(validateConfig({ SUPABASE_URL: URL, SUPABASE_PUBLISHABLE_KEY: jwt({ role: 'anon' }) }).ok, true);
});

test('secret and service_role keys are rejected', () => {
    for (const key of ['sb_secret_abc123', jwt({ role: 'service_role' })]) {
        const r = validateConfig({ SUPABASE_URL: URL, SUPABASE_PUBLISHABLE_KEY: key });
        assert.equal(r.ok, false);
        assert.match(r.errors.join(' '), /SECRET|service_role/);
    }
});

test('malformed URLs are rejected', () => {
    for (const url of ['http://abcdefghijklmnopqrst.supabase.co', 'https://example.com',
        'https://supabase.com/dashboard/project/abcdefghijklmnopqrst']) {
        assert.equal(validateConfig({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' }).ok, false, url);
    }
});

test('committed config.js is either untouched placeholders or a valid publishable config', () => {
    const r = validateConfig(loadCommittedConfig());
    if (r.configured) assert.equal(r.ok, true, r.errors.join('; '));
    else assert.equal(r.ok, false);
});

test('config.js defines only the two expected keys', () => {
    assert.deepEqual(Object.keys(loadCommittedConfig()).sort(), ['SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL']);
});
