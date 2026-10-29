// Shared SMTP transporter — moved unchanged from routes/auth.js so other routes
// (e.g. Admin Internal Team invitations in routes/admin.js) send through the same
// configuration. Never log the password or any link/token sent by mail.
const nodemailer = require('nodemailer');

// ── SMTP transporter (created once at startup) ──────────────────────────────

// Sanitize env vars before use:
//  - trim() removes leading/trailing whitespace
//  - replace(\r) removes Windows CRLF that dotenv sometimes leaves on the value
//  - replace outer double-quotes in case dotenv didn't strip them (e.g. `"#pass"` → `#pass`)
const smtpHost = (process.env.EMAIL_HOST || 'smtp.hostinger.com').trim().replace(/\r/g, '');
const emailPort = parseInt((process.env.EMAIL_PORT || '465').trim(), 10);
const emailUser = (process.env.EMAIL_USER || '').trim().replace(/\r/g, '');
const emailPass = (process.env.EMAIL_PASS || '')
  .replace(/\r/g, '')           // strip Windows CR
  .replace(/^["']|["']$/g, ''); // strip surrounding quotes dotenv may have left

console.log('[SMTP] Loaded config:', {
  host: smtpHost || '(missing)',
  port: emailPort,
  secure: emailPort === 465,
  user: emailUser || '(missing)',
  passSet: emailPass.length > 0,
  passHasQuotes: /^["']|["']$/.test(process.env.EMAIL_PASS || ''),
  passHasCR: (process.env.EMAIL_PASS || '').includes('\r'),
});

const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: emailPort,
  secure: emailPort === 465,  // true = implicit SSL (465); false = STARTTLS (587)
  auth: {
    type: 'login',            // Hostinger rejects AUTH PLAIN; force AUTH LOGIN
    user: emailUser,
    pass: emailPass,
  },
  tls: {
    rejectUnauthorized: false,
  },
  connectionTimeout: 10000,
  greetingTimeout: 5000,
  socketTimeout: 15000,
});

// Full SMTP error dump — Nodemailer/SMTPConnection errors carry most of the
// useful diagnostic info on non-enumerable/plain properties that
// console.error(err) or JSON.stringify(err) silently drop (errno, syscall,
// address, port, command, stack). Log every field explicitly so production
// logs actually show why a send failed instead of just "[FAILED]".
function logSmtpError(label, err) {
  console.error(`${label}`, {
    message: err.message,
    code: err.code,             // e.g. ETIMEDOUT, ECONNREFUSED, EAUTH, ESOCKET
    errno: err.errno,
    syscall: err.syscall,       // e.g. 'connect'
    address: err.address,       // IP actually dialed (after DNS resolution)
    port: err.port,
    command: err.command,       // last SMTP command sent (e.g. 'CONN', 'AUTH LOGIN')
    response: err.response,     // raw SMTP server response, if any was received
    responseCode: err.responseCode,
    stack: err.stack,
  });
}

// Startup SMTP health check — runs once when this module loads (i.e. on
// server boot), so a broken/blocked SMTP path shows up in the deploy logs
// immediately instead of surfacing later as a user-facing "Failed to send" error.
console.log('[SMTP] Running startup health check against', smtpHost + ':' + emailPort, '...');
transporter.verify((err) => {
  if (err) {
    logSmtpError('[SMTP] Startup verify FAILED — outbound SMTP is not reachable/authenticating:', err);
  } else {
    console.log('[SMTP] Startup verify OK — Ready and authenticated as', emailUser);
  }
});
// ────────────────────────────────────────────────────────────────────────────

// Escape user-controlled text before putting it in an email's HTML.
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const frontendUrl = () => (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');

module.exports = { transporter, logSmtpError, escapeHtml, frontendUrl, smtpHost, emailPort, emailUser, emailPass };
