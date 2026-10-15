// Shared helpers for the live check scripts: config loading, hidden password
// prompt, and a supabase-js client that never persists sessions.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { validateConfig } = require(path.join(root, 'www/js/config-check.js'));
const { createClient } = require('@supabase/supabase-js');

export function loadConfig() {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'www/js/config.js'), 'utf8'), sandbox);
    return validateConfig(sandbox.window.CIVICWATCH_CONFIG);
}

export const newClient = (cfg) => createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });

export function ask(question, hidden = false) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
        // Print the prompt, suppress echo of what is typed.
        rl._writeToOutput = (text) => { if (text.includes(question)) rl.output.write(question); };
    }
    return new Promise((resolve) => rl.question(question, (answer) => {
        rl.close();
        if (hidden) process.stdout.write('\n');
        resolve(answer.trim());
    }));
}

// Reads <PREFIX>_EMAIL / <PREFIX>_PASSWORD from the environment, else prompts.
export async function credentials(label, prefix) {
    const email = process.env[`${prefix}_EMAIL`] || await ask(`Account ${label} email: `);
    const password = process.env[`${prefix}_PASSWORD`] || await ask(`Account ${label} password (hidden): `, true);
    return { email: email.toLowerCase(), password };
}

export function reporter() {
    let failures = 0;
    return {
        pass: (msg) => console.log(`  PASS  ${msg}`),
        fail(msg, detail) { failures += 1; console.log(`  FAIL  ${msg}${detail ? ` -> ${detail}` : ''}`); },
        expect(cond, msg, detail) { if (cond) this.pass(msg); else this.fail(msg, detail); },
        get failures() { return failures; },
    };
}

export const describeError = (error) => (error ? `${error.code || error.statusCode || ''} ${error.message}`.trim() : 'no error');
