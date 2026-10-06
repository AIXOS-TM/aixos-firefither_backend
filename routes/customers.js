const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { verifyToken } = require('../middleware/auth');
const { requireRole } = require('../middleware/requireRole');

/**
 * Customers table uses location_lat / location_lng (not lat / lng).
 * Accept either naming convention from clients and write only DB column names.
 */
function normalizeCustomerLocation(body) {
    const rawLat = body.location_lat != null ? body.location_lat : body.lat;
    const rawLng = body.location_lng != null ? body.location_lng : body.lng;
    if (rawLat == null || rawLng == null) {
        return { error: 'Provide location_lat and location_lng (or legacy lat and lng).' };
    }
    const location_lat = Number(rawLat);
    const location_lng = Number(rawLng);
    if (!Number.isFinite(location_lat) || !Number.isFinite(location_lng)) {
        return { error: 'location values must be valid numbers.' };
    }
    return { location_lat, location_lng };
}

// PATCH /api/customers/:id/location — preferred path (avoids direct PostgREST lat/lng mismatch)
router.patch('/:id/location', verifyToken, async (req, res) => {
    const customerId = req.params.id;
    const { id: tokenUserId, role } = req.user;

    if (role === 'customer' && tokenUserId !== customerId) {
        return res.status(403).json({
            success: false,
            data: null,
            error: 'You can only update your own location.'
        });
    }
    if (role !== 'customer' && role !== 'admin') {
        return res.status(403).json({
            success: false,
            data: null,
            error: 'Access denied.'
        });
    }

    const coords = normalizeCustomerLocation(req.body);
    if (coords.error) {
        return res.status(400).json({
            success: false,
            data: null,
            error: coords.error
        });
    }

    try {
        const { data, error } = await supabase
            .from('customers')
            .update({
                location_lat: coords.location_lat,
                location_lng: coords.location_lng
            })
            .eq('id', customerId)
            .select('id, location_lat, location_lng')
            .maybeSingle();

        if (error) throw error;
        if (!data) {
            return res.status(404).json({
                success: false,
                data: null,
                error: 'Customer not found.'
            });
        }

        return res.status(200).json({
            success: true,
            data,
            error: null
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({
            success: false,
            data: null,
            error: err.message || 'Failed to update location'
        });
    }
});

// GET /api/customers/me/items — the logged-in customer's equipment (inquiry_items),
// scoped to the verified JWT so the browser no longer reads the table with the anon key.
router.get('/me/items', verifyToken, requireRole('customer'), async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('inquiry_items')
            .select('id, inquiry_id, extinguisher_id, type, capacity, system_type, status, condition, install_date, expiry_date, validation_mode, created_at, updated_at')
            .eq('customer_id', req.user.id)
            .order('updated_at', { ascending: false });

        if (error) throw error;
        return res.status(200).json({ success: true, data: data || [], error: null });
    } catch (err) {
        console.error('[customers] GET /me/items error:', err);
        return res.status(500).json({ success: false, data: null, error: err.message || 'Failed to load equipment.' });
    }
});

// GET Customer Dashboard (Inventory + Pending Services)
router.get('/:id/dashboard', async (req, res) => {
    const customerId = req.params.id;

    try {
        const { data: extinguishers, error: eError } = await supabase
            .from('extinguishers')
            .select('*')
            .eq('customer_id', customerId);

        if (eError) throw eError;

        const { data: services, error: sError } = await supabase
            .from('services')
            .select('*')
            .eq('customer_id', customerId)
            .order('request_date', { ascending: false })
            .limit(5);

        if (sError) throw sError;

        res.json({ extinguishers, services });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching dashboard data' });
    }
});

// GET Customer Inventory (Dedicated)
router.get('/:id/inventory', async (req, res) => {
    const customerId = req.params.id;
    try {
        const { data, error } = await supabase
            .from('extinguishers')
            .select('*')
            .eq('customer_id', customerId);
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching inventory' });
    }
});

// GET Customer History (Dedicated)
router.get('/:id/history', async (req, res) => {
    const customerId = req.params.id;
    try {
        const { data, error } = await supabase
            .from('services')
            .select('*')
            .eq('customer_id', customerId)
            .order('scheduled_date', { ascending: false });
        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error fetching history' });
    }
});

// BOOK SERVICE
router.post('/book', async (req, res) => {
    const { customerId, serviceType, date, notes, assetIds } = req.body;

    try {
        const { data, error } = await supabase
            .from('services')
            .insert([
                { customer_id: customerId, service_type: serviceType, scheduled_date: date, notes }
            ])
            .select();

        if (error) throw error;

        const serviceId = data[0].id;

        // Note: service_items migration would go here if implemented in Supabase
        // For now, we skip it as it wasn't in the core schema in db.js

        res.status(201).json({ message: 'Service booked successfully', id: serviceId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// ADD EXTINGUISHER
router.post('/inventory', async (req, res) => {
    const { customerId, type, capacity, quantity, installDate, expiryDate } = req.body;
    try {
        const { data, error } = await supabase
            .from('extinguishers')
            .insert([
                { customer_id: customerId, type, capacity, quantity, install_date: installDate, expiry_date: expiryDate, status: 'Valid' }
            ])
            .select();

        if (error) throw error;
        res.status(201).json({ message: 'Extinguisher added', id: data[0].id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// UPDATE LOCATION (legacy POST — same column mapping as PATCH)
router.post('/location', async (req, res) => {
    const { id } = req.body;
    if (!id) {
        return res.status(400).json({
            success: false,
            data: null,
            error: 'id is required.'
        });
    }

    const coords = normalizeCustomerLocation(req.body);
    if (coords.error) {
        return res.status(400).json({
            success: false,
            data: null,
            error: coords.error
        });
    }

    try {
        const { error } = await supabase
            .from('customers')
            .update({
                location_lat: coords.location_lat,
                location_lng: coords.location_lng
            })
            .eq('id', id);
        if (error) throw error;
        return res.status(200).json({
            success: true,
            data: { id, location_lat: coords.location_lat, location_lng: coords.location_lng },
            error: null
        });
    } catch (err) {
        console.error(err);
        return res.status(500).json({
            success: false,
            data: null,
            error: err.message || 'DB Error'
        });
    }
});

module.exports = router;
