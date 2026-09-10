const partnerService = require('../services/partnerService');

/**
 * Partner Controller
 * Handles requests for partners dashboard and stats.
 */
class PartnerController {
    /**
     * Get dashboard data for the partner.
     */
    async getDashboard(req, res) {
        const { id: partnerId, role } = req.user;

        if (role !== 'partner') {
            return res.status(403).json({
                success: false,
                data: null,
                error: 'Access denied. Only partners can access this dashboard.'
            });
        }

        try {
            const stats = await partnerService.getPartnerStats(partnerId);
            const units = await partnerService.getAssignedUnits(partnerId);

            return res.status(200).json({
                success: true,
                data: {
                    stats,
                    assignedUnits: units
                },
                error: null
            });
        } catch (error) {
            console.error('[PartnerController] getDashboard error:', error);
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to fetch dashboard data: ${error.message}`
            });
        }
    }

    /**
     * Get standalone stats for the partner.
     */
    async getStats(req, res) {
        const { id: partnerId, role } = req.user;

        if (role !== 'partner') {
            return res.status(403).json({
                success: false,
                data: null,
                error: 'Access denied. Only partners can access stats.'
            });
        }

        try {
            const stats = await partnerService.getPartnerStats(partnerId);
            return res.status(200).json({
                success: true,
                data: stats,
                error: null
            });
        } catch (error) {
            console.error('[PartnerController] getStats error:', error);
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to fetch partner stats: ${error.message}`
            });
        }
    }

    /**
     * Get products assigned to the logged-in partner. Partner id is taken
     * from the verified JWT, never a request param — a partner can never
     * fetch another partner's assigned products through this endpoint.
     */
    async getMyProducts(req, res) {
        const { id: partnerId, role } = req.user;

        if (role !== 'partner') {
            return res.status(403).json({
                success: false,
                data: null,
                error: 'Access denied. Only partners can access this list.'
            });
        }

        try {
            const products = await partnerService.getAssignedProducts(partnerId);
            return res.status(200).json({
                success: true,
                data: products,
                error: null
            });
        } catch (error) {
            console.error('[PartnerController] getMyProducts error:', error);
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to fetch assigned products: ${error.message}`
            });
        }
    }

    /**
     * Get all partners. Accessible by agents/admins.
     */
    async getAllPartners(req, res) {
        try {
            const partners = await partnerService.getAllPartners();
            return res.status(200).json({
                success: true,
                data: partners,
                error: null
            });
        } catch (error) {
            console.error('[PartnerController] getAllPartners error:', error);
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to fetch partners: ${error.message}`
            });
        }
    }

    /**
     * Get the logged-in partner's own service availability. Partner id is
     * taken from the verified JWT, never a request param.
     */
    async getMyServiceAvailability(req, res) {
        const { id: partnerId, role } = req.user;

        if (role !== 'partner') {
            return res.status(403).json({
                success: false,
                data: null,
                error: 'Access denied. Only partners can access this list.'
            });
        }

        try {
            const rows = await partnerService.getServiceAvailability(partnerId);
            return res.status(200).json({
                success: true,
                data: rows,
                error: null
            });
        } catch (error) {
            console.error('[PartnerController] getMyServiceAvailability error:', error);
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to fetch service availability: ${error.message}`
            });
        }
    }

    /**
     * Update the logged-in partner's own service availability. Partner id is
     * taken from the verified JWT — a partner can never modify another
     * partner's settings through this endpoint, regardless of what the
     * request body claims.
     */
    async updateMyServiceAvailability(req, res) {
        const { id: partnerId, role } = req.user;

        if (role !== 'partner') {
            return res.status(403).json({
                success: false,
                data: null,
                error: 'Access denied. Only partners can update this list.'
            });
        }

        const updates = Array.isArray(req.body?.updates) ? req.body.updates : null;
        if (!updates || updates.length === 0) {
            return res.status(400).json({
                success: false,
                data: null,
                error: 'updates array is required.'
            });
        }

        const validTypes = new Set(['Validation', 'Refill', 'New Unit', 'Maintenance']);
        const validSubtypes = new Set(['default', 'new', 'followup', 'license-renewal']);
        for (const u of updates) {
            if (!validTypes.has(u.service_type) || (u.service_subtype && !validSubtypes.has(u.service_subtype))) {
                return res.status(400).json({
                    success: false,
                    data: null,
                    error: `Invalid service_type/service_subtype: ${u.service_type}/${u.service_subtype}`
                });
            }
        }

        try {
            const rows = await partnerService.updateServiceAvailability(partnerId, updates);
            return res.status(200).json({
                success: true,
                data: rows,
                error: null
            });
        } catch (error) {
            console.error('[PartnerController] updateMyServiceAvailability error:', error);
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to update service availability: ${error.message}`
            });
        }
    }
}

module.exports = new PartnerController();
