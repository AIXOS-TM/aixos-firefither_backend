const crypto = require('crypto');
const supabase = require('../supabase');

/**
 * Internal Team invitations (table internal_team_invitations, migration
 * 20261028100000_internal_team_invitations.sql).
 *
 * The emailed link carries a 32-byte random token; only its SHA-256 is stored, so a
 * database read can't be turned into a working link. A token this random doesn't need
 * a slow hash. The raw token exists only in memory long enough to put it in the email.
 */
const INVITE_TTL_HOURS = 72;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Columns safe to return to Admin (never token_hash).
const INVITATION_COLUMNS = 'id, email, invited_by, expires_at, sent_at, send_count, used_at, member_id, revoked_at, revoked_by, created_at';

const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const newExpiry = () => new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000).toISOString();
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

function invitationStatus(inv, now = Date.now()) {
    if (inv.used_at) return 'used';
    if (inv.revoked_at) return 'revoked';
    if (new Date(inv.expires_at).getTime() <= now) return 'expired';
    return 'pending';
}

const withStatus = (inv) => ({ ...inv, status: invitationStatus(inv) });

// Public error for a token that can't be used. Same 'invalid' answer for a malformed
// or unknown token, so the endpoint can't be used to probe for invitations.
const INVITE_ERRORS = {
    invalid: { status: 400, code: 'INVITE_INVALID', error: 'This invitation link is not valid.' },
    expired: { status: 410, code: 'INVITE_EXPIRED', error: 'This invitation has expired. Ask an Admin to send a new one.' },
    used: { status: 410, code: 'INVITE_USED', error: 'This invitation has already been used. Sign in with your account instead.' },
    revoked: { status: 410, code: 'INVITE_REVOKED', error: 'This invitation was cancelled by an Admin.' },
};

/** The invitation row for a raw token, or null. */
async function findByToken(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const { data, error } = await supabase
        .from('internal_team_invitations')
        .select(INVITATION_COLUMNS)
        .eq('token_hash', hashToken(token))
        .maybeSingle();
    if (error) throw error;
    return data;
}

/**
 * Atomically marks a pending invitation used (only one concurrent request can win).
 * Returns { invitation } or { reason } with an INVITE_ERRORS key.
 */
async function claim(token) {
    const inv = await findByToken(token);
    if (!inv) return { reason: 'invalid' };
    const status = invitationStatus(inv);
    if (status !== 'pending') return { reason: status };
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
        .from('internal_team_invitations')
        .update({ used_at: nowIso })
        .eq('id', inv.id)
        .is('used_at', null)
        .is('revoked_at', null)
        .gt('expires_at', nowIso)
        .select(INVITATION_COLUMNS)
        .maybeSingle();
    if (error) throw error;
    if (!data) {
        // Lost a race (used/revoked/expired in between) — report what it is now.
        const current = await findByToken(token);
        const now = current ? invitationStatus(current) : 'invalid';
        return { reason: now === 'pending' ? 'invalid' : now };
    }
    return { invitation: data };
}

/** Undo a claim when registration failed after it, so the link still works. */
async function releaseClaim(id) {
    await supabase.from('internal_team_invitations').update({ used_at: null }).eq('id', id).is('member_id', null);
}

module.exports = {
    INVITE_TTL_HOURS, EMAIL_RE, INVITATION_COLUMNS, INVITE_ERRORS,
    newToken, hashToken, newExpiry, normalizeEmail, invitationStatus, withStatus,
    findByToken, claim, releaseClaim,
};
