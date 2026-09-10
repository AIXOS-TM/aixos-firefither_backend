const supabase = require('../supabase');

const chatService = {
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
