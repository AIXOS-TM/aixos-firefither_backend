const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const supabase = require('../supabase');
const multer = require('multer');
const path = require('path');
const nodemailer = require('nodemailer');

const SECRET_KEY = process.env.JWT_SECRET || 'super_secret_key_fire_marketplace';

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
  passLength: emailPass.length,
  passFirstChar: emailPass.charAt(0) || '(empty)',
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

transporter.verify((err) => {
  if (err) {
    console.error('[SMTP] Connection verify FAILED:', {
      message: err.message,
      code: err.code,
      response: err.response,
      responseCode: err.responseCode,
    });
  } else {
    console.log('[SMTP] Ready — authenticated as', emailUser);
  }
});
// ────────────────────────────────────────────────────────────────────────────

// Configure Multer Storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: multer.memoryStorage()
});

const uploadProfileImage = async (file, userId) => {
  if (!file) throw new Error("No file provided for upload");
  if (!file.buffer) throw new Error("File buffer is missing");

  const fileExt = file.originalname.split('.').pop();
  const fileName = `${userId}-${Date.now()}.${fileExt}`;
  const filePath = `agents/${fileName}`;

  const { error } = await supabase.storage
    .from('profiles')
    .upload(filePath, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
    });

  if (error) throw error;

  const { data } = supabase.storage
    .from('profiles')
    .getPublicUrl(filePath);

  return data.publicUrl;
};


// REGISTER AGENT
router.post(
  '/register/agent',
  upload.fields([
    { name: 'profile_photo', maxCount: 1 },
    { name: 'residential_letter', maxCount: 1 }
  ]),
  async (req, res) => {
    console.log("REQ FILES:", req.files); // <- debug
    console.log("REQ BODY:", req.body);

    const { name, email, password, phone, territory, terms_accepted } = req.body;
    const emailLower = email.trim().toLowerCase();
    const fullPhone = phone.startsWith('+') ? phone : `+92${phone}`;

    try {
      // 1️⃣ Hash Password
      const hashedPassword = bcrypt.hashSync(password, 8);

      // 2️⃣ Upload profile photo
      let profile_photo_url = null;
      if (req.files?.profile_photo?.[0]) {
        const file = req.files.profile_photo[0];
        const fileExt = file.originalname.split('.').pop();
        const fileName = `${email}-profile-${Date.now()}.${fileExt}`;
        const filePath = `agents/${fileName}`;

        const { data, error: uploadError } = await supabase.storage
          .from('profiles')
          .upload(filePath, file.buffer, {
            contentType: file.mimetype,
            upsert: true,
          });

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage
          .from('profiles')
          .getPublicUrl(filePath);

        profile_photo_url = urlData.publicUrl;
      }

      // 3️⃣ Upload residential letter
      let residential_letter_url = null;
      if (req.files?.residential_letter?.[0]) {
        const file = req.files.residential_letter[0];
        const fileExt = file.originalname.split('.').pop();
        const fileName = `${email}-residential-${Date.now()}.${fileExt}`;
        const filePath = `residential_letters/${fileName}`; // alag bucket folder

        const { data, error: uploadError } = await supabase.storage
          .from('residential_letters') // Make sure bucket exists
          .upload(filePath, file.buffer, {
            contentType: file.mimetype,
            upsert: true,
          });

        if (uploadError) throw uploadError;

        const { data: urlData } = supabase.storage
          .from('residential_letters')
          .getPublicUrl(filePath);

        residential_letter_url = urlData.publicUrl;
      }

      const { owner_name = 'Unknown', business_name = '', address = '' } = req.body;

      // 4️⃣ Insert into Supabase
      const { data, error } = await supabase
        .from('agents')
        .insert([
          {
            name,
            email: emailLower,
            password: hashedPassword,
            phone: fullPhone,
            territory,
            status: 'pending',
            profile_photo: profile_photo_url,
            residential_letter: residential_letter_url, // New field
            terms_accepted: terms_accepted === 'true',
            owner_name: owner_name || 'Unknown',
            business_name: business_name || '',
            address: address || ''
          }
        ])
        .select();

      if (error) {
        console.error("Supabase Insert Error:", error);
        return res.status(400).json({ error: error.message });
      }

      res.status(201).json({ message: 'Agent registered successfully', user: data[0] });
    } catch (err) {
      console.error("Register Agent Error:", err);
      res.status(500).json({ error: 'Server error during registration' });
    }
  }
);


// REGISTER CUSTOMER
router.post('/register/customer', async (req, res) => {
  const { business_name, owner_name, email, password, phone, address, business_type } = req.body;
  const QRCode = require('qrcode');
  const fs = require('fs');

  const hashedPassword = bcrypt.hashSync(password, 8);

  // Handle Optional Email
  let finalEmail = email;
  if (!finalEmail || finalEmail.trim() === '') {
    finalEmail = `no-email-${Date.now()}-${Math.floor(Math.random() * 1000)}@aixos-placeholder.com`;
  }

  try {
    const { data: customerData, error: customerError } = await supabase
      .from('customers')
      .insert([
        { business_name, owner_name, email: finalEmail.toLowerCase().trim(), password: hashedPassword, phone, address, business_type }
      ])
      .select();

    if (customerError) throw customerError;

    const customerId = customerData[0].id;

    // Generate QR Code
    const qrDir = path.join(__dirname, '../uploads/qrcodes');
    if (!fs.existsSync(qrDir)) {
      fs.mkdirSync(qrDir, { recursive: true });
    }

    const qrContent = JSON.stringify({
      id: customerId,
      type: 'customer',
      name: business_name,
      url: `https://app.aixos.com/customer/${customerId}`
    });

    const qrFileName = `qr-customer-${customerId}-${Date.now()}.png`;
    const qrFilePath = path.join(qrDir, qrFileName);

    await QRCode.toFile(qrFilePath, qrContent, {
      color: {
        dark: '#000000',
        light: '#0000'
      }
    });

    const qrUrl = `/uploads/qrcodes/${qrFileName}`;

    const { error: updateError } = await supabase
      .from('customers')
      .update({ qr_code_url: qrUrl })
      .eq('id', customerId);

    if (updateError) console.error("QR Update Error:", updateError);

    res.status(201).json({ message: 'Customer registered successfully', id: customerId, qr_code_url: qrUrl });
  } catch (err) {
    console.error("Register Error:", err);
    res.status(500).json({ error: 'Error registering customer', details: err.message });
  }
});

// REGISTER PARTNER
router.post('/register/partner', async (req, res) => {
  const { business_name, owner_name, email, password, phone, address } = req.body;

  if (!email || !password || !business_name) {
    return res.status(400).json({ error: 'Business name, email, and password are required' });
  }

  try {
    const hashedPassword = bcrypt.hashSync(password, 8);
    const { data, error } = await supabase
      .from('partners')
      .insert([
        { business_name, owner_name, email: email.toLowerCase().trim(), password: hashedPassword, phone, address, status: 'Active' }
      ])
      .select();

    if (error) {
      if (error.code === '23505') {
        return res.status(400).json({ error: 'Email already exists' });
      }
      throw error;
    }

    res.status(201).json({ message: 'Partner registered successfully', id: data[0].id });
  } catch (err) {
    console.error("Register Partner Error:", err);
    res.status(500).json({ error: 'Error registering partner', details: err.message });
  }
});

// LOGIN (Generic)
router.post('/login', async (req, res) => {
  const { email, password, role } = req.body;

  console.log('Backend req.body:', req.body);

  if (!email || !password || !role) {
    return res.status(400).json({ error: 'Email, password and role are required' });
  }

  const emailLower = email.trim().toLowerCase();

  let table = '';
  if (role === 'agent') table = 'agents';
  else if (role === 'customer') table = 'customers';
  else if (role === 'admin') table = 'admins';
  else if (role === 'partner') table = 'partners';
  else return res.status(400).json({ error: 'Invalid role' });

  try {
    const { data: user, error } = await supabase
      .from(table)
      .select('*')
      .eq('email', emailLower)
      .single();

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const passwordIsValid =
      role === 'admin'
        ? password === user.password // plain text compare
        : bcrypt.compareSync(password, user.password);

    if (!passwordIsValid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }


    if (role === 'agent') {
      const s = (user.status || '').toLowerCase();
      if (s !== 'accepted' && s !== 'active') {
        return res.status(403).json({ error: 'Account pending approval' });
      }
    }

    const token = jwt.sign({ id: user.id, role }, SECRET_KEY, { expiresIn: '24h' });

    res.status(200).json({ auth: true, token, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});


// FORGOT PASSWORD - SEND OTP
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    // Use Supabase Auth to send the reset password email/OTP
    const { error } = await supabase.auth.resetPasswordForEmail(email);

    if (error) throw error;

    res.status(200).json({ message: 'OTP sent to your email.' });
  } catch (err) {
    console.error('Supabase Forgot Password Error:', err);
    res.status(500).json({ error: 'Error processing forgot password request', details: err.message });
  }
});

// SEND CUSTOMER SETUP EMAIL — token is a signed JWT (no extra DB columns needed)
router.post('/send-setup-email', async (req, res) => {
  const { customerId, email, businessName } = req.body;

  console.log('[send-setup-email] Request received:', { customerId, email, businessName });

  if (!customerId || !email) {
    console.warn('[send-setup-email] Missing fields:', { customerId, email });
    return res.status(400).json({ error: 'customerId and email are required' });
  }

  // Skip auto-generated placeholder emails
  if (email.includes('@aixos-placeholder.com') || email.includes('@temp.com')) {
    console.log('[send-setup-email] Skipped placeholder email:', email);
    return res.status(200).json({ message: 'Skipped placeholder email' });
  }

  try {
    // Sign a JWT containing the customer ID — expires in 1 hour
    const setupToken = jwt.sign(
      { sub: String(customerId), type: 'customer_setup' },
      SECRET_KEY,
      { expiresIn: '1h' }
    );

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const setupLink = `${frontendUrl}/set-password?token=${setupToken}`;

    console.log('[send-setup-email] Setup link generated:', setupLink);
    console.log('[send-setup-email] Sending via SMTP:', {
      from: emailUser,
      to: email,
      host: smtpHost,
      port: emailPort,
    });

    const info = await transporter.sendMail({
      from: `"AIXOS Firefighter" <${emailUser}>`,
      to: email,
      subject: 'Set Your AIXOS Account Password',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:auto">
          <h2 style="color:#ef4444">Welcome to AIXOS Firefighter!</h2>
          <p>Hi <strong>${businessName || 'Customer'}</strong>,</p>
          <p>Your account has been created by an agent. Please set your password to activate your account.</p>
          <p style="margin:24px 0">
            <a href="${setupLink}" style="background:#ef4444;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:bold">Set Password</a>
          </p>
          <p style="color:#666;font-size:13px">This link expires in <strong>1 hour</strong>. If you did not request this, please ignore this email.</p>
        </div>
      `,
    });

    console.log('[send-setup-email] sendMail result:', {
      messageId: info.messageId,
      accepted:  info.accepted,
      rejected:  info.rejected,
      response:  info.response,
      envelope:  info.envelope,
    });

    if (info.rejected && info.rejected.length > 0) {
      console.warn('[send-setup-email] Recipient rejected by server:', info.rejected);
      return res.status(500).json({ error: 'Email address was rejected by mail server', rejected: info.rejected });
    }

    console.log('[send-setup-email] SUCCESS — email accepted for:', info.accepted);
    res.status(200).json({ message: 'Setup email sent successfully', messageId: info.messageId, accepted: info.accepted });
  } catch (err) {
    console.error('[send-setup-email] FAILED:', {
      message: err.message,
      code: err.code,
      response: err.response,
      responseCode: err.responseCode,
      command: err.command,
    });
    res.status(500).json({ error: 'Failed to send setup email', details: err.message });
  }
});

// SET PASSWORD via JWT setup token (no extra DB columns required)
router.post('/set-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    let payload;
    try {
      payload = jwt.verify(token, SECRET_KEY);
    } catch {
      return res.status(400).json({ error: 'Invalid or expired link. Please contact support.' });
    }

    if (payload.type !== 'customer_setup' || !payload.sub) {
      return res.status(400).json({ error: 'Invalid setup token.' });
    }

    const customerId = payload.sub;
    const hashedPassword = bcrypt.hashSync(password, 8);

    const { error: updateError } = await supabase
      .from('customers')
      .update({ password: hashedPassword })
      .eq('id', customerId);

    if (updateError) throw updateError;

    res.status(200).json({ message: 'Password set successfully. You can now log in.' });
  } catch (err) {
    console.error('Set password error:', err);
    res.status(500).json({ error: 'Failed to set password', details: err.message });
  }
});

// VERIFY OTP & RESET PASSWORD
router.post('/reset-password', async (req, res) => {
  const { email, otp, newPassword, role } = req.body;

  let table = '';
  if (role === 'agent') table = 'agents';
  else if (role === 'customer') table = 'customers';
  else if (role === 'admin') table = 'admins';
  else return res.status(400).json({ error: 'Invalid role' });

  try {
    // 1. Verify OTP with Supabase Auth
    const { data, error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: otp,
      type: 'recovery'
    });

    if (verifyError) {
      console.error('OTP Verification Error:', verifyError);
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    // 2. Update Password in custom table
    const hashedPassword = bcrypt.hashSync(newPassword, 8);
    const { error: updateError } = await supabase
      .from(table)
      .update({ password: hashedPassword })
      .eq('email', email);

    if (updateError) throw updateError;

    res.status(200).json({ message: 'Password reset successful.' });
  } catch (err) {
    console.error('Reset Password Error:', err);
    res.status(500).json({ error: 'Error resetting password', details: err.message });
  }
});


// SMTP PROBE — GET /api/auth/test-smtp
// Tests every valid Hostinger/webmail SMTP config in parallel and reports
// which one (if any) authenticates successfully with the current credentials.
router.get('/test-smtp', async (req, res) => {
  const domain = emailUser.split('@')[1] || '';

  // Every configuration Hostinger / cPanel webmail can possibly use
  const configs = [
    { label: 'hostinger-465-ssl',      host: 'smtp.hostinger.com',  port: 465, secure: true  },
    { label: 'hostinger-587-starttls', host: 'smtp.hostinger.com',  port: 587, secure: false },
    { label: 'domain-mail-465-ssl',    host: `mail.${domain}`,      port: 465, secure: true  },
    { label: 'domain-mail-587-tls',    host: `mail.${domain}`,      port: 587, secure: false },
    { label: 'domain-smtp-465-ssl',    host: `smtp.${domain}`,      port: 465, secure: true  },
    { label: 'domain-smtp-587-tls',    host: `smtp.${domain}`,      port: 587, secure: false },
    { label: 'titan-587-starttls',     host: 'smtp.titan.email',    port: 587, secure: false },
  ];

  const probe = (cfg) =>
    new Promise((resolve) => {
      const t = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        auth: { type: 'login', user: emailUser, pass: emailPass },
        tls: { rejectUnauthorized: false },
        connectionTimeout: 8000,
        greetingTimeout: 5000,
        socketTimeout: 8000,
      });
      t.verify((err) => {
        if (err) {
          resolve({
            label: cfg.label,
            ok: false,
            code: err.code,
            responseCode: err.responseCode,
            // keep first 80 chars — enough to see the error type without noise
            message: (err.message || '').slice(0, 80),
          });
        } else {
          resolve({ label: cfg.label, ok: true });
        }
        t.close();
      });
    });

  console.log('[SMTP] Probing', configs.length, 'configs for user:', emailUser);
  const results = await Promise.all(configs.map(probe));

  const working = results.filter((r) => r.ok);
  const summary = working.length
    ? `✅ Working config(s): ${working.map((r) => r.label).join(', ')}`
    : '❌ All configs failed — credentials are wrong or account is locked in Hostinger panel';

  console.log('[SMTP] Probe results:', results);
  console.log('[SMTP]', summary);

  res.json({ user: emailUser, summary, results });
});


// ══════════════════════════════════════════════════════════
// SENIOR AGENT ENDPOINTS
// ══════════════════════════════════════════════════════════

// POST /api/auth/promote-senior-agent
// Admin promotes an agent, assigns a team, and sends activation email.
router.post('/promote-senior-agent', async (req, res) => {
  const { agentId, agentEmail, agentName, assignedAgentIds = [], adminName } = req.body;

  if (!agentId || !agentEmail) {
    return res.status(400).json({ error: 'agentId and agentEmail are required' });
  }
  if (assignedAgentIds.length > 10) {
    return res.status(400).json({ error: 'Maximum 10 team members allowed' });
  }

  try {
    // Build activation token (valid 48 h)
    const activationToken = jwt.sign(
      { sub: String(agentId), type: 'senior_agent_activation' },
      SECRET_KEY,
      { expiresIn: '48h' }
    );
    const tokenExpiresAt = new Date(Date.now() + 48 * 3_600_000).toISOString();

    // Upsert senior_agents record
    const { data: sa, error: saError } = await supabase
      .from('senior_agents')
      .upsert(
        {
          agent_id: agentId,
          activation_token: activationToken,
          token_expires_at: tokenExpiresAt,
          pin_hash: null,
          is_activated: false,
          promoted_by: adminName || 'Admin',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'agent_id' }
      )
      .select()
      .single();

    if (saError) throw saError;

    // Replace team assignments
    await supabase.from('senior_agent_teams').delete().eq('senior_agent_id', sa.id);

    if (assignedAgentIds.length > 0) {
      const rows = assignedAgentIds.slice(0, 10).map((memberId) => ({
        senior_agent_id: sa.id,
        agent_id: Number(memberId),
      }));
      const { error: teamError } = await supabase.from('senior_agent_teams').insert(rows);
      if (teamError) throw teamError;
    }

    // Send activation email
    const frontendUrl    = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
    const activationLink = `${frontendUrl}/senior-agent/activate?token=${activationToken}`;

    // Skip auto-generated placeholder emails (same guard as send-setup-email)
    if (agentEmail.includes('@aixos-placeholder.com') || agentEmail.includes('@temp.com')) {
      console.log('[promote-senior-agent] Skipped placeholder email:', agentEmail);
      return res.status(200).json({ message: 'Senior agent promoted (email skipped — placeholder address)', seniorAgentId: sa.id });
    }

    console.log('[promote-senior-agent] Sending via SMTP:', { from: emailUser, to: agentEmail, host: smtpHost, port: emailPort });

    const info = await transporter.sendMail({
      from: `"AIXOS Firefighter" <${emailUser}>`,
      to: agentEmail,
      subject: 'Congratulations! You Have Been Promoted to Senior Agent',
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:auto;padding:24px">
          <div style="background:#ef4444;border-radius:16px;padding:32px;text-align:center;margin-bottom:24px">
            <h1 style="color:#fff;margin:0;font-size:28px;font-weight:900">Congratulations!</h1>
            <p style="color:#fecaca;margin:8px 0 0;font-size:15px">You have been promoted to Senior Agent</p>
          </div>
          <h2 style="color:#0f172a;font-size:20px;margin-bottom:8px">Hi ${agentName || 'Agent'},</h2>
          <p style="color:#475569;line-height:1.6">
            We are delighted to inform you that you have been <strong>promoted to Senior Agent</strong>
            on the AIXOS Firefighter platform. A team of agents has been assigned to you and you will
            now have access to the <strong>Team Activity</strong> dashboard.
          </p>
          <p style="color:#475569;line-height:1.6;margin-top:12px">
            To activate your Senior Agent account, please click the button below to create your
            secure 6-digit PIN. This link is valid for <strong>48 hours</strong>.
          </p>
          <div style="text-align:center;margin:32px 0">
            <a href="${activationLink}"
               style="background:#ef4444;color:#fff;padding:14px 36px;border-radius:12px;
                      text-decoration:none;display:inline-block;font-weight:900;font-size:16px;
                      box-shadow:0 4px 14px rgba(239,68,68,0.35)">
              Activate Senior Agent Access
            </a>
          </div>
          <p style="color:#94a3b8;font-size:12px;text-align:center">
            If you did not expect this email please contact your administrator.<br/>
            This link expires in 48 hours.
          </p>
        </div>
      `,
    });

    console.log('[promote-senior-agent] sendMail result:', {
      messageId: info.messageId,
      accepted:  info.accepted,
      rejected:  info.rejected,
      response:  info.response,
      envelope:  info.envelope,
    });

    if (info.rejected && info.rejected.length > 0) {
      console.warn('[promote-senior-agent] Recipient rejected by mail server:', info.rejected);
      return res.status(500).json({
        error: 'Email address was rejected by the mail server',
        rejected: info.rejected,
      });
    }

    console.log('[promote-senior-agent] SUCCESS — email accepted for:', info.accepted);
    res.status(200).json({ message: 'Senior agent promoted and activation email sent', seniorAgentId: sa.id, emailAccepted: info.accepted });
  } catch (err) {
    console.error('[promote-senior-agent] Error:', err);
    res.status(500).json({ error: 'Failed to promote senior agent', details: err.message });
  }
});

// GET /api/auth/verify-senior-agent-token?token=xxx
// Returns agent info if the activation token is valid.
router.get('/verify-senior-agent-token', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    let payload;
    try {
      payload = jwt.verify(token, SECRET_KEY);
    } catch {
      return res.status(400).json({ error: 'Invalid or expired activation link.' });
    }

    if (payload.type !== 'senior_agent_activation' || !payload.sub) {
      return res.status(400).json({ error: 'Invalid token type.' });
    }

    // Check DB token still matches (not re-issued)
    const { data: sa } = await supabase
      .from('senior_agents')
      .select('id, is_activated, agent_id, activation_token')
      .eq('agent_id', payload.sub)
      .maybeSingle();

    if (!sa) return res.status(404).json({ error: 'Senior agent record not found.' });
    if (sa.activation_token !== token) return res.status(400).json({ error: 'Activation link has been superseded.' });

    // Fetch agent name
    const { data: agent } = await supabase
      .from('agents')
      .select('name, email')
      .eq('id', payload.sub)
      .maybeSingle();

    res.json({
      valid: true,
      agentId: payload.sub,
      agentName: agent?.name || '',
      agentEmail: agent?.email || '',
      alreadyActivated: sa.is_activated,
    });
  } catch (err) {
    console.error('[verify-senior-agent-token] Error:', err);
    res.status(500).json({ error: 'Verification failed', details: err.message });
  }
});

// POST /api/auth/set-senior-agent-pin
// Called from the activation page; hashes and saves the PIN.
router.post('/set-senior-agent-pin', async (req, res) => {
  const { token, pin } = req.body;
  if (!token || !pin) return res.status(400).json({ error: 'token and pin are required' });
  if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 6 digits' });

  try {
    let payload;
    try {
      payload = jwt.verify(token, SECRET_KEY);
    } catch {
      return res.status(400).json({ error: 'Invalid or expired activation link.' });
    }

    if (payload.type !== 'senior_agent_activation') {
      return res.status(400).json({ error: 'Invalid token type.' });
    }

    const pinHash = bcrypt.hashSync(pin, 10);

    const { error } = await supabase
      .from('senior_agents')
      .update({
        pin_hash: pinHash,
        is_activated: true,
        activation_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq('agent_id', payload.sub);

    if (error) throw error;

    res.json({ message: 'PIN set successfully. You can now log in and access Team Activity.' });
  } catch (err) {
    console.error('[set-senior-agent-pin] Error:', err);
    res.status(500).json({ error: 'Failed to set PIN', details: err.message });
  }
});

// POST /api/auth/verify-senior-agent-pin
// Verifies the PIN entered on the Team Activity screen.
router.post('/verify-senior-agent-pin', async (req, res) => {
  const { agentId, pin } = req.body;
  if (!agentId || !pin) return res.status(400).json({ error: 'agentId and pin are required' });

  try {
    const { data: sa } = await supabase
      .from('senior_agents')
      .select('pin_hash, is_activated')
      .eq('agent_id', agentId)
      .maybeSingle();

    if (!sa || !sa.is_activated) {
      return res.status(403).json({ success: false, error: 'Senior agent account not activated.' });
    }
    if (!sa.pin_hash) {
      return res.status(403).json({ success: false, error: 'PIN not set.' });
    }

    const match = bcrypt.compareSync(String(pin), sa.pin_hash);
    if (match) {
      return res.json({ success: true });
    }
    return res.status(401).json({ success: false, error: 'Incorrect PIN.' });
  } catch (err) {
    console.error('[verify-senior-agent-pin] Error:', err);
    res.status(500).json({ success: false, error: 'Verification failed', details: err.message });
  }
});

module.exports = router;
