// Saudi Arabia time (Asia/Riyadh, UTC+3, no daylight saving) labelled "AST" — same rule
// as the frontend (frontend/src/utils/dateTime.js), so times written into messages on the
// server don't depend on the server's own timezone (often UTC when hosted).
const KSA_TIME_ZONE = 'Asia/Riyadh';
const KSA_TIME_LABEL = 'AST';

/** e.g. "Oct 8, 2026, 3:45 PM AST"; '' for an empty or invalid value. */
function formatKsaDateTime(value, options = { dateStyle: 'medium', timeStyle: 'short' }, locale = 'en-US') {
    if (value == null || value === '') return '';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return `${d.toLocaleString(locale, { ...options, timeZone: KSA_TIME_ZONE })} ${KSA_TIME_LABEL}`;
}

module.exports = { KSA_TIME_ZONE, KSA_TIME_LABEL, formatKsaDateTime };
