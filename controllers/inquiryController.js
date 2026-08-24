const inquiryService = require('../services/inquiryService');

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
            const updated = await inquiryService.updateInquiry(id, updates, partnerId);
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
            const result = await inquiryService.createFullInquiry(inquiryData, items);
            return res.status(201).json({
                success: true,
                data: result,
                error: null
            });
        } catch (error) {
            console.error('[InquiryController] createInquiry error:', error);
            return res.status(500).json({
                success: false,
                data: null,
                error: `Failed to create inquiry: ${error.message}`
            });
        }
    }
}

module.exports = new InquiryController();
