'use strict';

// Copies the pinned @supabase/supabase-js browser bundle into www/vendor so the
// APK never fetches JavaScript from a CDN. Run after changing the version:
//   npm run vendor:supabase   (then update the <script> tag in www/index.html)

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const version = require('@supabase/supabase-js/package.json').version;
const source = path.join(root, 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
const vendorDir = path.join(root, 'www/vendor');
const target = path.join(vendorDir, `supabase-js-${version}.js`);

for (const f of fs.readdirSync(vendorDir)) {
    if (/^supabase-js-.*\.js$/.test(f) && path.join(vendorDir, f) !== target) {
        fs.rmSync(path.join(vendorDir, f));
        console.log(`removed www/vendor/${f}`);
    }
}
fs.copyFileSync(source, target);
fs.copyFileSync(path.join(root, 'node_modules/@supabase/supabase-js/LICENSE'),
    path.join(vendorDir, 'supabase-js.LICENSE.txt'));
console.log(`copied supabase-js ${version} -> ${path.relative(root, target)} (+ LICENSE)`);
