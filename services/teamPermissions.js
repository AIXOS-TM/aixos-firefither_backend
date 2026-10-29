/**
 * Internal Team page-level permissions.
 *
 * Each module is one existing Admin page an internal team member can be given. A
 * module lists only the actions its /api/team endpoints actually implement — Admin
 * can't grant an action no route checks for. Phase 1 is view/analyze everywhere, plus
 * the existing Admin workflows that are safe to delegate:
 *   agents.edit       — change an Agent's status (services/agentStatus.js)
 *   inquiries.assign  — assign an active Agent to a customer request
 *                       (inquiryService.assignAgentToCustomerRequest)
 *   complaints.reply  — reply in a complaint conversation as themselves
 *                       (POST /api/team/complaints/:role/:userId/replies)
 *
 * To add a page later: add it here, add its routes in routes/team.js guarded by
 * requireTeamPermission('<module>', '<action>'), and mirror the entry in the frontend's
 * src/constants/teamPermissions.js (labels / sidebar). Stored values outside this
 * catalog are dropped by sanitizePermissions and never grant anything.
 */
const TEAM_PERMISSION_CATALOG = {
    agents:     { label: 'Agents',     actions: ['view', 'edit'] },
    customers:  { label: 'Customers',  actions: ['view'] },
    partners:   { label: 'Partners',   actions: ['view'] },
    products:   { label: 'Products',   actions: ['view'] },
    inquiries:  { label: 'Inquiries',  actions: ['view', 'assign'] },
    complaints: { label: 'Complaints', actions: ['view', 'reply'] },
};

const TEAM_ACTIONS = ['view', 'create', 'edit', 'assign', 'reply', 'delete'];

/**
 * Normalizes an untrusted permissions object to { module: [actions] } containing only
 * catalog modules/actions. Any non-view action implies 'view' (can't edit a page you
 * can't open). Modules left with no actions are dropped.
 */
function sanitizePermissions(input) {
    const result = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return result;
    for (const [module, def] of Object.entries(TEAM_PERMISSION_CATALOG)) {
        const requested = Array.isArray(input[module]) ? input[module] : [];
        const actions = def.actions.filter((a) => requested.includes(a));
        if (actions.length === 0) continue;
        if (!actions.includes('view')) actions.unshift('view');
        result[module] = actions;
    }
    return result;
}

function hasTeamPermission(permissions, module, action = 'view') {
    const clean = sanitizePermissions(permissions);
    return Array.isArray(clean[module]) && clean[module].includes(action);
}

module.exports = { TEAM_PERMISSION_CATALOG, TEAM_ACTIONS, sanitizePermissions, hasTeamPermission };
