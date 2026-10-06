const supabase = require('../supabase');
const { isRenewalOnlyInquiry } = require('./renewalHelpers');
const { recordInquiryEvent } = require('./inquiryEvents');
const { isActiveAgentStatus } = require('./agentStatus');

/**
 * Allowed status transitions for Validation inquiries (and, additionally,
 * renewal-only Refill inquiries — see isGatedTransitionType below). Other
 * inquiry types (Maintenance/Refill/New Unit) keep their own status handling
 * untouched — this only gates the generic PATCH /inquiries/:id path when the
 * target row's type is 'validation', or when it's a Refill inquiry made up
 * entirely of License Renewal items (which has no delivery/pickup logistics
 * and should behave like Validation's simple accept/reject lifecycle, not
 * Refill's own).
 */
const VALIDATION_STATUS_TRANSITIONS = {
    pending: ['accepted', 'rejected'],
    accepted: ['in_progress'],
    in_progress: ['completed'],
    completed: [],
    rejected: [],
};

/**
 * Validation inquiries a customer requested directly (performed_by 'Customer') use the
 * shorter customer-request lifecycle: Pending -> Accepted (by the Partner Admin assigned)
 * -> Completed. Same stored status values as above; only 'in_progress' is skipped.
 */
const CUSTOMER_VALIDATION_STATUS_TRANSITIONS = {
    pending: ['accepted', 'rejected'],
    accepted: ['completed'],
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
     * Get all inquiries for a customer (their own rows), with the child data the
     * customer dashboard renders (items, assigned partner/agent names, activity).
     * Kept lean — heavy columns (photos, voice notes, file URLs) are left out.
     */
    async getInquiriesForCustomer(customerId, status = null) {
        const run = () => {
            let query = supabase
                .from('inquiries')
                .select(`
                    *,
                    customers (id, business_name, owner_name, email, phone, address),
                    partners (id, business_name, phone, email),
                    agents (name),
                    inquiry_items (
                        id, serial_no, type, system_type, quantity, unit, validation_mode, status, expiry_date, product_id,
                        catalog_no, license_number, license_authority, license_renewal_date,
                        products (id, name, model_number)
                    ),
                    site_assessments (inquiry_id, created_at, updated_at),
                    inspection_reports (id, report_title, inspection_date, created_at)
                `)
                .eq('customer_id', customerId)
                .order('created_at', { ascending: false });

            if (status) {
                query = query.eq('status', status);
            }
            return query;
        };

        try {
            // No partner/agent/type filter on purpose: a customer request pending with Admin
            // (partner_id/agent_id NULL) must be listed like any other inquiry.
            const { data, error } = await withTransientRetry(run);
            if (error) throw error;
            return data || [];
        } catch (error) {
            console.error('[InquiryService] getInquiriesForCustomer error:', error?.message, error?.code || '', error?.details || '', error?.hint || '');
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
                    partners (id, business_name, phone, email),
                    inquiry_items (
                        *,
                        inquiry_item_services (*),
                        products (id, name, model_number, description, specifications, image_url, categories (name))
                    ),
                    inspection_reports (id, report_title, inspection_date, file_url, file_name, created_at)
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
     * Event log (inquiry_events) for one inquiry, oldest first. Visible to the owning
     * customer, the assigned partner and admins only.
     */
    async getInquiryEvents(inquiryId, user) {
        const { data: inquiry, error: inquiryErr } = await supabase
            .from('inquiries')
            .select('id, customer_id, partner_id')
            .eq('id', inquiryId)
            .maybeSingle();
        // 22P02 = malformed uuid — treat like a missing inquiry rather than a 500.
        if (inquiryErr && inquiryErr.code !== '22P02') throw new Error(`Unable to fetch inquiry events: ${inquiryErr.message}`);
        if (!inquiry) return { ok: false, code: 404, message: 'Inquiry not found.' };

        const { id: userId, role } = user || {};
        const allowed =
            role === 'admin' ||
            (role === 'customer' && String(inquiry.customer_id) === String(userId)) ||
            (role === 'partner' && inquiry.partner_id && String(inquiry.partner_id) === String(userId));
        if (!allowed) return { ok: false, code: 403, message: 'Access denied.' };

        const { data, error } = await supabase
            .from('inquiry_events')
            .select('id, event_type, from_status, to_status, actor_role, metadata, created_at')
            .eq('inquiry_id', inquiryId)
            .order('created_at', { ascending: true });
        if (error) throw new Error(`Unable to fetch inquiry events: ${error.message}`);
        return { ok: true, data: data || [] };
    }

    /**
     * Update an inquiry record.
     */
    async updateInquiry(inquiryId, updates, partnerId = null, actor = null) {
        let current = null;
        if (updates && typeof updates.status === 'string') {
            try {
                const { data, error } = await supabase
                    .from('inquiries')
                    .select('status, type, performed_by')
                    .eq('id', inquiryId)
                    .maybeSingle();
                if (error) throw error;
                current = data;
            } catch (error) {
                console.error('[InquiryService] updateInquiry transition lookup error:', error);
                throw new Error(`Unable to update inquiry: ${error.message}`);
            }

            const typeKey = String(current?.type || '').trim().toLowerCase();
            const isValidationType = typeKey === 'validation';
            const isRefillType = typeKey === 'refill' || typeKey === 'refilled';
            const renewalOnly = Boolean(current) && (isValidationType || isRefillType)
                && await isRenewalOnlyInquiry(supabase, inquiryId);
            const isGatedTransitionType = current && (isValidationType || (isRefillType && renewalOnly));

            if (isGatedTransitionType) {
                const from = String(current.status || 'pending').trim().toLowerCase();
                const to = updates.status.trim().toLowerCase();
                const isCustomerValidation = isValidationType && !renewalOnly
                    && String(current.performed_by || '').trim().toLowerCase() === 'customer';
                const transitions = isCustomerValidation ? CUSTOMER_VALIDATION_STATUS_TRANSITIONS : VALIDATION_STATUS_TRANSITIONS;
                let allowed = transitions[from] || [];

                // A renewal-only inquiry that was auto-completed at creation (before
                // that Validation shortcut was fixed) sits at 'completed' but was
                // never really accepted and has no quotation — let the partner
                // still Accept/Reject it.
                if (renewalOnly && from === 'completed' && (to === 'accepted' || to === 'rejected')) {
                    const { data: existingQuote } = await supabase
                        .from('quotations')
                        .select('id')
                        .eq('inquiry_id', inquiryId)
                        .maybeSingle();
                    if (!existingQuote) allowed = [...allowed, 'accepted', 'rejected'];
                }

                if (from !== to && !allowed.includes(to)) {
                    const err = new Error(`Cannot move inquiry from '${from}' to '${to}'.`);
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

            // Only a real status change is logged (same-status PATCHes and non-status
            // field edits are not timeline events).
            if (data && current && typeof updates.status === 'string') {
                const fromStatus = current.status || null;
                if (String(fromStatus || '').trim().toLowerCase() !== String(data.status || '').trim().toLowerCase()) {
                    const metadata = {};
                    if (updates.rejection_reason) metadata.rejection_reason = updates.rejection_reason;
                    await recordInquiryEvent({
                        inquiryId,
                        eventType: 'status_changed',
                        fromStatus,
                        toStatus: data.status,
                        actor,
                        metadata,
                    });
                }
            }

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
    async createFullInquiry(inquiryData, items, actingUser = {}) {
        try {
            // Trust the verified JWT for agent attribution rather than a client-supplied
            // agent_id — nothing previously stopped one agent's token from creating an
            // inquiry attributed to a different agent_id.
            if (actingUser.role === 'agent') {
                inquiryData = { ...inquiryData, agent_id: actingUser.id };
            }

            if (inquiryData.partner_id) {
                const { data: partner, error: partnerErr } = await supabase
                    .from('partners')
                    .select('id, status')
                    .eq('id', inquiryData.partner_id)
                    .maybeSingle();
                if (partnerErr) throw partnerErr;
                if (!partner || partner.status !== 'Active') {
                    const err = new Error('Selected Partner is not available.');
                    err.status = 400;
                    throw err;
                }

                // Defense-in-depth — enforce_inquiry_item_product_assignment (DB trigger)
                // is the real, unbypassable enforcement; this just gives a clean 409
                // instead of a raw Postgres exception.
                const productIds = Array.from(new Set((items || []).map((it) => it.product_id).filter(Boolean)));
                if (productIds.length > 0) {
                    const { data: assignedRows, error: assignedErr } = await supabase
                        .from('partner_products')
                        .select('product_id')
                        .eq('partner_id', inquiryData.partner_id)
                        .in('product_id', productIds);
                    if (assignedErr) throw assignedErr;
                    const assignedSet = new Set((assignedRows || []).map((r) => r.product_id));
                    const unassignedProductId = productIds.find((id) => !assignedSet.has(id));
                    if (unassignedProductId) {
                        const err = new Error('One of the selected products is not assigned to this Partner.');
                        err.status = 409;
                        throw err;
                    }
                }

                // Same defense-in-depth for service availability — enforce_partner_service_availability
                // (DB trigger) is the real enforcement.
                const subtype = ['Validation', 'Refill'].includes(inquiryData.type)
                    ? (items?.[0]?.validation_mode || 'new')
                    : 'default';

                const [{ data: globalRow }, { data: partnerAvailabilityRow }] = await Promise.all([
                    supabase.from('service_availability')
                        .select('is_enabled')
                        .eq('service_type', inquiryData.type)
                        .eq('service_subtype', subtype)
                        .maybeSingle(),
                    supabase.from('partner_service_availability')
                        .select('is_enabled, admin_enabled')
                        .eq('partner_id', inquiryData.partner_id)
                        .eq('service_type', inquiryData.type)
                        .eq('service_subtype', subtype)
                        .maybeSingle(),
                ]);

                if (globalRow?.is_enabled === false) {
                    const err = new Error(`${inquiryData.type} ${subtype} service is currently unavailable.`);
                    err.status = 409;
                    throw err;
                }
                if (partnerAvailabilityRow?.admin_enabled === false || partnerAvailabilityRow?.is_enabled === false) {
                    const err = new Error('This Partner does not currently offer this service.');
                    err.status = 409;
                    throw err;
                }
            }

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

    /**
     * Reference data for the inquiry-create form. Customers only get what their form
     * needs (service availability + the active product catalog) — Partner data is not
     * exposed to them, since a customer never picks a Partner (Admin assigns one).
     * Agent/Admin callers keep the full set used by the shared eligibility rules
     * (frontend/src/utils/productPartnerEligibility.js).
     */
    async getInquiryFormOptions(role = null) {
        const productsQuery = supabase
            .from('products')
            .select('id, name, model_number, description, specifications, image_url, is_active, categories(name)')
            .eq('is_active', true);
        const globalQuery = supabase.from('service_availability').select('service_type, service_subtype, is_enabled');

        if (role === 'customer') {
            const [globalAvailability, products] = await Promise.all([globalQuery, productsQuery]);
            for (const res of [globalAvailability, products]) {
                if (res.error) throw new Error(`Unable to load inquiry form options: ${res.error.message}`);
            }
            return {
                globalAvailability: globalAvailability.data || [],
                products: (products.data || []).map((p) => ({ ...p, category: p.categories?.name || 'Other' })),
            };
        }

        const [partners, partnerAvailability, globalAvailability, products, partnerProducts] = await Promise.all([
            supabase.from('partners').select('id, business_name').eq('status', 'Active'),
            supabase.from('partner_service_availability').select('partner_id, service_type, service_subtype, is_enabled, admin_enabled'),
            globalQuery,
            productsQuery,
            supabase.from('partner_products').select('partner_id, product_id'),
        ]);
        for (const res of [partners, partnerAvailability, globalAvailability, products, partnerProducts]) {
            if (res.error) throw new Error(`Unable to load inquiry form options: ${res.error.message}`);
        }
        return {
            partners: partners.data || [],
            partnerAvailability: partnerAvailability.data || [],
            globalAvailability: globalAvailability.data || [],
            products: (products.data || []).map((p) => ({ ...p, category: p.categories?.name || 'Other' })),
            partnerProducts: partnerProducts.data || [],
        };
    }

    /**
     * Find an active catalog product by the code a customer types in:
     *   - CAT No    = products.cat_no (AIR-0001…, any active product, case-insensitive exact match)
     *   - Product#  = products.model_number (any active product, case-insensitive exact match)
     *   - CAT#      = inquiry_items.catalog_no on one of THIS customer's own items (the
     *                 catalog number stamped on installed units), resolved through its product_id.
     * CAT# lookups are scoped to the customer so one customer can't probe another's equipment.
     */
    async lookupProductByCode(code, customerId) {
        const raw = String(code || '').trim();
        if (!raw) return [];
        // ilike with no wildcards = case-insensitive equality; escape LIKE metacharacters.
        const pattern = raw.replace(/[\\%_]/g, (c) => `\\${c}`);
        const productFields = 'id, name, cat_no, model_number, description, specifications, image_url, is_active, categories(name)';

        const [byCatNo, byModel, byCatalog] = await Promise.all([
            supabase.from('products').select(productFields).eq('is_active', true).ilike('cat_no', pattern),
            supabase.from('products').select(productFields).eq('is_active', true).ilike('model_number', pattern),
            supabase
                .from('inquiry_items')
                .select('catalog_no, product_id')
                .eq('customer_id', customerId)
                .ilike('catalog_no', pattern)
                .not('product_id', 'is', null),
        ]);
        if (byCatNo.error) throw new Error(`Unable to look up product: ${byCatNo.error.message}`);
        if (byModel.error) throw new Error(`Unable to look up product: ${byModel.error.message}`);
        if (byCatalog.error) throw new Error(`Unable to look up product: ${byCatalog.error.message}`);

        const matches = new Map();
        const withCategory = (p) => ({ ...p, category: p.categories?.name || 'Other' });
        (byCatNo.data || []).forEach((p) => matches.set(p.id, { product: withCategory(p), matched_by: 'cat_no', catalog_no: p.cat_no }));
        (byModel.data || []).forEach((p) => {
            if (!matches.has(p.id)) matches.set(p.id, { product: withCategory(p), matched_by: 'product_number', catalog_no: null });
        });

        const catalogByProduct = new Map((byCatalog.data || []).map((r) => [r.product_id, r.catalog_no]));
        const missing = [...catalogByProduct.keys()].filter((id) => !matches.has(id));
        if (missing.length > 0) {
            const { data, error } = await supabase.from('products').select(productFields).eq('is_active', true).in('id', missing);
            if (error) throw new Error(`Unable to look up product: ${error.message}`);
            (data || []).forEach((p) => matches.set(p.id, { product: withCategory(p), matched_by: 'cat_number', catalog_no: catalogByProduct.get(p.id) }));
        }
        for (const [productId, catalogNo] of catalogByProduct) {
            const m = matches.get(productId);
            if (m && m.matched_by === 'product_number') m.catalog_no = catalogNo;
        }
        return [...matches.values()];
    }

    /**
     * The Agent who created a customer — a customer request is auto-assigned to them.
     * The customers table has no creator column; the existing records that identify it:
     *   - customers.status: the Agent Visit Form creates customers as 'Lead'
     *     (VisitForm.jsx, both insert paths); self-registration (POST /auth/register/customer)
     *     leaves the DB default 'Active'. Nothing changes it afterwards. So only a 'Lead'
     *     customer was Agent-created; any other customer is self-created → Admin.
     *   - visits.agent_id of the customer's FIRST visit: the visit the creating Agent logged
     *     with the customer (created in the same submit). A later visit by another Agent
     *     never changes who created the customer.
     *   - when the Agent created the customer from the QR step but no visit exists yet, the
     *     creator is the version-1 customer_qr_history.generated_by (the creating Agent's
     *     name, or email when the name is missing) — used only if it matches exactly one Agent.
     * If the creator can't be identified, or their account isn't active (same rule as Agent
     * login: 'accepted' or legacy 'active' — otherwise they couldn't sign in to handle it),
     * the request goes to Admin, never to a different Agent.
     */
    async resolveCreatorAgent(customerId) {
        const none = (basis) => ({ agentId: null, basis });

        const { data: customer, error: customerErr } = await supabase
            .from('customers').select('id, status').eq('id', customerId).maybeSingle();
        if (customerErr) throw new Error(`Unable to resolve customer agent: ${customerErr.message}`);
        if (!customer || String(customer.status || '').trim().toLowerCase() !== 'lead') {
            return none('self_created');
        }

        let creatorId = null;
        const { data: firstVisit, error: visitErr } = await supabase
            .from('visits')
            .select('agent_id, visit_date')
            .eq('customer_id', customerId)
            .not('agent_id', 'is', null)
            .order('visit_date', { ascending: true })
            .limit(1)
            .maybeSingle();
        if (visitErr) throw new Error(`Unable to resolve customer agent: ${visitErr.message}`);
        if (firstVisit) {
            creatorId = firstVisit.agent_id;
        } else {
            const { data: qr } = await supabase
                .from('customer_qr_history')
                .select('generated_by')
                .eq('customer_id', customerId)
                .order('version', { ascending: true })
                .limit(1)
                .maybeSingle();
            const by = String(qr?.generated_by || '').trim();
            if (by && by.toLowerCase() !== 'agent') {
                const { data: matches } = await supabase
                    .from('agents').select('id, name, email');
                const hits = (matches || []).filter((a) =>
                    String(a.name || '').trim().toLowerCase() === by.toLowerCase() ||
                    String(a.email || '').trim().toLowerCase() === by.toLowerCase());
                if (hits.length === 1) creatorId = hits[0].id;
            }
        }
        if (creatorId == null) return none('creator_unknown');

        const { data: agent, error: agentErr } = await supabase
            .from('agents').select('id, status').eq('id', creatorId).maybeSingle();
        if (agentErr) throw new Error(`Unable to resolve customer agent: ${agentErr.message}`);
        if (!agent || !isActiveAgentStatus(agent.status)) {
            return { ...none('creator_inactive'), creatorId };
        }
        return { agentId: agent.id, basis: 'creator_agent', creatorId };
    }

    /**
     * Customer-created inquiry (Customer "New inquiry" page). Admin-first workflow:
     *   - identity comes from the verified JWT; any customer_id / partner_id / status /
     *     agent_id in the request body is ignored
     *   - never assigned to a Partner here — every customer request is saved as a General
     *     Inquiry (is_general_inquiry, partner_id NULL) so it lands in the Admin General
     *     Inquiries list, and Admin assigns an eligible Partner (PUT /admin/inquiries/:id/assign-partner)
     *   - auto-assigned (inquiries.agent_id) to the Agent who created the customer (see
     *     resolveCreatorAgent); a self-created customer's request has agent_id NULL and Admin
     *     assigns an Agent (PUT /admin/inquiries/:id/assign-agent)
     *   - starts 'pending' (a request for work, not a record of work done on site)
     *   - service availability, sub-type fields and product validity are still enforced
     *   - no extinguisher rows are created; an existing one is only linked after an ownership check
     * The 'created' timeline event comes from the DB trigger on inquiries insert.
     */
    async createCustomerInquiry(inquiryData = {}, items = [], actingUser = {}) {
        const fail = (status, message) => {
            const err = new Error(message);
            err.status = status;
            return err;
        };

        const customerId = actingUser.id;
        const type = inquiryData.type;
        if (!CUSTOMER_INQUIRY_TYPES.includes(type)) throw fail(400, 'Invalid inquiry type.');
        if (!Array.isArray(items) || items.length === 0) throw fail(400, 'Add at least one item to the inquiry.');

        const hasSubtypes = type === 'Validation' || type === 'Refill';

        const normalizedItems = items.map((it) => ({
            ...it,
            validation_mode: hasSubtypes ? (it.validation_mode || 'new') : 'new',
        }));
        for (const it of normalizedItems) {
            if (!SUBTYPES.includes(it.validation_mode)) throw fail(400, 'Invalid inquiry sub-type.');
            if (it.validation_mode === 'license-renewal' &&
                (!it.license_number || !it.license_authority || !it.license_renewal_date)) {
                throw fail(400, 'License number, issuing authority and renewal date are required for a License Renewal.');
            }
            if (it.validation_mode === 'followup' && !it.follow_up_date_validation) {
                throw fail(400, 'A follow-up date is required.');
            }
            if (!(Number(it.quantity) >= 1)) throw fail(400, 'Quantity must be at least 1.');
        }
        // Unlike the Agent form, a customer's Refill doesn't have to name the product: the
        // customer form has no product lookup for Validation / Refill (unit details only).

        // Admin global switch.
        const subtypes = Array.from(new Set(normalizedItems.map((it) => (hasSubtypes ? it.validation_mode : 'default'))));
        const { data: globalRows, error: globalErr } = await supabase
            .from('service_availability')
            .select('service_subtype, is_enabled')
            .eq('service_type', type)
            .in('service_subtype', subtypes);
        if (globalErr) throw new Error(`Unable to create inquiry: ${globalErr.message}`);
        const globallyOff = (globalRows || []).find((r) => r.is_enabled === false);
        if (globallyOff) throw fail(409, `${type} ${globallyOff.service_subtype} service is currently unavailable.`);

        // Referenced products must be real, active catalog products.
        const productIds = Array.from(new Set(normalizedItems.map((it) => it.product_id).filter(Boolean)));
        if (productIds.length > 0) {
            const { data: found, error: foundErr } = await supabase
                .from('products').select('id').eq('is_active', true).in('id', productIds);
            if (foundErr) throw new Error(`Unable to create inquiry: ${foundErr.message}`);
            const foundSet = new Set((found || []).map((p) => String(p.id)));
            if (productIds.some((id) => !foundSet.has(String(id)))) throw fail(400, 'One of the selected products is not available.');
        }

        // Existing equipment may only be linked if it belongs to this customer.
        const extinguisherIds = Array.from(new Set(normalizedItems.map((it) => it.extinguisher_id).filter((v) => v != null)));
        if (extinguisherIds.length > 0) {
            const { data: owned, error: ownedErr } = await supabase
                .from('extinguishers').select('id, customer_id').in('id', extinguisherIds);
            if (ownedErr) throw new Error(`Unable to create inquiry: ${ownedErr.message}`);
            const ownedSet = new Set((owned || []).filter((e) => String(e.customer_id) === String(customerId)).map((e) => String(e.id)));
            if (extinguisherIds.some((id) => !ownedSet.has(String(id)))) throw fail(400, 'Selected equipment was not found on your account.');
        }

        const referral = await this.resolveCreatorAgent(customerId);

        // Inquiry number — same format as the Agent flow, generated server-side and
        // checked for uniqueness before use.
        let inquiryNo = null;
        for (let attempt = 0; attempt < 5 && !inquiryNo; attempt++) {
            const candidate = `INQ-${Math.floor(100000 + Math.random() * 900000)}`;
            const { data: clash } = await supabase.from('inquiries').select('id').eq('inquiry_no', candidate).maybeSingle();
            if (!clash) inquiryNo = candidate;
        }
        if (!inquiryNo) throw new Error('Unable to create inquiry: could not allocate an inquiry number.');

        const inquiryRow = {
            inquiry_no: inquiryNo,
            customer_id: customerId,
            partner_id: null,
            agent_id: referral.agentId,
            type,
            status: 'pending',
            priority: 'Medium',
            performed_by: 'Customer',
            is_general_inquiry: true,
        };
        const optional = {};
        if (inquiryData.internal_reference_number) optional.internal_reference_number = String(inquiryData.internal_reference_number).trim();
        if (inquiryData.notes) optional.notes = String(inquiryData.notes).trim();
        if (inquiryData.preferred_date) optional.preferred_date = inquiryData.preferred_date;
        // Optional PDF (any service), uploaded first via POST /inquiries/customer-document.
        // Only a file this customer uploaded is accepted — never an arbitrary URL.
        if (inquiryData.customer_document_url) {
            const { data: urlData } = supabase.storage.from('photo-references')
                .getPublicUrl(`${CUSTOMER_DOCUMENT_PREFIX}customer-${customerId}-`);
            const ownPrefix = urlData?.publicUrl || '';
            const url = String(inquiryData.customer_document_url);
            if (!ownPrefix || !url.startsWith(ownPrefix) || !/^\d+\.pdf$/.test(url.slice(ownPrefix.length))) {
                throw fail(400, 'The attached document could not be verified. Please upload it again.');
            }
            optional.customer_document_url = url;
            optional.customer_document_name = String(inquiryData.customer_document_name || 'document.pdf').trim().slice(0, 255);
        }

        let insertRes = await supabase.from('inquiries').insert([{ ...inquiryRow, ...optional }]).select().single();
        // internal_reference_number / notes / preferred_date are added by migration
        // 20260930100000_inquiry_customer_request_fields.sql, customer_document_* by
        // 20261005100000_inquiry_customer_document.sql — retry without them if one hasn't
        // been applied yet, rather than failing the whole request. The document columns are
        // dropped first on their own so a missing one doesn't also lose the reference/notes.
        if (insertRes.error && optional.customer_document_url && isMissingColumnError(insertRes.error)
            && /customer_document/.test(insertRes.error.message || '')) {
            console.warn('[InquiryService] createCustomerInquiry: customer_document columns missing, saving without the document');
            delete optional.customer_document_url;
            delete optional.customer_document_name;
            insertRes = await supabase.from('inquiries').insert([{ ...inquiryRow, ...optional }]).select().single();
        }
        if (insertRes.error && Object.keys(optional).length > 0 && isMissingColumnError(insertRes.error)) {
            console.warn('[InquiryService] createCustomerInquiry: request-detail columns missing, saving without them');
            insertRes = await supabase.from('inquiries').insert([inquiryRow]).select().single();
        }
        if (insertRes.error) throw new Error(`Unable to create inquiry: ${insertRes.error.message}`);
        const inquiry = insertRes.data;

        const itemRows = normalizedItems.map((it, idx) => ({
            inquiry_id: inquiry.id,
            customer_id: customerId,
            extinguisher_id: it.extinguisher_id ?? null,
            serial_no: idx + 1,
            type: it.type || null,
            system_type: it.system_type || null,
            capacity: it.capacity || null,
            quantity: Number(it.quantity) || 1,
            price: 0,
            unit: it.unit || 'Pieces',
            system: it.system || null,
            condition: 'Good',
            status: 'Pending',
            catalog_no: it.catalog_no ? String(it.catalog_no).trim() : null,
            product_id: it.product_id || null,
            maintenance_notes: it.maintenance_notes || null,
            expiry_date: it.validation_mode === 'license-renewal' ? null : (it.expiry_date || null),
            performed_by: 'Customer',
            is_sub_unit: Boolean(it.is_sub_unit),
            validation_mode: it.validation_mode,
            follow_up_date_validation: it.validation_mode === 'followup' ? (it.follow_up_date_validation || null) : null,
            license_number: it.validation_mode === 'license-renewal' ? it.license_number : null,
            license_authority: it.validation_mode === 'license-renewal' ? it.license_authority : null,
            license_renewal_date: it.validation_mode === 'license-renewal' ? it.license_renewal_date : null,
            license_notes: it.validation_mode === 'license-renewal' ? (it.license_notes || null) : null,
            license_document_url: it.validation_mode === 'license-renewal' ? (it.license_document_url || null) : null,
            query_status: 'Active',
        }));

        const { data: savedItems, error: itemsErr } = await supabase.from('inquiry_items').insert(itemRows).select();
        if (itemsErr) {
            await supabase.from('inquiry_items').delete().eq('inquiry_id', inquiry.id);
            await supabase.from('inquiries').delete().eq('id', inquiry.id);
            // DB triggers (service availability / product checks) raise readable messages.
            throw fail(409, itemsErr.message || 'Could not save the inquiry items.');
        }

        await recordInquiryEvent({
            inquiryId: inquiry.id,
            eventType: 'routed_to_admin',
            actor: { id: customerId, role: 'customer' },
            metadata: { referral_basis: referral.basis, agent_referred: Boolean(referral.agentId) },
        });

        await this.notifyOnCustomerInquiryCreated({ inquiry, items: normalizedItems, customerId, referral });

        return { inquiry, items: savedItems || [] };
    }

    /**
     * Creation notifications for a customer request (best-effort — never fails creation):
     * the configured General Inquiry Admins (same RPC the Agent flow uses), and the
     * referred Agent, if any.
     */
    async notifyOnCustomerInquiryCreated({ inquiry, items, customerId, referral }) {
        try {
            const { data: customerRow } = await supabase
                .from('customers').select('business_name').eq('id', customerId).maybeSingle();
            const customerName = customerRow?.business_name || 'A customer';
            const subtype = SUBTYPE_LABELS[inquiry.type]?.[items[0]?.validation_mode || 'new'];
            const typeLabel = subtype ? `${inquiry.type} - ${subtype}` : inquiry.type;
            const rows = [];

            const recipients = await getGeneralInquiryRecipients();
            const adminAction = referral.agentId
                ? 'It was assigned to the Agent who created this customer. Please review and assign a Partner.'
                : 'Please assign an Agent and a Partner.';
            (recipients || []).forEach((r) => rows.push({
                sender_id: String(customerId),
                sender_role: 'Customer',
                recipient_id: String(r.id),
                recipient_role: 'Admin',
                message: `Customer ${customerName} requested ${typeLabel} (${inquiry.inquiry_no}). ${adminAction}`,
                inquiry_id: inquiry.id,
                type: 'general_inquiry',
                title: 'New Customer Request',
            }));

            if (referral.agentId) {
                rows.push({
                    sender_id: String(customerId),
                    sender_role: 'Customer',
                    recipient_id: String(referral.agentId),
                    recipient_role: 'Agent',
                    message: `Your customer ${customerName} requested ${typeLabel} (${inquiry.inquiry_no}). It has been assigned to you; Admin will assign a Partner.`,
                    inquiry_id: inquiry.id,
                    type: 'customer_inquiry_referred',
                    title: 'Customer Request Assigned',
                });
            }

            if (rows.length > 0) {
                const { error } = await supabase.from('notifications').insert(rows);
                if (error) console.error('[InquiryService] customer inquiry notification insert error:', error.message);
            }
        } catch (err) {
            console.error('[InquiryService] customer inquiry notifications failed:', err?.message || err);
        }
    }

    /**
     * Admin assigns an Agent to an inquiry that has no active Agent:
     *   - a customer request with no Agent (self-created customer, or the creating Agent
     *     was inactive when the customer booked) — customer requests only, as before
     *   - any inquiry whose current Agent is no longer active (agents.status not
     *     'accepted'/'active' — on hold, rejected — or the agent record is gone), so work
     *     doesn't stay stuck with an Agent who has left
     * An inquiry whose Agent is still active is never reassigned here (409). Only active
     * Agents can be assigned. The write is conditioned on agent_id still being the value
     * read, so concurrent assigns can't both win. The inquiry row, number, items and
     * history are untouched apart from agent_id; the timeline records the previous Agent.
     */
    async assignAgentToCustomerRequest(inquiryId, agentId, actingAdmin) {
        const fail = (status, message) => ({ ok: false, code: status, message });
        if (agentId == null || agentId === '') return fail(400, 'agent_id is required.');

        const { data: inquiry, error: inquiryErr } = await supabase
            .from('inquiries')
            .select('id, inquiry_no, type, status, agent_id, customer_id, performed_by')
            .eq('id', inquiryId)
            .maybeSingle();
        if (inquiryErr && inquiryErr.code !== '22P02') throw new Error(`Unable to assign agent: ${inquiryErr.message}`);
        if (!inquiry) return fail(404, 'Inquiry not found.');

        const previousAgentId = inquiry.agent_id;
        let previousAgentStatus = null;
        if (previousAgentId == null) {
            if (String(inquiry.performed_by || '').trim().toLowerCase() !== 'customer') {
                return fail(400, 'Agents can only be assigned here to customer requests.');
            }
        } else {
            const { data: current, error: currentErr } = await supabase
                .from('agents').select('id, status').eq('id', previousAgentId).maybeSingle();
            if (currentErr) throw new Error(`Unable to assign agent: ${currentErr.message}`);
            if (current && isActiveAgentStatus(current.status)) {
                return fail(409, 'This inquiry already has an active Agent assigned.');
            }
            previousAgentStatus = current ? String(current.status || '').trim().toLowerCase() : 'missing';
        }

        const { data: agent, error: agentErr } = await supabase
            .from('agents').select('id, name, status').eq('id', agentId).maybeSingle();
        if (agentErr && agentErr.code !== '22P02') throw new Error(`Unable to assign agent: ${agentErr.message}`);
        if (!agent || !isActiveAgentStatus(agent.status)) {
            return fail(400, 'Agent not found or not active.');
        }

        let update = supabase
            .from('inquiries')
            .update({ agent_id: agent.id, updated_at: new Date().toISOString() })
            .eq('id', inquiryId);
        update = previousAgentId == null ? update.is('agent_id', null) : update.eq('agent_id', previousAgentId);
        const { data: updated, error: updateErr } = await update.select().maybeSingle();
        if (updateErr) throw new Error(`Unable to assign agent: ${updateErr.message}`);
        if (!updated) return fail(409, 'The Agent on this inquiry changed meanwhile. Reload and try again.');

        await recordInquiryEvent({
            inquiryId,
            eventType: 'agent_assigned',
            actor: { id: actingAdmin?.id, role: 'admin' },
            metadata: previousAgentId == null
                ? { source: 'admin_assign', agent_id: agent.id }
                : { source: 'admin_reassign_inactive', agent_id: agent.id, previous_agent_id: previousAgentId, previous_agent_status: previousAgentStatus },
        });

        try {
            const { data: customerRow } = await supabase
                .from('customers').select('business_name').eq('id', inquiry.customer_id).maybeSingle();
            const { data: firstItem } = await supabase
                .from('inquiry_items').select('validation_mode').eq('inquiry_id', inquiryId).limit(1).maybeSingle();
            const subtype = SUBTYPE_LABELS[inquiry.type]?.[firstItem?.validation_mode || 'new'];
            const typeLabel = subtype ? `${inquiry.type} - ${subtype}` : inquiry.type;
            const { error } = await supabase.from('notifications').insert([{
                sender_id: actingAdmin?.id != null ? String(actingAdmin.id) : null,
                sender_role: 'Admin',
                recipient_id: String(agent.id),
                recipient_role: 'Agent',
                message: previousAgentId == null
                    ? `Admin assigned you a customer request: ${typeLabel} (${inquiry.inquiry_no}) from ${customerRow?.business_name || 'a customer'}.`
                    : `Admin reassigned an inquiry to you: ${typeLabel} (${inquiry.inquiry_no}) from ${customerRow?.business_name || 'a customer'} — its previous Agent is no longer active.`,
                inquiry_id: inquiryId,
                type: 'customer_inquiry_referred',
                title: previousAgentId == null ? 'Customer Request Assigned' : 'Inquiry Reassigned',
            }]);
            if (error) console.error('[InquiryService] agent assignment notification error:', error.message);
        } catch (err) {
            console.error('[InquiryService] agent assignment notification failed:', err?.message || err);
        }

        return { ok: true, data: updated };
    }

    /**
     * Eligibility of a Partner for an existing inquiry — the same rules the Agent form
     * and the shared frontend utility apply (productPartnerEligibility.js): Admin global
     * switch, Admin per-partner override, the Partner's own preference (missing rows =
     * enabled), and every referenced product assigned to that Partner.
     * Returns null when eligible, otherwise a human-readable reason.
     */
    async getPartnerIneligibilityReason(inquiryId, inquiryType, partnerId) {
        const { data: items, error: itemsErr } = await supabase
            .from('inquiry_items').select('validation_mode, product_id').eq('inquiry_id', inquiryId);
        if (itemsErr) throw new Error(`Unable to check partner eligibility: ${itemsErr.message}`);

        const hasSubtypes = inquiryType === 'Validation' || inquiryType === 'Refill';
        const subtypes = Array.from(new Set((items || []).map((it) => (hasSubtypes ? (it.validation_mode || 'new') : 'default'))));
        if (subtypes.length === 0) subtypes.push(hasSubtypes ? 'new' : 'default');

        const [globalRes, availRes] = await Promise.all([
            supabase.from('service_availability').select('service_subtype, is_enabled')
                .eq('service_type', inquiryType).in('service_subtype', subtypes),
            supabase.from('partner_service_availability').select('service_subtype, is_enabled, admin_enabled')
                .eq('partner_id', partnerId).eq('service_type', inquiryType).in('service_subtype', subtypes),
        ]);
        if (globalRes.error) throw new Error(`Unable to check partner eligibility: ${globalRes.error.message}`);
        if (availRes.error) throw new Error(`Unable to check partner eligibility: ${availRes.error.message}`);
        if ((globalRes.data || []).some((r) => r.is_enabled === false)) return `${inquiryType} service is currently unavailable.`;
        if ((availRes.data || []).some((r) => r.admin_enabled === false || r.is_enabled === false)) {
            return 'This Partner does not currently offer this service.';
        }

        const productIds = Array.from(new Set((items || []).map((it) => it.product_id).filter(Boolean)));
        if (productIds.length > 0) {
            const { data: assigned, error: assignedErr } = await supabase
                .from('partner_products').select('product_id').eq('partner_id', partnerId).in('product_id', productIds);
            if (assignedErr) throw new Error(`Unable to check partner eligibility: ${assignedErr.message}`);
            const assignedSet = new Set((assigned || []).map((r) => String(r.product_id)));
            if (productIds.some((id) => !assignedSet.has(String(id)))) return 'This Partner does not carry the requested product.';
        }
        return null;
    }
}

const CUSTOMER_INQUIRY_TYPES = ['Validation', 'Refill', 'New Unit', 'Maintenance'];
// Storage path (bucket photo-references) for the optional PDF a customer attaches.
const CUSTOMER_DOCUMENT_PREFIX = 'customer-documents/';
const SUBTYPES = ['new', 'followup', 'license-renewal'];
// Same labels as frontend/src/utils/productPartnerEligibility.js (SUBTYPE_DISPLAY_LABELS)
// and backend/routes/admin.js assign-partner — keep in sync.
const SUBTYPE_LABELS = {
    Validation: { new: 'New Validation', followup: 'Follow-up', 'license-renewal': 'License Renewal' },
    Refill: { new: 'New Refill', followup: 'Follow-up', 'license-renewal': 'License Renewal' },
};

/**
 * Admins who receive General Inquiry / customer-request notifications: those opted in
 * (admins.receives_general_inquiries), or every admin when nobody is. Uses the
 * get_general_inquiry_recipient_ids RPC; if that fails (e.g. the live DB still has the
 * BIGINT version that migration 20260924100000_fix_general_inquiry_recipients_rpc_type.sql
 * replaces — "structure of query does not match function result type"), the same rule is
 * applied with a direct read here, server-side, so Admin is never left un-notified.
 */
async function getGeneralInquiryRecipients() {
    const { data, error } = await supabase.rpc('get_general_inquiry_recipient_ids');
    if (!error) return data || [];
    console.warn('[InquiryService] get_general_inquiry_recipient_ids failed, using direct admins lookup:', error.message);
    const { data: admins, error: adminsErr } = await supabase.from('admins').select('id, receives_general_inquiries');
    if (adminsErr) {
        console.error('[InquiryService] admins lookup failed:', adminsErr.message);
        return [];
    }
    const optedIn = (admins || []).filter((a) => a.receives_general_inquiries === true);
    return (optedIn.length > 0 ? optedIn : admins || []).map((a) => ({ id: a.id }));
}

/**
 * Runs a Supabase query builder factory, retrying once when the failure is at the
 * network level (no Postgres/PostgREST error code — e.g. "fetch failed", a reset
 * socket) rather than a real query error. Resolves to the usual { data, error }.
 */
async function withTransientRetry(makeQuery) {
    const isTransient = (res) => {
        const err = res?.error;
        if (!err) return false;
        const text = `${err.message || ''} ${err.details || ''}`;
        return !err.code || /fetch failed|ECONNRESET|ETIMEDOUT|socket|network|timeout/i.test(text);
    };
    let res;
    try {
        res = await makeQuery();
    } catch (thrown) {
        res = { data: null, error: thrown };
    }
    if (!isTransient(res)) return res;
    console.warn('[InquiryService] transient Supabase error, retrying once:', res.error?.message || res.error);
    await new Promise((r) => setTimeout(r, 300));
    try {
        return await makeQuery();
    } catch (thrown) {
        return { data: null, error: thrown };
    }
}

function isMissingColumnError(err) {
    const text = `${err?.code || ''} ${err?.message || ''} ${err?.details || ''}`;
    return /PGRST204|42703|column|schema cache/i.test(text);
}

module.exports = new InquiryService();
module.exports.CUSTOMER_DOCUMENT_PREFIX = CUSTOMER_DOCUMENT_PREFIX;
