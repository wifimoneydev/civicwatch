// Live connection check against the Supabase project in www/js/config.js.
//   npm run check:supabase
// Runs signed out with the publishable key, exactly like the app before login.
// An empty incidents table is a success. Never prints the key.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { validateConfig } = require(path.join(root, 'www/js/config-check.js'));
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'incident-photos';
const TIMEOUT_MS = 10000;

let failures = 0;
const pass = (msg) => console.log(`  PASS  ${msg}`);
const fail = (msg, hint) => {
    failures += 1;
    console.log(`  FAIL  ${msg}`);
    if (hint) console.log(`        -> ${hint}`);
};

function loadConfig() {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'www/js/config.js'), 'utf8'), sandbox);
    return sandbox.window.CIVICWATCH_CONFIG;
}

const withTimeout = (promise, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS)),
]);

async function main() {
    console.log('CivicWatch Supabase connection check\n');

    // 1. Configuration
    const cfg = validateConfig(loadConfig());
    if (!cfg.ok) {
        cfg.errors.forEach((e) => fail('config.js', e));
        return;
    }
    pass(`config.js: ${cfg.url} with a publishable key`);
    const headers = { apikey: cfg.key };

    // 2. Auth service reachable and key accepted
    try {
        const res = await withTimeout(fetch(`${cfg.url}/auth/v1/settings`, { headers }), 'Auth');
        if (res.ok) {
            const settings = await res.json();
            pass(`Auth reachable (email sign-up ${settings.external?.email ? 'enabled' : 'DISABLED'}, ` +
                `email confirmation ${settings.mailer_autoconfirm ? 'OFF' : 'ON'})`);
        } else {
            fail(`Auth returned HTTP ${res.status}`, res.status === 401
                ? 'The key was rejected. Copy the publishable key again from Project Settings -> API Keys.'
                : 'Check the Project URL.');
            return;
        }
    } catch (e) {
        fail(`Auth unreachable: ${e.message}`, 'Check the Project URL, your internet connection, and that the project is not paused.');
        return;
    }

    // 3. Data API + incidents table (signed out => RLS returns zero rows)
    const supabase = createClient(cfg.url, cfg.key, { auth: { persistSession: false } });
    try {
        const { data, error } = await withTimeout(supabase.from('incidents').select('id').limit(1), 'Data API');
        if (error) {
            const hint = error.code === 'PGRST205'
                ? 'Run supabase/migrations/001_incidents_storage_realtime.sql in the SQL Editor.'
                : error.code === '42501'
                    ? 'Grants are missing: re-run the SQL file.'
                    : undefined;
            fail(`incidents query failed: ${error.code || ''} ${error.message}`, hint);
        } else {
            pass(`incidents table reachable (${data.length} rows visible while signed out; 0 is expected)`);
        }
    } catch (e) {
        fail(`incidents query failed: ${e.message}`);
    }

    // 4. Storage bucket exists (probe a file that does not exist)
    try {
        const res = await withTimeout(
            fetch(`${cfg.url}/storage/v1/object/public/${BUCKET}/connection-check-does-not-exist.jpg`, { headers }),
            'Storage');
        const body = await res.text();
        if (/bucket not found/i.test(body)) {
            fail(`Storage bucket "${BUCKET}" not found`, 'Run the SQL file (section 4 creates the bucket).');
        } else if (/object not found|not_found/i.test(body)) {
            pass(`Storage bucket "${BUCKET}" exists and serves public URLs`);
        } else {
            fail(`Unexpected Storage response HTTP ${res.status}: ${body.slice(0, 200)}`);
        }
    } catch (e) {
        fail(`Storage unreachable: ${e.message}`);
    }

    // 5. Realtime subscription to incident inserts
    const channel = supabase.channel('connection-check');
    try {
        const status = await withTimeout(new Promise((resolve) => {
            channel
                .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'incidents' }, () => {})
                .subscribe((s, err) => {
                    if (s === 'SUBSCRIBED') resolve(s);
                    else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT' || s === 'CLOSED') resolve(`${s}${err ? `: ${err.message}` : ''}`);
                });
        }), 'Realtime');
        if (status === 'SUBSCRIBED') pass('Realtime subscription to incidents accepted');
        else fail(`Realtime subscription failed (${status})`, 'Re-run the SQL file (section 5) and check Realtime is enabled for the project.');
    } catch (e) {
        fail(`Realtime: ${e.message}`);
    } finally {
        await supabase.removeChannel(channel);
    }
}

await main();
console.log(failures === 0
    ? '\nRESULT: connection OK. For signed-in access checks run: npm run check:policies'
    : `\nRESULT: ${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
