const supabase = require('../supabase');

/**
 * Partner Service
 * Handles data retrieval and stats for partners.
 */
class PartnerService {
    /**
     * Get stats for a specific partner.
     * @param {string} partnerId - UUID of the partner.
     * @returns {Promise<Object>} - Stats object.
     */
    async getPartnerStats(partnerId) {
        try {
            // Fetch inquiries assigned to this partner with their items for sales calculation
            const { data: inquiries, error: inqError } = await supabase
                .from('inquiries')
                .select(`
                    id, 
                    status, 
                    agent_id,
                    inquiry_items (id, price, quantity)
                `)
                .eq('partner_id', partnerId);

            if (inqError) throw inqError;

            // Inquiries stats
            const pending_inquiries = (inquiries || []).filter(i => i.status === 'pending').length;
            const active_inquiries = (inquiries || []).filter(i => ['active', 'accepted'].includes(i.status)).length;
            const closed_inquiries = (inquiries || []).filter(i => ['completed', 'closed'].includes(i.status)).length;

            // Agents stats (unique agents who handled inquiries)
            const uniqueAgents = new Set((inquiries || []).filter(i => i.agent_id).map(i => i.agent_id));
            const total_agents = uniqueAgents.size;

            // Sales Calculation
            let total_sales = 0;
            (inquiries || []).forEach(inquiry => {
                const items = inquiry.inquiry_items || [];
                items.forEach(item => {
                    total_sales += (item.price || 0) * (item.quantity || 1);
                });
            });

            return {
                active_inquiries,
                pending_inquiries,
                closed_inquiries,
                total_sales,
                total_agents
            };
        } catch (error) {
            console.error('[PartnerService] getPartnerStats error:', error);
            throw error;
        }
    }

    /**
     * Get units assigned to a partner.
     * @param {string} partnerId 
     */
    async getAssignedUnits(partnerId) {
        try {
            const { data, error } = await supabase
                .from('extinguishers')
                .select('*, customers!fk_ext_customer(business_name, address)')
                .eq('partner_id', partnerId)
                .order('created_at', { ascending: false });

            if (error) throw error;
            return data || [];
        } catch (error) {
            console.error('[PartnerService] getAssignedUnits error:', error);
            throw new Error(`Unable to fetch assigned units: ${error.message}`);
        }
    }

    /**
     * Get products assigned to a specific partner (their own — never another
     * partner's), joined to the product catalog. Deactivated products stay in
     * the list (marked is_active:false) so assignment history/UI can still show
     * them; only active ones should be offered for new work.
     * @param {string} partnerId
     */
    async getAssignedProducts(partnerId) {
        try {
            const { data, error } = await supabase
                .from('partner_products')
                .select('id, assigned_at, products(id, name, description, category, image_url, is_active)')
                .eq('partner_id', partnerId)
                .order('assigned_at', { ascending: false });

            if (error) throw error;
            return (data || [])
                .filter((row) => row.products)
                .map((row) => ({ ...row.products, assigned_at: row.assigned_at }));
        } catch (error) {
            console.error('[PartnerService] getAssignedProducts error:', error);
            throw new Error(`Unable to fetch assigned products: ${error.message}`);
        }
    }

    /**
     * Get all active partners.
     */
    async getAllPartners() {
        try {
            const { data, error } = await supabase
                .from('partners')
                .select('id, business_name, email, phone')
                .eq('status', 'active');

            if (error) throw error;
            return data || [];
        } catch (error) {
            console.error('[PartnerService] getAllPartners error:', error);
            throw new Error(`Unable to fetch partners: ${error.message}`);
        }
    }
}

module.exports = new PartnerService();
