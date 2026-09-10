/**
 * Shared helper for the Renewal flow. A "Renewal inquiry" is a Validation or
 * Refill inquiry where every one of its inquiry_items carries
 * validation_mode = 'license-renewal' — there is no separate `inquiries.type`
 * for it (see frontend/src/pages/agent/VisitForm.jsx and the accompanying
 * migrations). Mixed inquiries (renewal alongside other items) are NOT
 * renewal-only and keep their normal Validation/Refill behavior untouched.
 */
async function isRenewalOnlyInquiry(supabase, inquiryId) {
    if (!inquiryId) return false;
    const { data, error } = await supabase
        .from('inquiry_items')
        .select('validation_mode')
        .eq('inquiry_id', inquiryId);

    if (error) {
        console.error('[renewalHelpers] isRenewalOnlyInquiry lookup error:', error);
        return false;
    }
    if (!data || data.length === 0) return false;
    return data.every((item) => item.validation_mode === 'license-renewal');
}

module.exports = { isRenewalOnlyInquiry };
