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
}

module.exports = new PartnerController();
