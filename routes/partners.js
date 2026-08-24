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

module.exports = router;
