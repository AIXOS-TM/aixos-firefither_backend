// One-off: replace legacy plain-text admin passwords with bcrypt hashes.
//
// Run ONLY after the backend with bcrypt admin login (routes/auth.js) is deployed —
// an older backend compares admin passwords as plain text and would lock admins out.
// Safe to re-run: rows that already hold a bcrypt hash are skipped, and each update is
// conditioned on the old value so a concurrent password change isn't overwritten.
//
//   node scripts/hash-admin-passwords.js           # dry run: counts only
//   node scripts/hash-admin-passwords.js --apply   # hash them
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const supabase = require('../supabase');

const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$/;
const apply = process.argv.includes('--apply');

(async () => {
    const { data: admins, error } = await supabase.from('admins').select('id, password');
    if (error) throw error;
    const legacy = admins.filter((a) => a.password && !BCRYPT_HASH.test(a.password));
    console.log(`${admins.length} admins, ${legacy.length} with plain-text passwords.`);
    if (!apply) {
        console.log('Dry run — pass --apply to hash them.');
        return;
    }
    let done = 0;
    for (const a of legacy) {
        const { data, error: upErr } = await supabase
            .from('admins')
            .update({ password: bcrypt.hashSync(a.password, 10) })
            .eq('id', a.id)
            .eq('password', a.password)
            .select('id');
        if (upErr) console.error(`admin ${a.id}: ${upErr.message}`);
        else if (data.length) done += 1;
    }
    console.log(`Hashed ${done} of ${legacy.length}.`);
})().catch((err) => { console.error(err.message || err); process.exit(1); });
