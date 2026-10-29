const supabase = require('../supabase');
const { INTERNAL_TEAM_ROLE } = require('./auth');
const { hasTeamPermission, sanitizePermissions } = require('../services/teamPermissions');

const TEAM_MEMBER_COLUMNS = 'id, name, email, phone, department, designation, status, permissions, created_at, last_login_at';

/**
 * Loads the caller's internal_team_members row on EVERY request (must run after
 * verifyTeamToken). The JWT only proves who the caller is; status and permissions come
 * from the database, so an Admin deactivating a member or removing a page takes effect
 * on the member's very next request instead of when their 24h token expires.
 */
async function loadTeamMember(req, res, next) {
    if (!req.user || req.user.role !== INTERNAL_TEAM_ROLE) {
        return res.status(403).json({ error: 'Forbidden: internal team access only.' });
    }
    try {
        const { data: member, error } = await supabase
            .from('internal_team_members')
            .select(TEAM_MEMBER_COLUMNS)
            .eq('id', req.user.id)
            .maybeSingle();
        if (error) throw error;
        if (!member) {
            return res.status(401).json({ error: 'Account not found.', code: 'TEAM_ACCOUNT_INVALID' });
        }
        if (member.status !== 'approved') {
            return res.status(403).json({ error: 'Your access is not active. Contact an Admin.', code: 'TEAM_ACCOUNT_INACTIVE' });
        }
        req.teamMember = { ...member, permissions: sanitizePermissions(member.permissions) };
        next();
    } catch (err) {
        console.error('[team] loadTeamMember error:', err);
        res.status(500).json({ error: 'Unable to verify team access.' });
    }
}

/** Gate a route to members whose permissions include module/action. Must run after loadTeamMember. */
function requireTeamPermission(module, action = 'view') {
    return (req, res, next) => {
        if (!req.teamMember || !hasTeamPermission(req.teamMember.permissions, module, action)) {
            return res.status(403).json({ error: `Forbidden: no ${action} access to ${module}.`, code: 'TEAM_PERMISSION_DENIED' });
        }
        next();
    };
}

module.exports = { loadTeamMember, requireTeamPermission, TEAM_MEMBER_COLUMNS };
