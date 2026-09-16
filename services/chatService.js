const supabase = require('../supabase');
const { isRenewalOnlyInquiry } = require('./renewalHelpers');

const chatService = {
    /**
     * Partner Chat Management — resolves whether a Partner is allowed to message
     * (or read messages with) `otherPartyId` on a given inquiry, per the
     * Admin-controlled partner_chat_settings table. Scoped to exactly three
     * services (Maintenance, New Unit, License Renewal); every other inquiry type
     * (Validation/Refill non-renewal, or an unrecognized inquiry) is untouched —
     * `{ allowed: true }` with no lookup needed. `targetRole` is derived from the
     * inquiry's own agent_id/customer_id, not from anything the client claims.
     */
    async resolvePartnerChatPermission(inquiryId, partnerId, otherPartyId) {
        if (!inquiryId || !partnerId || !otherPartyId) return { allowed: true };

        const { data: inquiry, error: inquiryErr } = await supabase
            .from('inquiries')
            .select('type, partner_id, agent_id, customer_id')
            .eq('id', inquiryId)
            .maybeSingle();

        if (inquiryErr) {
            console.error('[chatService] resolvePartnerChatPermission inquiry lookup error:', inquiryErr);
            return { allowed: true }; // fail open — never block on an infra error
        }
        if (!inquiry) return { allowed: true };

        if (String(inquiry.partner_id) !== String(partnerId)) {
            return { allowed: false, reason: 'You are not the assigned partner for this inquiry.' };
        }

        let service = null;
        if (inquiry.type === 'Maintenance') service = 'Maintenance';
        else if (inquiry.type === 'New Unit') service = 'New Unit';
        else if (['Validation', 'Refill'].includes(inquiry.type) && await isRenewalOnlyInquiry(supabase, inquiryId)) {
            service = 'License Renewal';
        }
        if (!service) return { allowed: true }; // out of scope for this feature

        const targetRole = String(otherPartyId) === String(inquiry.agent_id)
            ? 'agent'
            : String(otherPartyId) === String(inquiry.customer_id)
                ? 'customer'
                : null;
        if (!targetRole) return { allowed: true }; // can't identify counterpart — don't block

        const { data: settings, error: settingsErr } = await supabase
            .from('partner_chat_settings')
            .select('chat_with_agent, chat_with_customer')
            .eq('partner_id', partnerId)
            .eq('service', service)
            .maybeSingle();

        if (settingsErr) {
            console.error('[chatService] resolvePartnerChatPermission settings lookup error:', settingsErr);
            return { allowed: true };
        }

        const flag = targetRole === 'agent'
            ? (settings ? settings.chat_with_agent : true)
            : (settings ? settings.chat_with_customer : true);

        return flag
            ? { allowed: true }
            : { allowed: false, reason: `Chat with ${targetRole === 'agent' ? 'Agent' : 'Customer'} is currently disabled for ${service}.` };
    },

    /**
     * Fetch chat history for a specific extinguisher
     * Parent changed from 'query' to 'extinguisher' per database schema requirements.
     */
    getMessagesByExtinguisherId: async (extinguisherId) => {
        const { data, error } = await supabase
            .from('messages')
            .select('*')
            .eq('extinguisher_id', extinguisherId)
            .order('created_at', { ascending: true });

        if (error) throw error;
        return data;
    },

    /**
     * Insert a new message into an extinguisher chat
     */
    createMessage: async (messageData) => {
        const { data, error } = await supabase
            .from('messages')
            .insert([messageData])
            .select()
            .single();

        if (error) throw error;
        return data;
    },

    /**
     * Fetch extinguisher details for validation and authorization
     */
    getExtinguisherById: async (id) => {
        const { data, error } = await supabase
            .from('extinguishers')
            .select('*')
            .eq('id', id)
            .single();

        if (error) throw error;
        return data;
    },

    /**
     * Check if a user is authorized to participate in this extinguisher chat
     * Authorization is based on the customer_id linked to the extinguisher.
     */
    isUserParticipant: async (extinguisherId, userId, role) => {
        const { data, error } = await supabase
            .from('extinguishers')
            .select('customer_id, partner_id')
            .eq('id', extinguisherId)
            .single();

        if (error || !data) return false;

        if (role === 'customer') {
            // Customer can only chat about their own extinguishers
            return data.customer_id === userId;
        } else if (role === 'partner') {
            // Partner can chat if the extinguisher is naturally assigned to them
            if (data.partner_id === userId) return true;

            // Partner can also chat if they have an active inquiry involving this extinguisher
            const { data: inquiryData, error: inqErr } = await supabase
                .from('inquiry_items')
                .select('inquiry_id, inquiries!inner(partner_id)')
                .eq('extinguisher_id', extinguisherId)
                .eq('inquiries.partner_id', userId)
                .limit(1);

            return !inqErr && inquiryData && inquiryData.length > 0;
        } else if (role === 'agent' || role === 'admin') {
            // Agents and Admins can chat about any extinguisher
            return true;
        }

        return false;
    },

    /**
     * Fetch customer header info (for Agent ↔ Customer chat UI)
     */
    getCustomerHeaderInfo: async (customerId) => {
        const { data, error } = await supabase
            .from('customers')
            .select('id, business_name, owner_name, status, profile_photo')
            .eq('id', customerId)
            .single();

        if (error) throw error;
        return data;
    },

    /**
     * Fetch partner header info (for Agent ↔ Partner chat UI)
     */
    getPartnerHeaderInfo: async (partnerId) => {
        const { data, error } = await supabase
            .from('partners')
            .select('id, business_name, owner_name, status')
            .eq('id', partnerId)
            .single();

        if (error) throw error;
        return data;
    },

    /**
     * Create a general direct message
     */
    createDirectMessage: async (payload) => {
        const { data, error } = await supabase
            .from('messages')
            .insert([payload])
            .select()
            .single();

        if (error) throw error;
        
        console.log("Message inserted:", data);

        // Automatically create a notification for the receiver
        try {
            const notificationPayload = {
                sender_id: String(data.sender_id),
                sender_role: data.sender_type,
                recipient_id: String(data.receiver_id),
                recipient_role: data.receiver_role || (data.sender_type === 'partner' ? 'customer' : 'partner'),
                message: data.content,
                inquiry_id: data.inquiry_id,
                type: 'message',
                title: `New message from ${data.sender_type.charAt(0).toUpperCase() + data.sender_type.slice(1)}`,
                is_read: false
            };

            const { data: notifData, error: notifError } = await supabase
                .from('notifications')
                .insert([notificationPayload])
                .select()
                .single();

            if (notifError) {
                console.error('[chatService.createDirectMessage] Notification Error:', notifError);
            } else {
                console.log("Notification created:", notifData);
            }
        } catch (nErr) {
            console.error('[chatService.createDirectMessage] Notification Exception:', nErr);
        }

        // Map content back to message for API response transparency
        return {
            ...data,
            message: data.content
        };
    },

    /**
     * Fetch all messages between sender & receiver
     */
    getDirectMessages: async (senderId, receiverId, inquiryId = null) => {
        let query = supabase
            .from('messages')
            .select('*')
            // Get messages where these two are participants
            .or(`and(sender_id.eq.${senderId},receiver_id.eq.${receiverId}),and(sender_id.eq.${receiverId},receiver_id.eq.${senderId})`)
            .order('created_at', { ascending: true });

        if (inquiryId) {
            query = query.eq('inquiry_id', inquiryId);
        }

        const { data, error } = await query;
        if (error) throw error;

        return data.map(msg => ({
            ...msg,
            message: msg.content
        }));
    },

    /**
     * Update message status
     */
    updateMessageStatus: async (messageId, status) => {
        // NOTE: the `messages` table has no `updated_at` column — writing it here
        // was failing every call with PGRST204 (harmless before, but the chat
        // polling now retries it constantly).
        const { data, error } = await supabase
            .from('messages')
            .update({ status })
            .eq('id', messageId)
            .select()
            .single();

        if (error) throw error;
        
        return {
            ...data,
            message: data.content
        };
    }
};

module.exports = chatService;
