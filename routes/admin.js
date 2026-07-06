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

module.exports = router;
