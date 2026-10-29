const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { verifyToken } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');

// Admin-only: lists every customer's bookings and reassigns agents.
router.use(verifyToken, requireRole('admin'));

// GET All Services (Admin) or filtered
router.get('/', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('services')
            .select(`
                *,
                customers (business_name),
                agents (name)
            `);

        if (error) throw error;

        // Flatten the data to match the expected format if necessary
        const flattened = data.map(s => ({
            ...s,
            business_name: s.customers ? s.customers.business_name : null,
            agent_name: s.agents ? s.agents.name : null
        }));

        res.json(flattened);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching services' });
    }
});

// UPDATE Service Status
router.put('/:id/status', async (req, res) => {
    const { status, agentId } = req.body;
    const serviceId = req.params.id;

    const updates = { status };
    if (agentId) updates.agent_id = agentId;

    try {
        const { error } = await supabase
            .from('services')
            .update(updates)
            .eq('id', serviceId);

        if (error) throw error;
        res.json({ message: 'Service updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
