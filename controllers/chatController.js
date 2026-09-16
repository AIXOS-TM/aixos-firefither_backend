const chatService = require('../services/chatService');

const chatController = {
    /**
     * GET /api/extinguishers/:id/messages
     */
    getMessages: async (req, res) => {
        const { id: extinguisherId } = req.params;
        const { id: userId, role } = req.user;

        try {
            // 1. Validate participant (check if customer owns the extinguisher or user is staff)
            const isParticipant = await chatService.isUserParticipant(extinguisherId, userId, role);
            if (!isParticipant) {
                return res.status(403).json({ error: 'You are not authorized to view this chat history.' });
            }

            // 2. Fetch messages
            const messages = await chatService.getMessagesByExtinguisherId(extinguisherId);
            res.status(200).json(messages);
        } catch (err) {
            console.error('Error fetching messages:', err);
            res.status(500).json({ error: 'Failed to fetch chat history.' });
        }
    },

    /**
     * POST /api/extinguishers/:id/messages
     * Unified API for both agents and customers.
     * Sender information is automatically securely derived from the JWT token.
     */
    sendMessage: async (req, res) => {
        const { id: extinguisherId } = req.params;
        const { content } = req.body;

        // Extract sender data from req.user (populated by verifyToken middleware)
        const { id: userId, role: userRole } = req.user;

        if (!content || content.trim() === '') {
            return res.status(400).json({ error: 'Message content is required.' });
        }

        // Validate that the userRole is one we expect
        const validRoles = ['customer', 'agent', 'admin', 'partner'];
        if (!validRoles.includes(userRole)) {
            return res.status(403).json({ error: 'Invalid user role for sending messages.' });
        }

        try {
            // 1. Validate extinguisher exists and user is participant (belongs to them or is staff)
            const isParticipant = await chatService.isUserParticipant(extinguisherId, userId, userRole);
            if (!isParticipant) {
                return res.status(403).json({ error: 'You are not authorized to send messages for this extinguisher.' });
            }

            // 2. Insert message with extinguisher_id and securely derived sender info
            const newMessage = await chatService.createMessage({
                extinguisher_id: extinguisherId,
                sender_id: userId,
                sender_type: userRole, // 'customer', 'agent', 'admin', or 'partner'
                content: content.trim()
            });

            res.status(201).json(newMessage);
        } catch (err) {
            console.error('Error sending message:', err);
            res.status(500).json({ error: 'Failed to send message.' });
        }
    },

    /**
     * GET /api/customers/:customerId/header
     */
    getCustomerHeader: async (req, res) => {
        const { customerId } = req.params;

        try {
            const customerInfo = await chatService.getCustomerHeaderInfo(customerId);
            if (!customerInfo) {
                return res.status(404).json({ error: 'Customer not found.' });
            }
            res.status(200).json(customerInfo);
        } catch (err) {
            console.error('Error fetching customer header:', err);
            res.status(500).json({ error: 'Failed to fetch customer info.' });
        }
    },

    /**
     * GET /api/partners/:partnerId/header
     * Returns partner info for the frontend chat header (Agent ↔ Partner chat UI).
     */
    getPartnerHeader: async (req, res) => {
        const { partnerId } = req.params;

        try {
            const partnerInfo = await chatService.getPartnerHeaderInfo(partnerId);
            if (!partnerInfo) {
                return res.status(404).json({ error: 'Partner not found.' });
            }
            res.status(200).json(partnerInfo);
        } catch (err) {
            console.error('Error fetching partner header:', err);
            res.status(500).json({ error: 'Failed to fetch partner info.' });
        }
    },

    /**
     * POST /api/messages
     */
    sendDirectMessage: async (req, res) => {
        const { sender_id, receiver_id, receiver_role, inquiry_id, message, message_type = 'text' } = req.body;
        
        if (!sender_id || !receiver_id || !message) {
            return res.status(400).json({ success: false, data: null, error: 'sender_id, receiver_id, and message are required.' });
        }

        // Partner Chat Management — a no-op for every role except 'partner' and for
        // any inquiry outside Maintenance/New Unit/License Renewal (see chatService
        // for the full resolution). req.user.id (verified JWT) is used as the
        // partner identity here, never the request body.
        if (req.user.role === 'partner' && inquiry_id) {
            const gate = await chatService.resolvePartnerChatPermission(inquiry_id, req.user.id, receiver_id);
            if (!gate.allowed) {
                return res.status(403).json({ success: false, data: null, error: gate.reason });
            }
        }

        try {
            // Map the unified `message` attribute to the existing DB schema `content` column.
            const newMsg = await chatService.createDirectMessage({
                sender_id: String(sender_id),
                receiver_id: String(receiver_id),
                receiver_role: receiver_role || null, // Will fallback in service if null
                inquiry_id: inquiry_id || null,
                content: message.trim(),
                message_type,
                status: 'sent',
                sender_type: req.user.role // Derive from token
            });

            res.status(201).json({ success: true, data: newMsg, error: null });
        } catch (err) {
            console.error('[sendDirectMessage] Error:', err);
            res.status(500).json({ success: false, data: null, error: err.message || 'Failed to send message.' });
        }
    },

    /**
     * GET /api/messages
     */
    getDirectMessagesHistory: async (req, res) => {
        const { sender_id, receiver_id, inquiry_id } = req.query;

        if (!sender_id || !receiver_id) {
            return res.status(400).json({ success: false, data: null, error: 'sender_id and receiver_id are required in query params.' });
        }

        // Partner Chat Management — same gate as sending, applied to reading history too.
        if (req.user.role === 'partner' && inquiry_id) {
            const otherPartyId = String(sender_id) === String(req.user.id) ? receiver_id : sender_id;
            const gate = await chatService.resolvePartnerChatPermission(inquiry_id, req.user.id, otherPartyId);
            if (!gate.allowed) {
                return res.status(403).json({ success: false, data: null, error: gate.reason });
            }
        }

        try {
            const messages = await chatService.getDirectMessages(sender_id, receiver_id, inquiry_id);
            res.status(200).json({ success: true, data: messages, error: null });
        } catch (err) {
            console.error('[getDirectMessagesHistory] Error:', err);
            res.status(500).json({ success: false, data: null, error: err.message || 'Failed to fetch messages.' });
        }
    },

    /**
     * PATCH /api/messages/status
     */
    updateMessageStatus: async (req, res) => {
        const { message_id, status } = req.body;

        if (!message_id || !status) {
            return res.status(400).json({ success: false, data: null, error: 'message_id and status are required.' });
        }

        if (status !== 'delivered' && status !== 'read') {
            return res.status(400).json({ success: false, data: null, error: 'Status must be "delivered" or "read".' });
        }

        try {
            const updated = await chatService.updateMessageStatus(message_id, status);
            res.status(200).json({ success: true, data: updated, error: null });
        } catch (err) {
            console.error('[updateMessageStatus] Error:', err);
            res.status(500).json({ success: false, data: null, error: err.message || 'Failed to update status.' });
        }
    }
};

module.exports = chatController;
