const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { verifyToken } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');
const { recordInquiryEvent } = require('../services/inquiryEvents');
const inquiryService = require('../services/inquiryService');
const agentStatus = require('../services/agentStatus');
const { TEAM_PERMISSION_CATALOG, sanitizePermissions } = require('../services/teamPermissions');
const { rateLimit } = require('../middleware/rateLimit');
const { transporter, logSmtpError, escapeHtml, frontendUrl, emailUser } = require('../services/mailer');
const { INVITE_TTL_HOURS, EMAIL_RE, INVITATION_COLUMNS, newToken, hashToken, newExpiry, normalizeEmail, invitationStatus, withStatus } = require('../services/teamInvitations');

// Every route in this file is admin-only.
router.use(verifyToken, requireRole('admin'));

// GET /api/admin/agents?status=Pending
router.get('/agents', async (req, res) => {
    const { status } = req.query;
    try {
        let query = supabase
            .from('agents')
            .select('id, name, email, phone, cnic, territory, status, created_at, profile_photo, cnic_document');

        if (status) {
            query = query.eq('status', status);
        }

        const { data, error } = await query.order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'DB Error' });
    }
});

// APPROVE AGENT
router.put('/agents/:id/approve', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('agents')
            .update({ status: 'Active' })
            .eq('id', id);

        if (error) throw error;
        res.json({ message: 'Agent approved successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'DB update failed' });
    }
});

// REJECT AGENT
router.put('/agents/:id/reject', async (req, res) => {
    const { id } = req.params;
    try {
        const { error } = await supabase
            .from('agents')
            .update({ status: 'Suspended' })
            .eq('id', id);

        if (error) throw error;
        res.json({ message: 'Agent rejected' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'DB update failed' });
    }
});

// GET ADMIN DASHBOARD STATS
router.get('/stats', async (req, res) => {
    try {
        const stats = {};

        const { count: totalAgents } = await supabase.from('agents').select('*', { count: 'exact', head: true });
        const { count: pendingAgents } = await supabase.from('agents').select('*', { count: 'exact', head: true }).eq('status', 'Pending');
        const { count: totalCustomers } = await supabase.from('customers').select('*', { count: 'exact', head: true });
        const { count: totalServices } = await supabase.from('services').select('*', { count: 'exact', head: true });

        stats.totalAgents = totalAgents || 0;
        stats.pendingAgents = pendingAgents || 0;
        stats.totalCustomers = totalCustomers || 0;
        stats.totalServices = totalServices || 0;

        // Mock Revenue Data for Chart
        stats.revenueChart = [
            { name: 'Jan', revenue: 4000, services: 24 },
            { name: 'Feb', revenue: 3000, services: 18 },
            { name: 'Mar', revenue: 2000, services: 12 },
            { name: 'Apr', revenue: 2780, services: 20 },
            { name: 'May', revenue: 1890, services: 15 },
            { name: 'Jun', revenue: 5390, services: 30 },
        ];

        res.json(stats);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// GET MAP DATA (Global View)
router.get('/map-data', async (req, res) => {
    try {
        const { data: agents, error: aError } = await supabase
            .from('agents')
            .select('id, name, email, territory, status, location_lat, location_lng, last_active')
            .eq('status', 'Active');

        if (aError) throw aError;

        const { data: customers, error: cError } = await supabase
            .from('customers')
            .select('id, business_name, address, status, location_lat, location_lng');

        if (cError) throw cError;

        const formattedAgents = agents.map(a => ({
            ...a,
            lat: a.location_lat || (40.7128 + (Math.random() * 0.1 - 0.05)),
            lng: a.location_lng || (-74.0060 + (Math.random() * 0.1 - 0.05)),
            type: 'agent'
        }));

        const formattedCustomers = customers.map(c => ({
            ...c,
            lat: c.location_lat || (40.7128 + (Math.random() * 0.2 - 0.1)),
            lng: c.location_lng || (-74.0060 + (Math.random() * 0.2 - 0.1)),
            type: 'customer'
        }));

        res.json({
            agents: formattedAgents,
            customers: formattedCustomers
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// GET ALL CUSTOMERS
router.get('/customers', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('customers')
            .select('id, business_name, owner_name, email, phone, address, business_type, status, created_at')
            .order('created_at', { ascending: false });

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// GLOBAL SERVICE AVAILABILITY — the Admin-level master switch per
// (service_type, service_subtype), ANDed with each Partner's own setting in
// partner_service_availability wherever availability is checked (Agent form,
// inquiry creation pre-check, and the DB trigger which is the real
// enforcement layer). This whole file is already admin-gated by the
// verifyToken + requireRole('admin') middleware above, so no extra
// role-check is needed per route here — matching the rest of this file's
// style. Response envelope is { success, data, error } (unlike this file's
// older routes) to match the existing convention used by the equivalent
// partner-side endpoints in partnerController.js.
const VALID_SERVICE_TYPES = new Set(['Validation', 'Refill', 'New Unit', 'Maintenance']);
const VALID_SERVICE_SUBTYPES = new Set(['default', 'new', 'followup', 'license-renewal']);

// GET /api/admin/service-availability
router.get('/service-availability', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('service_availability')
            .select('id, service_type, service_subtype, is_enabled')
            .order('service_type', { ascending: true });

        if (error) throw error;
        res.json({ success: true, data: data || [], error: null });
    } catch (err) {
        console.error('[admin] GET service-availability error:', err);
        res.status(500).json({ success: false, data: null, error: err.message || 'Failed to fetch service availability.' });
    }
});

// PUT /api/admin/service-availability  { updates: [{ service_type, service_subtype, is_enabled }] }
router.put('/service-availability', async (req, res) => {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : null;
    if (!updates || updates.length === 0) {
        return res.status(400).json({ success: false, data: null, error: 'updates array is required.' });
    }

    for (const u of updates) {
        const subtype = u.service_subtype || 'default';
        if (!VALID_SERVICE_TYPES.has(u.service_type) || !VALID_SERVICE_SUBTYPES.has(subtype)) {
            return res.status(400).json({
                success: false,
                data: null,
                error: `Invalid service_type/service_subtype: ${u.service_type}/${subtype}`
            });
        }
    }

    const rows = updates.map((u) => ({
        service_type: u.service_type,
        service_subtype: u.service_subtype || 'default',
        is_enabled: Boolean(u.is_enabled),
        updated_at: new Date().toISOString(),
    }));

    try {
        const { data, error } = await supabase
            .from('service_availability')
            .upsert(rows, { onConflict: 'service_type,service_subtype' })
            .select('id, service_type, service_subtype, is_enabled');

        if (error) throw error;
        res.json({ success: true, data: data || [], error: null });
    } catch (err) {
        console.error('[admin] PUT service-availability error:', err);
        res.status(500).json({ success: false, data: null, error: err.message || 'Failed to update service availability.' });
    }
});

// ADMIN PER-PARTNER SERVICE CONTROL — a third, more granular layer on top of the global
// service-availability switch above: Admin overriding one specific Partner's specific
// service. Additive, not a replacement — see partner_service_availability.admin_enabled
// (migration 20260916100000). Only ever writes admin_enabled, never the Partner's own
// is_enabled — same partial-column upsert pattern as the chat-settings route below.

// PUT /api/admin/partners/:partnerId/service-availability
// { updates: [{ service_type, service_subtype?, admin_enabled }] }
router.put('/partners/:partnerId/service-availability', async (req, res) => {
    const { partnerId } = req.params;
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : null;
    if (!updates || updates.length === 0) {
        return res.status(400).json({ success: false, data: null, error: 'updates array is required.' });
    }

    for (const u of updates) {
        const subtype = u.service_subtype || 'default';
        if (!VALID_SERVICE_TYPES.has(u.service_type) || !VALID_SERVICE_SUBTYPES.has(subtype)) {
            return res.status(400).json({
                success: false,
                data: null,
                error: `Invalid service_type/service_subtype: ${u.service_type}/${subtype}`
            });
        }
        if (u.admin_enabled === undefined) {
            return res.status(400).json({ success: false, data: null, error: 'admin_enabled is required for each update.' });
        }
    }

    const rows = updates.map((u) => ({
        partner_id: partnerId,
        service_type: u.service_type,
        service_subtype: u.service_subtype || 'default',
        admin_enabled: Boolean(u.admin_enabled),
        updated_at: new Date().toISOString(),
    }));

    try {
        const { data, error } = await supabase
            .from('partner_service_availability')
            .upsert(rows, { onConflict: 'partner_id,service_type,service_subtype' })
            .select('id, service_type, service_subtype, is_enabled, admin_enabled');

        if (error) throw error;
        res.json({ success: true, data: data || [], error: null });
    } catch (err) {
        console.error('[admin] PUT partner service-availability error:', err);
        res.status(500).json({ success: false, data: null, error: err.message || 'Failed to update partner service availability.' });
    }
});

// PARTNER CHAT MANAGEMENT — per-Partner, per-service Chat-with-Agent / Chat-with-Customer
// switches. Same admin gate (router.use above), same { success, data, error } envelope as
// the service-availability routes. Scoped to exactly 3 services (no sub-types).
const VALID_CHAT_SERVICES = new Set(['Maintenance', 'New Unit', 'License Renewal']);

// GET /api/admin/partners/:partnerId/chat-settings
router.get('/partners/:partnerId/chat-settings', async (req, res) => {
    const { partnerId } = req.params;
    try {
        const { data, error } = await supabase
            .from('partner_chat_settings')
            .select('id, service, chat_with_agent, chat_with_customer')
            .eq('partner_id', partnerId)
            .order('service', { ascending: true });

        if (error) throw error;
        res.json({ success: true, data: data || [], error: null });
    } catch (err) {
        console.error('[admin] GET partner chat-settings error:', err);
        res.status(500).json({ success: false, data: null, error: err.message || 'Failed to fetch chat settings.' });
    }
});

// PUT /api/admin/partners/:partnerId/chat-settings
// { updates: [{ service, chat_with_agent?, chat_with_customer? }] }
// Each update only ever writes the fields actually present — toggling Agent chat off
// never touches the stored Customer-chat value for the same (partner, service) row,
// and vice versa (PostgREST's upsert only SETs columns present in the payload on conflict).
router.put('/partners/:partnerId/chat-settings', async (req, res) => {
    const { partnerId } = req.params;
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : null;
    if (!updates || updates.length === 0) {
        return res.status(400).json({ success: false, data: null, error: 'updates array is required.' });
    }

    for (const u of updates) {
        if (!VALID_CHAT_SERVICES.has(u.service)) {
            return res.status(400).json({ success: false, data: null, error: `Invalid service: ${u.service}` });
        }
        if (u.chat_with_agent === undefined && u.chat_with_customer === undefined) {
            return res.status(400).json({
                success: false,
                data: null,
                error: `At least one of chat_with_agent/chat_with_customer is required for service: ${u.service}`
            });
        }
    }

    const rows = updates.map((u) => {
        const row = { partner_id: partnerId, service: u.service, updated_at: new Date().toISOString() };
        if (u.chat_with_agent !== undefined) row.chat_with_agent = Boolean(u.chat_with_agent);
        if (u.chat_with_customer !== undefined) row.chat_with_customer = Boolean(u.chat_with_customer);
        return row;
    });

    try {
        const { data, error } = await supabase
            .from('partner_chat_settings')
            .upsert(rows, { onConflict: 'partner_id,service' })
            .select('id, service, chat_with_agent, chat_with_customer');

        if (error) throw error;
        res.json({ success: true, data: data || [], error: null });
    } catch (err) {
        console.error('[admin] PUT partner chat-settings error:', err);
        res.status(500).json({ success: false, data: null, error: err.message || 'Failed to update chat settings.' });
    }
});

// GENERAL INQUIRY ROUTING — which Admin account(s) get notified when an Agent creates a
// General Inquiry (no Partner offers the selected product/service — see
// supabase/migrations/20260917100000_general_inquiry_routing_columns.sql). Admin-only
// management here; the Agent-facing "who do I notify" lookup lives in
// routes/generalInquiry.js since it must be reachable by any authenticated role, not
// just admin (this router is blanket-gated to requireRole('admin') above).

// GET /api/admin/general-inquiry-admins
router.get('/general-inquiry-admins', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('admins')
            .select('id, name, email, receives_general_inquiries')
            .order('name', { ascending: true });
        if (error) throw error;
        res.json({ success: true, data: data || [], error: null });
    } catch (err) {
        console.error('[admin] GET general-inquiry-admins error:', err);
        res.status(500).json({ success: false, data: null, error: err.message || 'Failed to fetch admins.' });
    }
});

// PUT /api/admin/general-inquiry-admins  { updates: [{ admin_id, receives_general_inquiries }] }
router.put('/general-inquiry-admins', async (req, res) => {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : null;
    if (!updates || updates.length === 0) {
        return res.status(400).json({ success: false, data: null, error: 'updates array is required.' });
    }

    try {
        for (const u of updates) {
            if (!u?.admin_id || u.receives_general_inquiries === undefined) {
                return res.status(400).json({ success: false, data: null, error: 'admin_id and receives_general_inquiries are required for each update.' });
            }
            const { error } = await supabase
                .from('admins')
                .update({ receives_general_inquiries: Boolean(u.receives_general_inquiries) })
                .eq('id', u.admin_id);
            if (error) throw error;
        }

        const { data, error: listErr } = await supabase
            .from('admins')
            .select('id, name, email, receives_general_inquiries')
            .order('name', { ascending: true });
        if (listErr) throw listErr;
        res.json({ success: true, data: data || [], error: null });
    } catch (err) {
        console.error('[admin] PUT general-inquiry-admins error:', err);
        res.status(500).json({ success: false, data: null, error: err.message || 'Failed to update General Inquiry routing.' });
    }
});

// PATCH /api/admin/agents/:id/status  { status: pending | accepted | rejected | hold }
// When an active Agent becomes inactive (left / on hold / rejected), their open inquiries
// are routed to Admin for reassignment — see services/agentStatus.js.
router.patch('/agents/:id/status', async (req, res) => {
    try {
        const result = await agentStatus.setAgentStatus(req.params.id, req.body?.status, req.user);
        if (!result.ok) {
            return res.status(result.code).json({ success: false, data: null, error: result.message });
        }
        res.json({ success: true, data: result.data, error: null });
    } catch (err) {
        console.error('[admin] PATCH agents/:id/status error:', err);
        res.status(500).json({ success: false, data: null, error: err.message || 'Failed to update agent.' });
    }
});

// PUT /api/admin/inquiries/:id/assign-agent  { agent_id }
// Admin assigns an active Agent to a customer request that has none (self-created
// customer, or creating Agent inactive), or reassigns any inquiry whose current Agent is
// no longer active. An inquiry with an active Agent is not reassigned here (409).
router.put('/inquiries/:id/assign-agent', async (req, res) => {
    try {
        const result = await inquiryService.assignAgentToCustomerRequest(req.params.id, req.body?.agent_id, req.user);
        if (!result.ok) {
            return res.status(result.code).json({ success: false, data: null, error: result.message });
        }
        res.json({ success: true, data: result.data, error: null });
    } catch (err) {
        console.error('[admin] PUT inquiries/:id/assign-agent error:', err);
        res.status(500).json({ success: false, data: null, error: err.message || 'Failed to assign agent.' });
    }
});

// PUT /api/admin/inquiries/:id/assign-partner  { partner_id }
// Admin manually routing a General Inquiry (or any unassigned inquiry) to a Partner.
// This is a deliberate manual override, unlike the Agent's automatic product/service
// matching (src/utils/productPartnerEligibility.js) — so it does NOT re-check product
// assignment or service availability. It only enforces what must always hold regardless
// of who is assigning: the inquiry exists, isn't already assigned (prevents duplicate/
// racing assignment), and the Partner is a real, Active account. Admin-only is enforced
// by this router's blanket requireRole('admin') gate above — never just a hidden button.
router.put('/inquiries/:id/assign-partner', async (req, res) => {
    const { id } = req.params;
    const { partner_id: partnerId } = req.body || {};
    if (!partnerId) {
        return res.status(400).json({ success: false, data: null, error: 'partner_id is required.' });
    }

    try {
        const { data: inquiry, error: inquiryErr } = await supabase
            .from('inquiries')
            .select('id, inquiry_no, type, status, customer_id, partner_id, performed_by')
            .eq('id', id)
            .maybeSingle();
        if (inquiryErr) throw inquiryErr;
        if (!inquiry) {
            return res.status(404).json({ success: false, data: null, error: 'Inquiry not found.' });
        }
        if (inquiry.partner_id) {
            return res.status(409).json({ success: false, data: null, error: 'This inquiry already has a Partner assigned.' });
        }

        const { data: partner, error: partnerErr } = await supabase
            .from('partners')
            .select('id, status')
            .eq('id', partnerId)
            .maybeSingle();
        if (partnerErr) throw partnerErr;
        if (!partner || partner.status !== 'Active') {
            return res.status(400).json({ success: false, data: null, error: 'Partner not found or not active.' });
        }

        // Customer requests reach a Partner only through this route, so the Partner must
        // actually be eligible (service availability + product assignment) — unlike the
        // manual override above for Agent-created General Inquiries, which is unchanged.
        if (String(inquiry.performed_by || '').trim().toLowerCase() === 'customer') {
            const reason = await inquiryService.getPartnerIneligibilityReason(id, inquiry.type, partnerId);
            if (reason) {
                return res.status(409).json({ success: false, data: null, error: reason });
            }
        }

        // Conditioned on partner_id still being NULL — closes the race window between
        // the check above and this write (two concurrent assign requests can't both win).
        const { data: updated, error: updateErr } = await supabase
            .from('inquiries')
            .update({ partner_id: partnerId })
            .eq('id', id)
            .is('partner_id', null)
            .select()
            .maybeSingle();
        if (updateErr) throw updateErr;
        if (!updated) {
            return res.status(409).json({ success: false, data: null, error: 'This inquiry already has a Partner assigned.' });
        }

        await recordInquiryEvent({
            inquiryId: id,
            eventType: 'partner_assigned',
            actor: { id: req.user.id, role: req.user.role },
            metadata: { source: 'admin_assign', partner_id: partnerId },
        });

        // A customer's Validation request is approved as soon as Admin assigns a Partner
        // (until then it stays 'pending'). Goes through updateInquiry so the normal
        // pending -> accepted transition rule applies and the timeline records it.
        const isCustomerRequest = String(inquiry.performed_by || '').trim().toLowerCase() === 'customer';
        const autoApprove = isCustomerRequest
            && String(inquiry.type || '').trim().toLowerCase() === 'validation'
            && String(inquiry.status || 'pending').trim().toLowerCase() === 'pending';
        let result = updated;
        if (autoApprove) {
            const approved = await inquiryService.updateInquiry(id, { status: 'accepted' }, partnerId, { id: req.user.id, role: req.user.role });
            if (approved) result = approved;
        }

        // Mirrors src/utils/productPartnerEligibility.js's inquiryTypeLabel on the
        // frontend — kept in sync there since this is a separate Node runtime.
        const { data: firstItem } = await supabase
            .from('inquiry_items')
            .select('validation_mode')
            .eq('inquiry_id', id)
            .limit(1)
            .maybeSingle();
        const SUBTYPE_LABELS = {
            Validation: { new: 'New Validation', followup: 'Follow-up', 'license-renewal': 'License Renewal' },
            Refill: { new: 'New Refill', followup: 'Follow-up', 'license-renewal': 'License Renewal' },
        };
        const subtypeLabel = SUBTYPE_LABELS[inquiry.type]?.[firstItem?.validation_mode || 'new'];
        const typeLabel = subtypeLabel ? `${inquiry.type} - ${subtypeLabel}` : inquiry.type;

        const notifications = [{
            sender_role: 'Admin',
            recipient_id: String(partnerId),
            recipient_role: 'Partner',
            message: autoApprove
                ? `New ${typeLabel} inquiry has been assigned to you and approved.`
                : `New ${typeLabel} inquiry has been assigned to you.`,
            inquiry_id: id,
            type: 'general_inquiry_assigned',
            title: 'New Inquiry Assigned',
        }];
        if (autoApprove && inquiry.customer_id != null) {
            notifications.push({
                sender_role: 'Admin',
                recipient_id: String(inquiry.customer_id),
                recipient_role: 'Customer',
                message: `Your ${typeLabel} request ${inquiry.inquiry_no || ''} has been approved and assigned to a service partner.`.replace(/\s+/g, ' '),
                inquiry_id: id,
                type: 'validation_approved',
                title: 'Validation approved',
            });
        }
        await supabase.from('notifications').insert(notifications);

        res.json({ success: true, data: result, error: null });
    } catch (err) {
        console.error('[admin] PUT inquiries/:id/assign-partner error:', err);
        res.status(500).json({ success: false, data: null, error: err.message || 'Failed to assign partner.' });
    }
});

// ══════════════════════════════════════════════════════════
// INTERNAL TEAM — access requests & page permissions
// ══════════════════════════════════════════════════════════
// Admin-only via this router's blanket gate. A team member's own token can never reach
// these (verifyToken refuses internal_team tokens), so members can't approve themselves
// or change their own permissions.

// Everything except the password hash.
const TEAM_ADMIN_COLUMNS = 'id, name, email, phone, department, request_note, designation, status, permissions, rejection_reason, reviewed_by, reviewed_at, last_login_at, created_at, updated_at';
const TEAM_STATUSES = ['pending', 'approved', 'rejected', 'deactivated'];

/** Security-relevant Admin changes go to the existing audit_logs table. Best-effort. */
const auditTeamChange = (req, action, memberId, metadata) => {
    supabase
        .from('audit_logs')
        .insert({
            actor_user_id: req.user.id,
            actor_role: 'admin',
            action,
            method: req.method,
            path: req.originalUrl,
            resource_id: String(memberId),
            metadata,
        })
        .then(({ error }) => {
            if (error) console.error('[audit_logs] team change insert failed:', error.message);
        });
};

/** Validates Admin's designation + permissions input; returns { error } or { designation, permissions }. */
const readTeamAccessInput = (body) => {
    const designation = String(body?.designation || '').trim();
    const permissions = sanitizePermissions(body?.permissions);
    if (!designation) return { error: 'Designation is required.' };
    if (Object.keys(permissions).length === 0) return { error: 'Grant access to at least one page.' };
    return { designation, permissions };
};

/**
 * Status-conditioned update so two Admins acting at once can't both win
 * (e.g. one approves while another rejects). Sends 409 and returns null when the
 * row has already moved on.
 */
const updateTeamMember = async (res, id, allowedFrom, fields) => {
    const { data, error } = await supabase
        .from('internal_team_members')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', id)
        .in('status', allowedFrom)
        .select(TEAM_ADMIN_COLUMNS)
        .maybeSingle();
    if (error && error.code !== '22P02') throw error;
    if (!data) {
        res.status(409).json({ success: false, data: null, error: 'This request was already handled or no longer exists. Reload and try again.' });
        return null;
    }
    return { ...data, permissions: sanitizePermissions(data.permissions) };
};

// GET /api/admin/team-permissions — the modules/actions Admin can grant.
router.get('/team-permissions', (req, res) => {
    res.json({ success: true, data: TEAM_PERMISSION_CATALOG, error: null });
});

// GET /api/admin/team-members?status=pending
router.get('/team-members', async (req, res) => {
    const { status } = req.query;
    if (status && !TEAM_STATUSES.includes(status)) {
        return res.status(400).json({ success: false, data: null, error: `status must be one of: ${TEAM_STATUSES.join(', ')}.` });
    }
    try {
        let query = supabase.from('internal_team_members').select(TEAM_ADMIN_COLUMNS);
        if (status) query = query.eq('status', status);
        const { data, error } = await query.order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, data: (data || []).map((m) => ({ ...m, permissions: sanitizePermissions(m.permissions) })), error: null });
    } catch (err) {
        console.error('[admin] GET team-members error:', err);
        res.status(500).json({ success: false, data: null, error: 'Failed to load access requests.' });
    }
});

// PUT /api/admin/team-members/:id/approve  { designation, permissions }
router.put('/team-members/:id/approve', async (req, res) => {
    const input = readTeamAccessInput(req.body);
    if (input.error) return res.status(400).json({ success: false, data: null, error: input.error });
    try {
        const member = await updateTeamMember(res, req.params.id, ['pending', 'rejected'], {
            status: 'approved',
            designation: input.designation,
            permissions: input.permissions,
            rejection_reason: null,
            reviewed_by: req.user.id,
            reviewed_at: new Date().toISOString(),
        });
        if (!member) return;
        auditTeamChange(req, 'team_member_approved', member.id, { designation: input.designation, permissions: input.permissions });
        res.json({ success: true, data: member, error: null });
    } catch (err) {
        console.error('[admin] PUT team-members/:id/approve error:', err);
        res.status(500).json({ success: false, data: null, error: 'Failed to approve request.' });
    }
});

// PUT /api/admin/team-members/:id/reject  { reason? }
router.put('/team-members/:id/reject', async (req, res) => {
    const reason = String(req.body?.reason || '').trim() || null;
    try {
        const member = await updateTeamMember(res, req.params.id, ['pending'], {
            status: 'rejected',
            permissions: {},
            rejection_reason: reason,
            reviewed_by: req.user.id,
            reviewed_at: new Date().toISOString(),
        });
        if (!member) return;
        auditTeamChange(req, 'team_member_rejected', member.id, { reason });
        res.json({ success: true, data: member, error: null });
    } catch (err) {
        console.error('[admin] PUT team-members/:id/reject error:', err);
        res.status(500).json({ success: false, data: null, error: 'Failed to reject request.' });
    }
});

// PUT /api/admin/team-members/:id/permissions  { designation, permissions }
router.put('/team-members/:id/permissions', async (req, res) => {
    const input = readTeamAccessInput(req.body);
    if (input.error) return res.status(400).json({ success: false, data: null, error: input.error });
    try {
        const member = await updateTeamMember(res, req.params.id, ['approved', 'deactivated'], {
            designation: input.designation,
            permissions: input.permissions,
        });
        if (!member) return;
        auditTeamChange(req, 'team_member_permissions_updated', member.id, { designation: input.designation, permissions: input.permissions });
        res.json({ success: true, data: member, error: null });
    } catch (err) {
        console.error('[admin] PUT team-members/:id/permissions error:', err);
        res.status(500).json({ success: false, data: null, error: 'Failed to update permissions.' });
    }
});

// PATCH /api/admin/team-members/:id/status  { status: 'approved' | 'deactivated' }
// Deactivating takes effect on the member's next request (loadTeamMember re-reads it).
router.patch('/team-members/:id/status', async (req, res) => {
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (status !== 'approved' && status !== 'deactivated') {
        return res.status(400).json({ success: false, data: null, error: "status must be 'approved' or 'deactivated'." });
    }
    try {
        const from = status === 'approved' ? ['deactivated'] : ['approved'];
        const member = await updateTeamMember(res, req.params.id, from, { status });
        if (!member) return;
        auditTeamChange(req, status === 'approved' ? 'team_member_reactivated' : 'team_member_deactivated', member.id, {});
        res.json({ success: true, data: member, error: null });
    } catch (err) {
        console.error('[admin] PATCH team-members/:id/status error:', err);
        res.status(500).json({ success: false, data: null, error: 'Failed to update member status.' });
    }
});

// ── Internal Team invitations ───────────────────────────────
// Admin invites by email; the link lets that address register (POST
// /api/auth/register/internal-team). An invitation grants nothing else: the member is
// created 'pending' with no permissions and still goes through approve/permissions above.

// Per-admin cap on sending mail (invite + resend share it).
const inviteMailLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, keyFn: (req) => `admin:${req.user?.id}`, message: 'Too many invitations sent. Try again later.' });

/** Throws if the mail server didn't accept the message. The link is never logged. */
const sendTeamInvitationEmail = async (email, token) => {
    const link = `${frontendUrl()}/register/internal_team?token=${encodeURIComponent(token)}`;
    const info = await transporter.sendMail({
        from: `"AIXOS Firefighter" <${emailUser}>`,
        to: email,
        subject: "You're invited to the AIXOS Internal Team",
        html: `
        <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:24px">
          <h2 style="color:#ef4444;margin-bottom:8px">You're invited to join the Internal Team</h2>
          <p style="color:#475569;line-height:1.6">
            An Admin of <strong>AIXOS Firefighter</strong> has invited <strong>${escapeHtml(email)}</strong>
            to join the Internal Team. Use the button below to complete your profile and set your password.
          </p>
          <p style="margin:24px 0">
            <a href="${link}" style="background:#ef4444;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:bold">Complete Registration</a>
          </p>
          <p style="color:#475569;line-height:1.6">After you register, an Admin will review your account and assign the pages you can use.</p>
          <p style="color:#666;font-size:13px">This link works once and expires in <strong>${INVITE_TTL_HOURS} hours</strong>. If you weren't expecting it, you can ignore this email.</p>
        </div>`,
    });
    if (info.rejected && info.rejected.length > 0) throw new Error('Recipient rejected by mail server');
};

/** 409 message when this email already has a member row (a rejected one may be re-invited). */
const existingMemberConflict = async (email) => {
    const { data, error } = await supabase.from('internal_team_members').select('status').eq('email', email).maybeSingle();
    if (error) throw error;
    if (!data || data.status === 'rejected') return null;
    return data.status === 'pending'
        ? 'This person has already registered and is waiting for approval.'
        : 'This email already has an Internal Team account.';
};

const auditInvitation = (req, action, invitation) => auditTeamChange(req, action, `invitation:${invitation.id}`, { email: invitation.email });

// GET /api/admin/team-invitations
router.get('/team-invitations', async (req, res) => {
    try {
        const { data, error } = await supabase.from('internal_team_invitations').select(INVITATION_COLUMNS)
            .order('created_at', { ascending: false }).limit(500);
        if (error) throw error;
        res.json({ success: true, data: (data || []).map(withStatus), error: null });
    } catch (err) {
        console.error('[admin] GET team-invitations error:', err);
        res.status(500).json({ success: false, data: null, error: 'Failed to load invitations.' });
    }
});

// POST /api/admin/team-invitations { email }
router.post('/team-invitations', inviteMailLimiter, async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!EMAIL_RE.test(email)) {
        return res.status(400).json({ success: false, data: null, error: 'Enter a valid email address.' });
    }
    try {
        const conflict = await existingMemberConflict(email);
        if (conflict) return res.status(409).json({ success: false, data: null, error: conflict, code: 'ALREADY_MEMBER' });

        const { data: open, error: openErr } = await supabase.from('internal_team_invitations').select('id')
            .eq('email', email).is('used_at', null).is('revoked_at', null).maybeSingle();
        if (openErr) throw openErr;
        if (open) {
            return res.status(409).json({ success: false, data: { id: open.id }, error: 'This email already has an open invitation. Use Resend or Revoke instead.', code: 'ALREADY_INVITED' });
        }

        const token = newToken();
        const { data: invitation, error } = await supabase.from('internal_team_invitations')
            .insert({ email, token_hash: hashToken(token), invited_by: req.user.id, expires_at: newExpiry() })
            .select(INVITATION_COLUMNS).single();
        if (error) {
            if (error.code === '23505') return res.status(409).json({ success: false, data: null, error: 'This email already has an open invitation.', code: 'ALREADY_INVITED' });
            throw error;
        }

        try {
            await sendTeamInvitationEmail(email, token);
        } catch (mailErr) {
            logSmtpError('[team-invitations] send FAILED:', mailErr);
            // Nothing was delivered, so don't leave an open invitation blocking a retry.
            await supabase.from('internal_team_invitations').delete().eq('id', invitation.id);
            return res.status(502).json({ success: false, data: null, error: 'Could not send the invitation email. Check the email settings and try again.' });
        }

        auditInvitation(req, 'team_invitation_sent', invitation);
        res.status(201).json({ success: true, data: withStatus(invitation), error: null });
    } catch (err) {
        console.error('[admin] POST team-invitations error:', err);
        res.status(500).json({ success: false, data: null, error: 'Failed to send invitation.' });
    }
});

// POST /api/admin/team-invitations/:id/resend — new token + new expiry; the old link stops working.
router.post('/team-invitations/:id/resend', inviteMailLimiter, async (req, res) => {
    try {
        const { data: current, error: curErr } = await supabase.from('internal_team_invitations').select(INVITATION_COLUMNS).eq('id', req.params.id).maybeSingle();
        if (curErr && curErr.code !== '22P02') throw curErr;
        if (!current) return res.status(404).json({ success: false, data: null, error: 'Invitation not found.' });
        const status = invitationStatus(current);
        if (status === 'used' || status === 'revoked') {
            return res.status(409).json({ success: false, data: null, error: status === 'used' ? 'This invitation was already used.' : 'This invitation was revoked. Send a new invitation instead.' });
        }
        const conflict = await existingMemberConflict(current.email);
        if (conflict) return res.status(409).json({ success: false, data: null, error: conflict, code: 'ALREADY_MEMBER' });

        const token = newToken();
        const { data: invitation, error } = await supabase.from('internal_team_invitations')
            .update({ token_hash: hashToken(token), expires_at: newExpiry(), sent_at: new Date().toISOString(), send_count: (current.send_count || 1) + 1 })
            .eq('id', current.id).is('used_at', null).is('revoked_at', null)
            .select(INVITATION_COLUMNS).maybeSingle();
        if (error) throw error;
        if (!invitation) return res.status(409).json({ success: false, data: null, error: 'This invitation changed meanwhile. Reload and try again.' });

        try {
            await sendTeamInvitationEmail(invitation.email, token);
        } catch (mailErr) {
            logSmtpError('[team-invitations/resend] send FAILED:', mailErr);
            return res.status(502).json({ success: false, data: null, error: 'Could not send the invitation email. The previous link no longer works — try Resend again.' });
        }

        auditInvitation(req, 'team_invitation_resent', invitation);
        res.json({ success: true, data: withStatus(invitation), error: null });
    } catch (err) {
        console.error('[admin] POST team-invitations/:id/resend error:', err);
        res.status(500).json({ success: false, data: null, error: 'Failed to resend invitation.' });
    }
});

// POST /api/admin/team-invitations/:id/revoke
router.post('/team-invitations/:id/revoke', async (req, res) => {
    try {
        const { data: invitation, error } = await supabase.from('internal_team_invitations')
            .update({ revoked_at: new Date().toISOString(), revoked_by: req.user.id })
            .eq('id', req.params.id).is('used_at', null).is('revoked_at', null)
            .select(INVITATION_COLUMNS).maybeSingle();
        if (error && error.code !== '22P02') throw error;
        if (!invitation) return res.status(409).json({ success: false, data: null, error: 'This invitation was already used or revoked.' });
        auditInvitation(req, 'team_invitation_revoked', invitation);
        res.json({ success: true, data: withStatus(invitation), error: null });
    } catch (err) {
        console.error('[admin] POST team-invitations/:id/revoke error:', err);
        res.status(500).json({ success: false, data: null, error: 'Failed to revoke invitation.' });
    }
});

module.exports = router;
