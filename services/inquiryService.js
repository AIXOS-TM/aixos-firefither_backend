const supabase = require('../supabase');

/**
 * Allowed status transitions for Validation inquiries. Other inquiry types
 * (Maintenance/Refill/New Unit) keep their own status handling untouched —
 * this only gates the generic PATCH /inquiries/:id path when the target
 * row's type is 'validation'.
 */
const VALIDATION_STATUS_TRANSITIONS = {
    pending: ['accepted', 'rejected'],
    accepted: ['in_progress'],
    in_progress: ['completed'],
    completed: [],
    rejected: [],
};

/**
 * Inquiry Service
 * Handles CRUD operations for inquiries, inquiry_items, and inquiry_item_services.
 */
class InquiryService {
    /**
     * Get all inquiries for a partner.
     */
    async getInquiries(partnerId, status = null) {
        try {
            let query = supabase
                .from('inquiries')
                .select(`
                    *,
                    customers (id, business_name, owner_name, email, phone, address)
                `)
                .eq('partner_id', partnerId)
                .order('created_at', { ascending: false });

            if (status) {
                query = query.eq('status', status);
            }

            const { data, error } = await query;
            if (error) throw error;
            return data || [];
        } catch (error) {
            console.error('[InquiryService] getInquiries error:', error);
            throw new Error(`Unable to fetch inquiries: ${error.message}`);
        }
    }

    /**
     * Get all inquiries for a customer (their own rows).
     */
    async getInquiriesForCustomer(customerId, status = null) {
        try {
            let query = supabase
                .from('inquiries')
                .select(`
                    *,
                    customers (id, business_name, owner_name, email, phone, address)
                `)
                .eq('customer_id', customerId)
                .order('created_at', { ascending: false });

            if (status) {
                query = query.eq('status', status);
            }

            const { data, error } = await query;
            if (error) throw error;
            return data || [];
        } catch (error) {
            console.error('[InquiryService] getInquiriesForCustomer error:', error);
            throw new Error(`Unable to fetch inquiries: ${error.message}`);
        }
    }

    /**
     * Get a single inquiry with items and services.
     */
    async getInquiryById(inquiryId, partnerId = null, customerId = null) {
        try {
            let query = supabase
                .from('inquiries')
                .select(`
                    *,
                    customers (id, business_name, owner_name, email, phone, address),
                    agents (id, name, email, phone),
                    inquiry_items (
                        *,
                        inquiry_item_services (*)
                    )
                `)
                .eq('id', inquiryId);

            if (partnerId) {
                query = query.eq('partner_id', partnerId);
            } else if (customerId) {
                query = query.eq('customer_id', customerId);
            }

            const { data, error } = await query.maybeSingle();
            if (error) throw error;
            if (!data) return null;

            // Stickers consumed for this inquiry live in sticker_usage_history (one row
            // per inquiry, written by consume_partner_sticker_for_inquiry when a partner
            // accepts it) — inquiry_items.sticker_used is a legacy column that's never
            // actually set by anything running today, so it can't be used as the source.
            const { data: stickerUsage, error: stickerError } = await supabase
                .from('sticker_usage_history')
                .select('quantity, used_for, used_at')
                .eq('inquiry_id', inquiryId)
                .maybeSingle();
            if (stickerError) console.error('[InquiryService] sticker_usage_history lookup error:', stickerError);

            return { ...data, sticker_usage: stickerUsage || null };
        } catch (error) {
            console.error('[InquiryService] getInquiryById error:', error);
            throw new Error(`Unable to fetch inquiry details: ${error.message}`);
        }
    }

    /**
     * Update an inquiry record.
     */
    async updateInquiry(inquiryId, updates, partnerId = null) {
        if (updates && typeof updates.status === 'string') {
            let current;
            try {
                const { data, error } = await supabase
                    .from('inquiries')
                    .select('status, type')
                    .eq('id', inquiryId)
                    .maybeSingle();
                if (error) throw error;
                current = data;
            } catch (error) {
                console.error('[InquiryService] updateInquiry transition lookup error:', error);
                throw new Error(`Unable to update inquiry: ${error.message}`);
            }

            if (current && String(current.type || '').trim().toLowerCase() === 'validation') {
                const from = String(current.status || 'pending').trim().toLowerCase();
                const to = updates.status.trim().toLowerCase();
                const allowed = VALIDATION_STATUS_TRANSITIONS[from] || [];
                if (from !== to && !allowed.includes(to)) {
                    const err = new Error(`Cannot move Validation inquiry from '${from}' to '${to}'.`);
                    err.code = 'INVALID_STATUS_TRANSITION';
                    throw err;
                }
            }
        }

        try {
            let query = supabase
                .from('inquiries')
                .update({ ...updates, updated_at: new Date().toISOString() })
                .eq('id', inquiryId);

            if (partnerId) {
                query = query.eq('partner_id', partnerId);
            }

            const { data, error } = await query.select().maybeSingle();
            if (error) throw error;
            return data || null;
        } catch (error) {
            console.error('[InquiryService] updateInquiry error:', error);
            if (error.code === 'INVALID_STATUS_TRANSITION') throw error;
            throw new Error(`Unable to update inquiry: ${error.message}`);
        }
    }

    /**
     * Add items to an inquiry.
     */
    async addInquiryItems(inquiryId, items) {
        try {
            const itemsWithId = items.map(item => ({
                ...item,
                inquiry_id: inquiryId,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }));

            const { data, error } = await supabase
                .from('inquiry_items')
                .insert(itemsWithId)
                .select();

            if (error) throw error;
            return data || [];
        } catch (error) {
            console.error('[InquiryService] addInquiryItems error:', error);
            throw new Error(`Unable to add inquiry items: ${error.message}`);
        }
    }

    /**
     * Update an inquiry item.
     */
    async updateInquiryItem(itemId, updates) {
        try {
            const { data, error } = await supabase
                .from('inquiry_items')
                .update({ ...updates, updated_at: new Date().toISOString() })
                .eq('id', itemId)
                .select()
                .maybeSingle();

            if (error) throw error;
            return data || null;
        } catch (error) {
            console.error('[InquiryService] updateInquiryItem error:', error);
            throw new Error(`Unable to update inquiry item: ${error.message}`);
        }
    }

    /**
     * Add a service to an inquiry item.
     */
    async addItemService(itemId, serviceData) {
        try {
            const { data, error } = await supabase
                .from('inquiry_item_services')
                .insert({
                    inquiry_item_id: itemId,
                    ...serviceData,
                    status: 'Pending'
                })
                .select()
                .single();

            if (error) throw error;
            return data;
        } catch (error) {
            console.error('[InquiryService] addItemService error:', error);
            throw new Error(`Unable to add service to inquiry item: ${error.message}`);
        }
    }

    /**
     * Create a full inquiry with its associated items and extinguishers.
     * Sequence: Inquiry -> Extinguisher -> Inquiry Item
     */
    async createFullInquiry(inquiryData, items) {
        try {
            const allHistoryDates = Array.from(new Set([
                ...(inquiryData.follow_up_history || []),
                ...(inquiryData.follow_up_date ? [inquiryData.follow_up_date] : [])
            ]));

            const latestFollowUp = allHistoryDates.length > 0
                ? allHistoryDates.sort((a, b) => new Date(b) - new Date(a))[0]
                : null;

            // 1. Create Inquiry
            const { data: inquiry, error: inquiryError } = await supabase
                .from('inquiries')
                .insert([{
                    inquiry_no: inquiryData.inquiry_no,
                    customer_id: inquiryData.customer_id,
                    partner_id: inquiryData.partner_id,
                    agent_id: inquiryData.agent_id,
                    visit_id: inquiryData.visit_id,
                    type: inquiryData.type,
                    status: 'pending',
                    priority: inquiryData.priority || 'Medium',
                    performed_by: inquiryData.performed_by || 'Agent',
                    follow_up_date: latestFollowUp || null,
                    last_updated_follow_up_date: latestFollowUp || null
                }])
                .select()
                .single();

            if (inquiryError) {
                console.error('[InquiryService] createFullInquiry Step 1 (Inquiry) Error:', inquiryError);
                throw inquiryError;
            }

            // Sync latest follow-up to Visit table if modern tracking is used
            if (latestFollowUp && inquiryData.visit_id) {
                await supabase
                    .from('visits')
                    .update({ last_updated_follow_up_date: latestFollowUp })
                    .eq('id', inquiryData.visit_id);
            }

            const results = [];

            // 2. Process Items
            for (const item of items) {
                let extinguisherId = item.extinguisher_id;

                // Create extinguisher only when this item does not reference an existing one.
                if (!extinguisherId) {
                    const { data: extinguisher, error: extError } = await supabase
                        .from('extinguishers')
                        .insert([{
                            customer_id: inquiryData.customer_id,
                            visit_id: inquiryData.visit_id,
                            type: item.type || null,
                            capacity: item.capacity || null,
                            condition: item.condition || 'Good',
                            system: item.system || null,
                            unit: item.unit || 'Pieces',
                            expiry_date: item.expiry_date || null
                        }])
                        .select()
                        .single();

                    if (extError) {
                        console.error('[InquiryService] createFullInquiry Step 2 (Extinguisher) Error:', extError);
                        throw extError;
                    }
                    extinguisherId = extinguisher.id;
                }

                const itemPayload = {
                    inquiry_id: inquiry.id,
                    extinguisher_id: extinguisherId,
                    customer_id: inquiryData.customer_id,
                    serial_no: item.serial_no,
                    type: item.type || null,
                    system_type: item.system_type || null,
                    quantity: item.quantity || 1,
                    price: item.price || 0,
                    unit: item.unit || 'Pieces',
                    system: item.system || null,
                    condition: item.condition || 'Good',
                    status: item.status || 'Active',
                    catalog_no: item.catalog_no || null,
                    product_id: item.product_id || null,
                    maintenance_notes: item.maintenance_notes || null,
                    maintenance_voice_url: item.maintenance_voice_url || null,
                    maintenance_unit_photo_url: item.maintenance_unit_photo_url || null,
                    performed_by: item.performed_by || inquiryData.performed_by || 'Agent',
                    expiry_date: item.expiry_date || null,
                    follow_up_date: latestFollowUp || null,
                    last_updated_follow_up_date: latestFollowUp || null,
                    follow_up_date_validation: item.follow_up_date_validation || null,
                    validation_mode: item.validation_mode || 'new',
                    is_sub_unit: item.is_sub_unit || false,
                    extinguisher_photo: item.extinguisher_photo || null,
                    query_status: 'Active'
                };

                const { data: savedItem, error: itemError } = await supabase
                    .from('inquiry_items')
                    .insert([itemPayload])
                    .select()
                    .single();

                if (itemError) {
                    console.error('[InquiryService] createFullInquiry Step 3 (Item) Error:', itemError);
                    throw itemError;
                }

                // Create follow-up history records
                if (allHistoryDates.length > 0) {
                    const historyRecords = allHistoryDates.map(date => ({
                        inquiry_item_id: savedItem.id,
                        follow_up_date: date,
                        is_locked: true
                    }));

                    const { error: historyError } = await supabase
                        .from('follow_up_history')
                        .insert(historyRecords);

                    if (historyError) {
                        console.error('[InquiryService] createFullInquiry Step 4 (History) Error:', historyError);
                        // We continue even if history fails, but log it
                    }
                }

                results.push(savedItem);
            }

            return { inquiry, items: results };
        } catch (error) {
            console.error('[InquiryService] createFullInquiry error:', error);
            throw new Error(`Unable to create inquiry: ${error.message}`);
        }
    }
}

module.exports = new InquiryService();
