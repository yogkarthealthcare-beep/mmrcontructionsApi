/**
 * MMR New Feature Routes — server.js mein add karo
 *
 * Features:
 *  1. Email OTP Verification (signup)
 *  2. Admin Password Change
 *  3. Email Config Management (Admin)
 *  4. Registration Toggle (Admin)
 *  5. Login with email-verified check
 */

import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import sql from '../db.js';
import { sendEmail, otpEmailHtml, passwordChangedEmailHtml } from '../emailService.js';

const router = express.Router();

// ── Rate limit helper (simple in-memory) ───────────────────────
const rateLimitMap = new Map();
function rateLimit(key, maxAttempts = 5, windowMs = 15 * 60 * 1000) {
  const now   = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
  entry.count++;
  rateLimitMap.set(key, entry);
  return entry.count > maxAttempts;
}

// ── Auth middleware ────────────────────────────────────────────
function authUser(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ success: false, message: 'Invalid token' }); }
}

function authAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin' && decoded.role !== 'super_admin')
      return res.status(403).json({ success: false, message: 'Admin access required' });
    req.admin = decoded;
    next();
  } catch { res.status(401).json({ success: false, message: 'Invalid token' }); }
}

// ─────────────────────────────────────────────────────────────
//  1. SEND EMAIL OTP (Registration / Verify)
//  POST /api/auth/send-email-otp
// ─────────────────────────────────────────────────────────────
router.post('/auth/send-email-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ success: false, message: 'Valid email required' });

    if (rateLimit(`otp:${email}`, 5))
      return res.status(429).json({ success: false, message: 'Too many requests. 15 minutes baad try karein.' });

    // Check if already verified user with this email
    const [existing] = await sql`
      SELECT is_email_verified FROM users WHERE email = ${email.toLowerCase()}`;
    if (existing?.is_email_verified)
      return res.status(400).json({ success: false, message: 'Email already registered and verified' });

    // Generate 6-digit OTP
    const otp       = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Upsert into email_otps table
    await sql`
      INSERT INTO email_otps (email, otp, expires_at, attempts)
      VALUES (${email.toLowerCase()}, ${otp}, ${expiresAt}, 0)
      ON CONFLICT (email) DO UPDATE
        SET otp = ${otp}, expires_at = ${expiresAt}, attempts = 0, created_at = NOW()`;

    // Send email
    await sendEmail(
      email,
      'MMR Constructions — Email Verification OTP',
      otpEmailHtml(otp, 'Verification')
    );

    res.json({ success: true, message: 'OTP sent to your email' });
  } catch (e) {
    console.error('[send-email-otp]', e);
    res.status(500).json({ success: false, message: 'Email send failed. Try again.' });
  }
});

// ─────────────────────────────────────────────────────────────
//  2. VERIFY EMAIL OTP
//  POST /api/auth/verify-email-otp
// ─────────────────────────────────────────────────────────────
router.post('/auth/verify-email-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp)
      return res.status(400).json({ success: false, message: 'Email aur OTP required hai' });

    const [record] = await sql`
      SELECT * FROM email_otps WHERE email = ${email.toLowerCase()}`;

    if (!record)
      return res.status(400).json({ success: false, message: 'OTP nahi mila. Pehle OTP send karein.' });

    if (record.attempts >= 5)
      return res.status(429).json({ success: false, message: 'Too many attempts. Naya OTP request karein.' });

    if (new Date() > new Date(record.expires_at)) {
      await sql`DELETE FROM email_otps WHERE email = ${email.toLowerCase()}`;
      return res.status(400).json({ success: false, message: 'OTP expire ho gaya. Resend karein.' });
    }

    if (record.otp !== otp.trim()) {
      await sql`UPDATE email_otps SET attempts = attempts + 1 WHERE email = ${email.toLowerCase()}`;
      return res.status(400).json({ success: false, message: 'Galat OTP. Dobara check karein.' });
    }

    // OTP correct — mark as verified in temp store
    await sql`UPDATE email_otps SET verified = TRUE WHERE email = ${email.toLowerCase()}`;

    res.json({ success: true, message: 'Email verified successfully' });
  } catch (e) {
    console.error('[verify-email-otp]', e);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// ─────────────────────────────────────────────────────────────
//  3. RESEND EMAIL OTP
//  POST /api/auth/resend-email-otp
// ─────────────────────────────────────────────────────────────
router.post('/auth/resend-email-otp', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email required' });

    if (rateLimit(`resend:${email}`, 3))
      return res.status(429).json({ success: false, message: 'Bahut zyada requests. Thodi der baad try karein.' });

    const otp       = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await sql`
      INSERT INTO email_otps (email, otp, expires_at, attempts, verified)
      VALUES (${email.toLowerCase()}, ${otp}, ${expiresAt}, 0, FALSE)
      ON CONFLICT (email) DO UPDATE
        SET otp = ${otp}, expires_at = ${expiresAt}, attempts = 0, verified = FALSE, created_at = NOW()`;

    await sendEmail(email, 'MMR Constructions — Email Verification OTP', otpEmailHtml(otp));

    res.json({ success: true, message: 'OTP resent successfully' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Resend failed' });
  }
});

// ─────────────────────────────────────────────────────────────
//  4. REGISTER (with email OTP verification)
//  POST /api/auth/register
// ─────────────────────────────────────────────────────────────
router.post('/auth/register', async (req, res) => {
  try {
    // Check registration toggle
    const [toggle] = await sql`SELECT value FROM app_settings WHERE key = 'registration_enabled'`;
    if (toggle?.value === 'false')
      return res.status(403).json({ success: false, message: 'Registration abhi disabled hai। Admin se contact karein।' });

    const { full_name, email, mobile_no, password, otp_code, user_type, ...rest } = req.body;

    if (!full_name || !email || !password)
      return res.status(400).json({ success: false, message: 'Name, email aur password required hain' });

    // Email OTP verified check
    const [otpRecord] = await sql`
      SELECT verified FROM email_otps WHERE email = ${email.toLowerCase()}`;

    if (!otpRecord?.verified)
      return res.status(400).json({ success: false, message: 'Email verify nahi hui hai। Pehle OTP verify karein।' });

    // Duplicate check
    const [dup] = await sql`SELECT id FROM users WHERE email = ${email.toLowerCase()}`;
    if (dup) return res.status(409).json({ success: false, message: 'Email already registered hai' });

    const password_hash = await bcrypt.hash(password, 12);

    const [newUser] = await sql`
      INSERT INTO users (
        full_name, email, mobile_no, password_hash,
        user_type, is_email_verified, account_status
      ) VALUES (
        ${full_name.trim()}, ${email.toLowerCase()}, ${mobile_no || null},
        ${password_hash}, ${user_type || 'Customer'}, TRUE, 'Pending'
      ) RETURNING id, full_name, email, user_type`;

    // Clean up OTP record
    await sql`DELETE FROM email_otps WHERE email = ${email.toLowerCase()}`;

    res.status(201).json({ success: true, message: 'Registration successful! Admin approval ke baad login kar paenge।', user: newUser });
  } catch (e) {
    console.error('[register]', e);
    res.status(500).json({ success: false, message: 'Registration failed. Try again.' });
  }
});

// ─────────────────────────────────────────────────────────────
//  5. LOGIN (only verified users)
//  POST /api/auth/login
// ─────────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ success: false, message: 'Email aur password required hain' });

    if (rateLimit(`login:${email}`, 5))
      return res.status(429).json({ success: false, message: 'Too many login attempts. 15 min baad try karein.' });

    const [user] = await sql`
      SELECT id, full_name, email, password_hash, is_email_verified, account_status, user_type, role
      FROM users WHERE email = ${email.toLowerCase()}`;

    if (!user)
      return res.status(401).json({ success: false, message: 'Email ya password galat hai' });

    if (!user.is_email_verified)
      return res.status(403).json({ success: false, message: 'Email verify nahi hui hai। Pehle email verify karein।', code: 'EMAIL_NOT_VERIFIED' });

    if (user.account_status === 'Pending')
      return res.status(403).json({ success: false, message: 'Account abhi pending approval mein hai।', code: 'PENDING_APPROVAL' });

    if (user.account_status !== 'Active')
      return res.status(403).json({ success: false, message: 'Account inactive hai। Admin se contact karein।' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ success: false, message: 'Email ya password galat hai' });

    const token = jwt.sign(
      { user_id: user.id, email: user.email, role: user.role || user.user_type },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ success: true, token, user: { id: user.id, full_name: user.full_name, email: user.email, user_type: user.user_type } });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});

// ─────────────────────────────────────────────────────────────
//  6. ADMIN — CHANGE PASSWORD
//  POST /api/admin/change-password
// ─────────────────────────────────────────────────────────────
router.post('/admin/change-password', authAdmin, async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;

    if (!current_password || !new_password || !confirm_password)
      return res.status(400).json({ success: false, message: 'Saare fields required hain' });

    if (new_password.length < 8)
      return res.status(400).json({ success: false, message: 'New password minimum 8 characters ka hona chahiye' });

    if (new_password !== confirm_password)
      return res.status(400).json({ success: false, message: 'New password aur confirm password match nahi kar rahe' });

    const [admin] = await sql`
      SELECT id, name, email, password_hash FROM admins WHERE id = ${req.admin.admin_id}`;

    if (!admin)
      return res.status(404).json({ success: false, message: 'Admin not found' });

    const valid = await bcrypt.compare(current_password, admin.password_hash);
    if (!valid)
      return res.status(400).json({ success: false, message: 'Current password galat hai' });

    if (await bcrypt.compare(new_password, admin.password_hash))
      return res.status(400).json({ success: false, message: 'New password purane password se alag hona chahiye' });

    const newHash = await bcrypt.hash(new_password, 12);
    await sql`UPDATE admins SET password_hash = ${newHash}, updated_at = NOW() WHERE id = ${admin.id}`;

    // Confirmation email
    try {
      await sendEmail(admin.email, 'MMR Admin — Password Changed', passwordChangedEmailHtml(admin.name));
    } catch (e) { console.warn('Password change email send failed:', e.message); }

    res.json({ success: true, message: 'Password successfully change ho gaya' });
  } catch (e) {
    console.error('[change-password]', e);
    res.status(500).json({ success: false, message: 'Password change failed' });
  }
});

// ─────────────────────────────────────────────────────────────
//  7. ADMIN — GET EMAIL CONFIG
//  GET /api/admin/email-config
// ─────────────────────────────────────────────────────────────
router.get('/admin/email-config', authAdmin, async (req, res) => {
  try {
    const rows = await sql`SELECT key, value FROM email_config`;
    const cfg  = {};
    for (const r of rows) cfg[r.key] = r.value;

    // Mask sensitive fields
    if (cfg.brevo_api_key)        cfg.brevo_api_key        = '••••••••' + cfg.brevo_api_key.slice(-4);
    if (cfg.gmail_app_password)   cfg.gmail_app_password   = '••••••••';

    res.json({ success: true, config: cfg });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Config load failed' });
  }
});

// ─────────────────────────────────────────────────────────────
//  8. ADMIN — SAVE EMAIL CONFIG
//  POST /api/admin/email-config
// ─────────────────────────────────────────────────────────────
router.post('/admin/email-config', authAdmin, async (req, res) => {
  try {
    const {
      active_provider, sender_name, sender_email,
      brevo_api_key,
      gmail_email, gmail_app_password, smtp_host, smtp_port,
      smtp_user, smtp_password, smtp_from,
    } = req.body;

    const updates = {
      active_provider: active_provider || 'smtp',
      sender_name:     sender_name     || 'MMR Constructions',
      sender_email:    sender_email    || '',
      gmail_email:     gmail_email     || '',
      smtp_host:       smtp_host       || 'smtp-relay.brevo.com',
      smtp_port:       smtp_port       || '587',
      smtp_user:       smtp_user       || gmail_email || '',
      smtp_from:       smtp_from       || (sender_email ? `"${sender_name || 'MMR Constructions'}" <${sender_email}>` : ''),
    };

    // Encrypt sensitive fields (only if new value given, not masked)
    if (brevo_api_key && !brevo_api_key.startsWith('••'))
      updates.brevo_api_key = brevo_api_key;

    if (gmail_app_password && !gmail_app_password.startsWith('••'))
      updates.gmail_app_password = gmail_app_password;

    if (smtp_password && !smtp_password.startsWith('â€¢â€¢'))
      updates.smtp_password = smtp_password;

    // Upsert all config rows
    for (const [key, value] of Object.entries(updates)) {
      await sql`
        INSERT INTO email_config (key, value) VALUES (${key}, ${value})
        ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()`;
    }

    res.json({ success: true, message: 'Email configuration saved' });
  } catch (e) {
    console.error('[email-config]', e);
    res.status(500).json({ success: false, message: 'Config save failed' });
  }
});

// ─────────────────────────────────────────────────────────────
//  9. ADMIN — TEST EMAIL
//  POST /api/admin/email-config/test
// ─────────────────────────────────────────────────────────────
router.post('/admin/email-config/test', authAdmin, async (req, res) => {
  try {
    const { test_email } = req.body;
    if (!test_email) return res.status(400).json({ success: false, message: 'Test email required' });

    await sendEmail(test_email, 'MMR — Test Email', `
      <div style="font-family:Arial,sans-serif;padding:24px;">
        <h2 style="color:#1a5c3a;">✅ Email Configuration Working!</h2>
        <p>MMR Constructions Admin Panel se test email successfully send hua.</p>
      </div>`);

    res.json({ success: true, message: `Test email sent to ${test_email}` });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Test email failed: ' + e.message });
  }
});

// ─────────────────────────────────────────────────────────────
//  10. ADMIN — REGISTRATION TOGGLE
//  GET  /api/admin/settings/registration
//  POST /api/admin/settings/registration
// ─────────────────────────────────────────────────────────────
router.get('/admin/settings/registration', authAdmin, async (req, res) => {
  try {
    const [row] = await sql`SELECT value FROM app_settings WHERE key = 'registration_enabled'`;
    res.json({ success: true, enabled: row?.value !== 'false' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Failed' });
  }
});

router.post('/admin/settings/registration', authAdmin, async (req, res) => {
  try {
    const { enabled } = req.body;
    const value = enabled ? 'true' : 'false';

    await sql`
      INSERT INTO app_settings (key, value) VALUES ('registration_enabled', ${value})
      ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = NOW()`;

    res.json({ success: true, message: `Registration ${enabled ? 'enable' : 'disable'} ho gaya`, enabled });
  } catch (e) {
    res.status(500).json({ success: false, message: 'Toggle failed' });
  }
});

// Public endpoint — Frontend check kare
router.get('/settings/registration-status', async (req, res) => {
  try {
    const [row] = await sql`SELECT value FROM app_settings WHERE key = 'registration_enabled'`;
    res.json({ success: true, enabled: row?.value !== 'false' });
  } catch (e) {
    res.json({ success: true, enabled: true }); // default open
  }
});

export default router;
