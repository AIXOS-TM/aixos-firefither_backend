const inquiryService = require('../services/inquiryService');
const supabase = require('../supabase');
const { CUSTOMER_DOCUMENT_PREFIX } = inquiryService;

/**
 * Inquiry Controller
 * Handles requests for inquiries, items, services, and documents.
 */
class InquiryController {
    /**
     * Get all inquiries for the logged-in partner.
     */
    async getInquiries(req, res) {
        const { id: userId, role } = req.user;
        const { status } = req.query;

        if (role !== 'partner' && role !== 'customer') {
            return res.status(403).json({
                success: false,
                data: null,
                error: 'Access denied. Only partners and customers can list inquiries.'
            });
        }

        try {
            const inquiries =
                role === 'partner'
                    ? await inquiryService.getInquiries(userId, status)
                    : await inquiryService.getInquiriesForCustomer(userId, status);
            return res.status(200).json({
                success: true,
                data: inquiries,
                error: null
            });
        } catch (error) {
            console.error('[InquiryController] getInquiries error:', error);
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to fetch inquiries: ${error.message}`
            });
        }
    }

    /**
     * Get a single inquiry by ID.
     */
    async getInquiryById(req, res) {
        const { id } = req.params;
        const { id: userId, role } = req.user;

        if (role !== 'partner' && role !== 'admin' && role !== 'customer') {
            return res.status(403).json({
                success: false,
                data: null,
                error: 'Access denied.'
            });
        }

        try {
            const partnerId = role === 'partner' ? userId : null;
            const customerId = role === 'customer' ? userId : null;
            const inquiry = await inquiryService.getInquiryById(id, partnerId, customerId);

            if (!inquiry) {
                return res.status(404).json({
                    success: false,
                    data: null,
                    error: 'Inquiry not found.'
                });
            }

            return res.status(200).json({
                success: true,
                data: inquiry,
                error: null
            });
        } catch (error) {
            console.error('[InquiryController] getInquiryById error:', error);
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to fetch inquiry details: ${error.message}`
            });
        }
    }

    /**
     * Reference data for the inquiry-create form (partners, service availability,
     * active products, product↔partner assignments).
     */
    async getInquiryFormOptions(req, res) {
        if (!['customer', 'agent', 'admin'].includes(req.user?.role)) {
            return res.status(403).json({ success: false, data: null, error: 'Access denied.' });
        }
        try {
            const data = await inquiryService.getInquiryFormOptions(req.user.role);
            return res.status(200).json({ success: true, data, error: null });
        } catch (error) {
            console.error('[InquiryController] getInquiryFormOptions error:', error);
            return res.status(500).json({ success: false, data: null, error: error.message });
        }
    }

    /**
     * Customer product lookup by CAT# (their own items' catalog_no) or Product# (model_number).
     */
    async lookupProduct(req, res) {
        if (req.user?.role !== 'customer') {
            return res.status(403).json({ success: false, data: null, error: 'Access denied.' });
        }
        const code = String(req.query.code || '').trim();
        if (!code) {
            return res.status(400).json({ success: false, data: null, error: 'Enter a CAT# or Product#.' });
        }
        try {
            const data = await inquiryService.lookupProductByCode(code, req.user.id);
            return res.status(200).json({ success: true, data, error: null });
        } catch (error) {
            console.error('[InquiryController] lookupProduct error:', error);
            return res.status(500).json({ success: false, data: null, error: error.message });
        }
    }

    /**
     * License document for a License Renewal request. Stored in the same bucket/folder
     * the Agent flow uses (photo-references/licenses), uploaded server-side.
     */
    async uploadLicenseDocument(req, res) {
        if (!['customer', 'agent', 'admin'].includes(req.user?.role)) {
            return res.status(403).json({ success: false, data: null, error: 'Access denied.' });
        }
        const file = req.file;
        if (!file || !file.buffer) {
            return res.status(400).json({ success: false, data: null, error: 'No file uploaded.' });
        }
        try {
            const ext = (file.originalname.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
            const filePath = `licenses/license-${req.user.role}-${req.user.id}-${Date.now()}.${ext}`;
            const { error: uploadError } = await supabase.storage
                .from('photo-references')
                .upload(filePath, file.buffer, { contentType: file.mimetype, upsert: false });
            if (uploadError) throw uploadError;
            const { data: urlData } = supabase.storage.from('photo-references').getPublicUrl(filePath);
            return res.status(201).json({ success: true, data: { url: urlData?.publicUrl || null }, error: null });
        } catch (error) {
            console.error('[InquiryController] uploadLicenseDocument error:', error);
            return res.status(500).json({ success: false, data: null, error: `Failed to upload document: ${error.message}` });
        }
    }

    /**
     * Optional PDF a customer attaches to a Validation request. Stored under a path tied
     * to the customer's id, which createCustomerInquiry checks before saving the URL.
     */
    async uploadCustomerDocument(req, res) {
        if (req.user?.role !== 'customer') {
            return res.status(403).json({ success: false, data: null, error: 'Access denied.' });
        }
        const file = req.file;
        if (!file || !file.buffer) {
            return res.status(400).json({ success: false, data: null, error: 'No file uploaded.' });
        }
        // Content check, not just the browser-reported type.
        if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
            return res.status(400).json({ success: false, data: null, error: 'The file is not a valid PDF.' });
        }
        try {
            const filePath = `${CUSTOMER_DOCUMENT_PREFIX}customer-${req.user.id}-${Date.now()}.pdf`;
            const { error: uploadError } = await supabase.storage
                .from('photo-references')
                .upload(filePath, file.buffer, { contentType: 'application/pdf', upsert: false });
            if (uploadError) throw uploadError;
            const { data: urlData } = supabase.storage.from('photo-references').getPublicUrl(filePath);
            return res.status(201).json({
                success: true,
                data: { url: urlData?.publicUrl || null, name: file.originalname },
                error: null
            });
        } catch (error) {
            console.error('[InquiryController] uploadCustomerDocument error:', error);
            return res.status(500).json({ success: false, data: null, error: `Failed to upload document: ${error.message}` });
        }
    }

    /**
     * Event timeline for one inquiry (owning customer, assigned partner, admin).
     */
    async getInquiryEvents(req, res) {
        try {
            const result = await inquiryService.getInquiryEvents(req.params.id, req.user);
            if (!result.ok) {
                return res.status(result.code).json({ success: false, data: null, error: result.message });
            }
            return res.status(200).json({ success: true, data: result.data, error: null });
        } catch (error) {
            console.error('[InquiryController] getInquiryEvents error:', error);
            return res.status(500).json({ success: false, data: null, error: error.message });
        }
    }

    /**
     * Update inquiry details (e.g., status).
     */
    async updateInquiry(req, res) {
        const { id } = req.params;
        const updates = req.body;
        const { id: userId, role } = req.user;

        if (role !== 'partner' && role !== 'admin') {
            return res.status(403).json({
                success: false,
                data: null,
                error: 'Access denied.'
            });
        }

        try {
            const partnerId = role === 'partner' ? userId : null;
            const updated = await inquiryService.updateInquiry(id, updates, partnerId, { id: userId, role });
            if (!updated) {
                return res.status(404).json({
                    success: false,
                    data: null,
                    error: 'Inquiry not found.'
                });
            }

            return res.status(200).json({
                success: true,
                data: updated,
                error: null
            });
        } catch (error) {
            console.error('[InquiryController] updateInquiry error:', error);
            if (error.code === 'INVALID_STATUS_TRANSITION') {
                return res.status(409).json({
                    success: false,
                    data: null,
                    error: error.message
                });
            }
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to update inquiry: ${error.message}`
            });
        }
    }

    /**
     * Add multiple items to an inquiry.
     */
    async addInquiryItems(req, res) {
        const { id } = req.params;
        const { items } = req.body; // Expects array of items

        if (!Array.isArray(items)) {
            return res.status(400).json({
                success: false,
                data: null,
                error: 'Items must be an array.'
            });
        }

        try {
            const addedItems = await inquiryService.addInquiryItems(id, items);
            return res.status(201).json({
                success: true,
                data: addedItems,
                error: null
            });
        } catch (error) {
            console.error('[InquiryController] addInquiryItems error:', error);
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to add items to inquiry: ${error.message}`
            });
        }
    }

    /**
     * Update a specific inquiry item.
     */
    async updateInquiryItem(req, res) {
        const { id } = req.params;
        const updates = req.body;
        const { role } = req.user;

        if (role !== 'partner' && role !== 'admin') {
            return res.status(403).json({
                success: false,
                data: null,
                error: 'Access denied.'
            });
        }

        try {
            const updated = await inquiryService.updateInquiryItem(id, updates);
            if (!updated) {
                return res.status(404).json({
                    success: false,
                    data: null,
                    error: 'Inquiry item not found.'
                });
            }

            return res.status(200).json({
                success: true,
                data: updated,
                error: null
            });
        } catch (error) {
            console.error('[InquiryController] updateInquiryItem error:', error);
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to update inquiry item: ${error.message}`
            });
        }
    }

    /**
     * Add a service to an inquiry item.
     */
    async addItemService(req, res) {
        const { id } = req.params; // inquiry_item_id
        const serviceData = req.body;
        const { role } = req.user;

        if (role !== 'partner' && role !== 'admin') {
            return res.status(403).json({
                success: false,
                data: null,
                error: 'Access denied.'
            });
        }

        try {
            const addedService = await inquiryService.addItemService(id, serviceData);
            return res.status(201).json({
                success: true,
                data: addedService,
                error: null
            });
        } catch (error) {
            console.error('[InquiryController] addItemService error:', error);
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to add service to item: ${error.message}`
            });
        }
    }

    /**
     * Handle inquiry document upload.
     */
    async uploadDocument(req, res) {
        const { inquiry_id, document_type, comments } = req.body;
        const files = req.files;

        if (!files || files.length === 0) {
            return res.status(400).json({
                success: false,
                data: null,
                error: 'No files uploaded.'
            });
        }

        try {
            const results = [];
            for (const file of files) {
                const docData = {
                    inquiry_id,
                    document_type: document_type || 'unspecified',
                    file_url: `/uploads/${file.filename}`,
                    file_name: file.originalname,
                    comments: comments || ''
                };
                const savedDoc = await inquiryService.addInquiryDocument(docData);
                results.push(savedDoc);
            }
            return res.status(201).json({
                success: true,
                data: results,
                error: null
            });
        } catch (error) {
            console.error('[InquiryController] uploadDocument error:', error);
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to upload document: ${error.message}`
            });
        }
    }

    /**
     * Create a new inquiry with items.
     */
    async createInquiry(req, res) {
        const { inquiryData, items } = req.body;

        if (!inquiryData || !items || !Array.isArray(items)) {
            return res.status(400).json({
                success: false,
                data: null,
                error: 'Invalid request. inquiryData and items array are required.'
            });
        }

        try {
            // Customers get their own path (identity from the JWT, Admin-first routing —
            // any partner_id/customer_id in the body is ignored); every other caller keeps
            // the existing behaviour unchanged.
            const result = req.user?.role === 'customer'
                ? await inquiryService.createCustomerInquiry(inquiryData, items, req.user)
                : await inquiryService.createFullInquiry(inquiryData, items, req.user);
            return res.status(201).json({
                success: true,
                data: result,
                error: null
            });
        } catch (error) {
            console.error('[InquiryController] createInquiry error:', error);
            return res.status(error.status || 500).json({
                success: false,
                data: null,
                error: `Failed to create inquiry: ${error.message}`
            });
        }
    }
}

module.exports = new InquiryController();
