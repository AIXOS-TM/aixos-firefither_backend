const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const multer = require('multer');
const path = require('path');

// Configure Multer for Visit Photos
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'visit-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// SEARCH CUSTOMERS (for Autocomplete)
router.get('/customers/search', async (req, res) => {
    const { query } = req.query;
    if (!query) return res.json([]);

    try {
        const { data, error } = await supabase
            .from('customers')
            .select('id, business_name, owner_name, email, phone, address, business_type')
            .or(`business_name.ilike.%${query}%,phone.ilike.%${query}%`)
            .limit(10);

        if (error) throw error;
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'DB Error' });
    }
});

// LOG VISIT
router.post('/visits', upload.any(), async (req, res) => {
    const QRCode = require('qrcode');
    const fs = require('fs');

    const {
        agent_id,
        customer_id,
        business_name, owner_name, email, phone, address, business_type,
        notes, risk_assessment, service_recommendations, follow_up_date,
        inventory
    } = req.body;

    try {
        let finalCustId = customer_id;

        if (!finalCustId) {
            // Create Lead Customer
            const finalEmail = email || `lead-${Date.now()}@temp.com`;
            // Placeholder hash — customer sets real password via email link
            const placeholderPass = '$2a$08$unusable.placeholder.hash.xxxxxxxxxxxxxxxxxxxxxx';

            const { data: leadData, error: leadError } = await supabase
                .from('customers')
                .insert([
                    { business_name, owner_name, email: finalEmail, password: placeholderPass, phone, address, business_type, status: 'Lead' }
                ])
                .select();

            if (leadError) throw leadError;
            finalCustId = leadData[0].id;

            // GENERATE QR
            const qrDir = path.join(__dirname, '../uploads/qrcodes');
            if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true });

            const qrContent = JSON.stringify({ id: finalCustId, type: 'customer', name: business_name, url: `https://app.aixos.com/customer/${finalCustId}` });
            const qrFileName = `qr-lead-${finalCustId}-${Date.now()}.png`;
            const qrFilePath = path.join(qrDir, qrFileName);

            await QRCode.toFile(qrFilePath, qrContent, { color: { dark: '#000000', light: '#0000' } });

            const qrUrl = `/uploads/qrcodes/${qrFileName}`;
            await supabase.from('customers').update({ qr_code_url: qrUrl }).eq('id', finalCustId);
        }

        // Insert Visit
        const { data: visitData, error: visitError } = await supabase
            .from('visits')
            .insert([
                {
                    agent_id,
                    customer_id: finalCustId,
                    customer_name: business_name,
                    business_type,
                    notes,
                    risk_assessment,
                    service_recommendations,
                    follow_up_date
                }
            ])
            .select();

        if (visitError) throw visitError;
        const visitId = visitData[0].id;

        // Process Inventory
        if (inventory) {
            try {
                const items = JSON.parse(inventory);
                const inventoryRows = items.map(item => ({
                    customer_id: finalCustId,
                    visit_id: visitId,
                    type: item.type,
                    capacity: item.capacity,
                    quantity: item.quantity,
                    install_date: item.install_date || null,
                    last_refill_date: item.last_refill_date || null,
                    expiry_date: item.expiry_date || null,
                    condition: item.condition,
                    status: 'Valid'
                }));

                const { error: invError } = await supabase.from('extinguishers').insert(inventoryRows);
                if (invError) throw invError;
            } catch (e) {
                console.error("Inventory process error", e);
            }
        }

        res.status(201).json({ message: 'Visit logged successfully', visitId: visitId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to log visit', details: err.message });
    }
});

// Get Agent Stats
router.get('/:id/stats', async (req, res) => {
    const agentId = req.params.id;

    try {
        // Total Visits
        const { count: totalVisits, error: vError } = await supabase
            .from('visits')
            .select('*', { count: 'exact', head: true })
            .eq('agent_id', agentId);

        if (vError) throw vError;

        // Conversions
        const { count: conversions, error: cError } = await supabase
            .from('visits')
            .select('*', { count: 'exact', head: true })
            .eq('agent_id', agentId)
            .eq('status', 'Completed');

        if (cError) throw cError;

        // Mock historical data
        const monthlyData = [
            { name: 'Jan', visits: 12, earnings: 400 },
            { name: 'Feb', visits: 19, earnings: 750 },
            { name: 'Mar', visits: 15, earnings: 600 },
            { name: 'Apr', visits: 22, earnings: 1200 },
            { name: 'May', visits: 30, earnings: 1500 },
            { name: 'Jun', visits: 35, earnings: 1800 },
        ];

        const earnings = (conversions || 0) * 50;

        res.json({
            totalVisits: totalVisits || 0,
            conversions: conversions || 0,
            earnings: earnings,
            chartData: monthlyData
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Get Agent's Customers
router.get('/:id/my-customers', async (req, res) => {
    const agentId = req.params.id;

    try {
        // Supabase doesn't support complex JOIN + GROUP BY easily in one JS call without RPC.
        // But we can fetch visits and join customers, or vice-versa.
        // Alternative: Use raw SQL via RPC if needed, but let's try JS query.

        const { data, error } = await supabase
            .from('visits')
            .select(`
                customer_id,
                visit_date,
                customers (*)
            `)
            .eq('agent_id', agentId)
            .order('visit_date', { ascending: false });

        if (error) throw error;

        // Unique by customer_id (only keep most recent visit)
        const uniqueCustomers = [];
        const seen = new Set();

        data.forEach(v => {
            if (!seen.has(v.customer_id)) {
                seen.add(v.customer_id);
                uniqueCustomers.push({
                    ...v.customers,
                    last_visit: v.visit_date
                });
            }
        });

        res.json(uniqueCustomers);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// UPDATE LOCATION
router.post('/location', async (req, res) => {
    const { id, lat, lng } = req.body;
    const now = new Date().toISOString();

    try {
        const { error } = await supabase
            .from('agents')
            .update({ location_lat: lat, location_lng: lng, last_active: now })
            .eq('id', id);

        if (error) throw error;
        res.json({ message: 'Location updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'DB Error' });
    }
});

module.exports = router;
