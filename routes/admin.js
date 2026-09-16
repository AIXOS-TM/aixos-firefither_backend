const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { verifyToken } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');

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

module.exports = router;
