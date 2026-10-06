const supabase = require('../supabase');
const { recordInquiryEvent } = require('./inquiryEvents');

// agents_status_check allows only these (migration 20260417120000_agents_approval_status.sql).
const AGENT_STATUSES = ['pending', 'accepted', 'rejected', 'hold'];
const CLOSED_INQUIRY_STATUSES = ['completed', 'closed', 'rejected', 'cancelled'];

// Same statuses Agent login accepts (routes/auth.js): 'accepted', plus legacy 'active'.
// In practice an Agent on 'hold' / 'rejected' (or whose record is gone) is inactive —
// they've left or can't sign in, so their work must go back to Admin.
function isActiveAgentStatus(status) {
    const s = String(status || '').trim().toLowerCase();
    return s === 'accepted' || s === 'active';
}

/** All Admin ids, as notification recipient strings. */
async function adminRecipientIds() {
    const { data, error } = await supabase.from('admins').select('id');
    if (error) throw new Error(`Unable to load admins: ${error.message}`);
    return (data || []).map((a) => String(a.id));
}

/** Open (not completed / closed / rejected / cancelled) inquiries assigned to an Agent. */
async function openInquiriesForAgent(agentId) {
    const { data, error } = await supabase
        .from('inquiries')
        .select('id, inquiry_no, status')
        .eq('agent_id', agentId);
    if (error) throw new Error(`Unable to load agent inquiries: ${error.message}`);
    return (data || []).filter((i) => !CLOSED_INQUIRY_STATUSES.includes(String(i.status || '').trim().toLowerCase()));
}

/**
 * Admin changes an Agent's status (Admin Agents page). When an active Agent becomes
 * inactive (hold / rejected — e.g. they left), every open inquiry still assigned to them
 * is routed to Admin:
 *   - the inquiry rows are NOT changed — agent_id, number, customer, items and history
 *     stay as they are (nothing is deleted or auto-assigned to another Agent); Admin
 *     reassigns each one (PUT /admin/inquiries/:id/assign-agent, "Needs Agent" filter)
 *   - each gets a 'routed_to_admin' timeline event (reason 'agent_inactive')
 *   - every Admin gets one notification linking to the Needs Agent list
 * New customer requests from that Agent's customers already go to Admin
 * (inquiryService.resolveCreatorAgent checks the same status).
 */
async function setAgentStatus(agentId, nextStatus, actingAdmin) {
    const fail = (code, message) => ({ ok: false, code, message });
    const status = String(nextStatus || '').trim().toLowerCase();
    if (!AGENT_STATUSES.includes(status)) return fail(400, `status must be one of: ${AGENT_STATUSES.join(', ')}.`);

    const { data: agent, error: agentErr } = await supabase
        .from('agents').select('id, name, email, status').eq('id', agentId).maybeSingle();
    if (agentErr && agentErr.code !== '22P02') throw new Error(`Unable to update agent: ${agentErr.message}`);
    if (!agent) return fail(404, 'Agent not found.');

    const { data: updated, error: updateErr } = await supabase
        .from('agents').update({ status }).eq('id', agent.id).select().maybeSingle();
    if (updateErr) throw new Error(`Unable to update agent: ${updateErr.message}`);
    if (!updated) return fail(404, 'Agent not found.');

    let routed = [];
    if (isActiveAgentStatus(agent.status) && !isActiveAgentStatus(status)) {
        routed = await openInquiriesForAgent(agent.id);
        for (const inq of routed) {
            await recordInquiryEvent({
                inquiryId: inq.id,
                eventType: 'routed_to_admin',
                actor: { id: actingAdmin?.id, role: 'admin' },
                metadata: { reason: 'agent_inactive', agent_id: agent.id, agent_status: status },
            });
        }
        if (routed.length > 0) {
            try {
                const label = agent.name || agent.email || `#${agent.id}`;
                const n = routed.length;
                const rows = (await adminRecipientIds()).map((id) => ({
                    sender_id: actingAdmin?.id != null ? String(actingAdmin.id) : null,
                    sender_role: 'Admin',
                    recipient_id: id,
                    recipient_role: 'Admin',
                    message: `Agent ${label} is no longer active (${status}). ${n} open ${n === 1 ? 'inquiry needs' : 'inquiries need'} a new Agent.`,
                    inquiry_id: null,
                    type: 'agent_inactive',
                    title: 'Inquiries need a new Agent',
                }));
                if (rows.length > 0) {
                    const { error } = await supabase.from('notifications').insert(rows);
                    if (error) console.error('[agentStatus] admin notification error:', error.message);
                }
            } catch (err) {
                console.error('[agentStatus] admin notification failed:', err?.message || err);
            }
        }
    }

    return { ok: true, data: { agent: updated, routed_to_admin: routed.map((i) => i.inquiry_no || i.id) } };
}

module.exports = { AGENT_STATUSES, isActiveAgentStatus, adminRecipientIds, setAgentStatus };
