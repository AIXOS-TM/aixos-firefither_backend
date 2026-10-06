const supabase = require('../supabase');

/**
 * Inquiry event log — one row per action in public.inquiry_events (see
 * frontend/supabase/migrations/20260929100000_inquiry_events.sql).
 *
 * The 'created' event is written by a DB trigger on inquiries INSERT (covers the
 * Agent flow's browser-side insert too), so callers must NOT record it here.
 *
 * Event types written by the backend:
 *   partner_assigned, status_changed,
 *   delivery_proposed, delivery_assigned_to_agent, items_accepted,
 *   delivery_confirmed, delivery_rejected,
 *   visit_scheduled, visit_approved, visit_rejected,
 *   quotation_sent, quotation_approved, quotation_rejected,
 *   quotation_updated (any other quotation status — PATCH /quotations/:id doesn't
 *   restrict status values yet; see audit task Q2)
 * from_status/to_status are set when the action changed inquiries.status.
 *
 * Best-effort: never throws, so a logging failure can't fail the main request.
 */
async function recordInquiryEvent({ inquiryId, eventType, fromStatus = null, toStatus = null, actor = null, metadata = {} }) {
    if (!inquiryId || !eventType) return;
    try {
        const { error } = await supabase.from('inquiry_events').insert({
            inquiry_id: inquiryId,
            event_type: eventType,
            from_status: fromStatus ?? null,
            to_status: toStatus ?? null,
            actor_id: actor?.id != null ? String(actor.id) : null,
            actor_role: actor?.role || null,
            metadata: metadata || {},
        });
        if (error) console.error(`[inquiryEvents] ${eventType} insert failed for inquiry ${inquiryId}:`, error.message);
    } catch (err) {
        console.error(`[inquiryEvents] ${eventType} insert threw for inquiry ${inquiryId}:`, err?.message || err);
    }
}

module.exports = { recordInquiryEvent };
