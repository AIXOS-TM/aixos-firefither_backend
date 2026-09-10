const express = require('express');
const router = express.Router();
const partnerController = require('../controllers/partnerController');
const { verifyToken } = require('../middleware/auth');

/**
 * GET /api/partners/dashboard (Legacy/Consolidated)
 * Fetch stats and assigned units for the logged-in partner.
 */
router.get('/dashboard', verifyToken, partnerController.getDashboard);

/**
 * GET /api/partners/stats
 * Standalone stats for the partner dashboard.
 */
router.get('/stats', verifyToken, partnerController.getStats);

/**
 * GET /api/partners/products
 * Products assigned to the logged-in partner (own account only).
 */
router.get('/products', verifyToken, partnerController.getMyProducts);

/**
 * GET /api/partners
 * Fetch all active partners.
 */
router.get('/', verifyToken, partnerController.getAllPartners);

/**
 * GET /api/partners/service-availability
 * The logged-in partner's own service availability rows.
 */
router.get('/service-availability', verifyToken, partnerController.getMyServiceAvailability);

/**
 * PUT /api/partners/service-availability
 * Update the logged-in partner's own service availability (body: { updates: [...] }).
 */
router.put('/service-availability', verifyToken, partnerController.updateMyServiceAvailability);

module.exports = router;
