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

function extractValidHash(hashVal) {
  if (typeof hashVal === 'string') {
    const trimmed = hashVal.trim();
    if (trimmed.startsWith('$2') || trimmed.length >= 20) return trimmed;
    return null;
  }
  if (hashVal && typeof hashVal === 'object') {
    if (Buffer.isBuffer(hashVal)) {
      const str = hashVal.toString('utf8').trim();
      if (str.startsWith('$2') || str.length >= 20) return str;
    }
    if (typeof hashVal.password_hash === 'string') {
      const str = hashVal.password_hash.trim();
      if (str.startsWith('$2') || str.length >= 20) return str;
    }
    if (typeof hashVal.hash === 'string') {
      const str = hashVal.hash.trim();
      if (str.startsWith('$2') || str.length >= 20) return str;
    }
  }
  return null;
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

    if (rateLimit(`otp:${email}`, 50))
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

    if (rateLimit(`resend:${email}`, 30))
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
    if (user_type && !['Customer', 'Associate', 'Investor'].includes(user_type))
      return res.status(400).json({ success: false, message: 'user_type must be Customer, Associate, or Investor' });

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
        user_type, is_email_verified, account_status,
        enrollment_status, is_verified
      ) VALUES (
        ${full_name.trim()}, ${email.toLowerCase()}, ${mobile_no || null},
        ${password_hash}, ${user_type || 'Customer'}, TRUE, 'Pending',
        '0', FALSE
      ) RETURNING id, full_name, email, user_type`;

    // Clean up OTP record
    await sql`DELETE FROM email_otps WHERE email = ${email.toLowerCase()}`;

    res.status(201).json({ success: true, message: 'Registration successful! Admin approval ke baad login kar paenge।', user: newUser });
  } catch (e) {
    console.error('[register]', e);
    res.status(500).json({ success: false, message: 'Registration failed. Try again.' });
  }
});

async function resolveEnrollmentStatus(u, userType) {
  try {
    const rawType = String(userType || u?.user_type || '').toLowerCase();
    if (rawType.includes('team member') || rawType === 'teammember') return 'completed';

    const raw = String(u.enrollment_status || '').toLowerCase();
    if (raw === '0' || raw === 'not_enrolled') return '0';
    if (raw === 'rejected') return 'rejected';

    if (userType === 'Customer') {
      const [sub] = await sql`
        SELECT id, is_final_submitted, application_status FROM customer_enrollment_submissions 
        WHERE user_id = ${u.user_id} 
           OR (mobile_1 IS NOT NULL AND mobile_1 = ${u.mobile_no})
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (sub && sub.is_final_submitted) {
        return 'completed';
      }
      if (sub) {
        return 'submitted';
      }
      return '0';
    } else if (userType === 'Associate') {
      const [sub] = await sql`
        SELECT id, status FROM associate_enrollment 
        WHERE (user_id IS NOT NULL AND user_id = ${u.user_id || 0})
           OR id = ${u.member_id || ''} 
           OR (contact_no_1 IS NOT NULL AND contact_no_1 = ${u.mobile_no})
        ORDER BY (user_id = ${u.user_id || 0}) DESC, created_at DESC
        LIMIT 1
      `;
      if (sub && ['completed', 'approved'].includes(String(sub.status || '').toLowerCase())) {
        return 'completed';
      }
      if (sub && ['rejected'].includes(String(sub.status || '').toLowerCase())) {
        return 'rejected';
      }
      if (sub) {
        return 'submitted';
      }
      return '0';
    } else if (userType === 'Investor') {
      const invId = u.id || u.user_id;
      const [sub] = await sql`
        SELECT id, app_status, is_final_submitted FROM investor_enrollments 
        WHERE investor_id = ${invId} 
           OR (mobile IS NOT NULL AND mobile = ${u.mobile_number || u.mobile_no})
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (sub && ['completed', 'approved'].includes(String(sub.app_status || '').toLowerCase())) {
        return 'completed';
      }
      if (sub && ['rejected'].includes(String(sub.app_status || '').toLowerCase())) {
        return 'rejected';
      }
      if (sub) {
        return 'submitted';
      }
      return '0';
    }
    return raw === 'completed' || raw === 'approved' ? 'completed' : '0';
  } catch (e) {
    console.error('[resolveEnrollmentStatus Error]', e);
    return '0';
  }
}

// ─────────────────────────────────────────────────────────────
//  5. LOGIN (only verified users)
//  POST /api/auth/login
// ─────────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  try {
    const { identifier, email, mobile_no, password } = req.body;
    const loginId = String(identifier || email || mobile_no || '').trim();
    const loginEmail = loginId.includes('@') ? loginId.toLowerCase() : null;
    const loginMobile = loginEmail ? null : String(mobile_no || loginId).replace(/\D/g, '');

    if ((!loginEmail && !loginMobile) || !password)
      return res.status(400).json({ success: false, message: 'Email/phone and password required' });

    if (rateLimit(`login:${loginEmail || loginMobile}`, 5))
      return res.status(429).json({ success: false, message: 'Too many login attempts. 15 min baad try karein.' });

    const [user] = loginEmail
      ? await sql`
          SELECT user_id, full_name, email, mobile_no, password_hash,
                 account_status, user_type, member_id, invitation_code
          FROM users
          WHERE LOWER(email) = ${loginEmail}`
      : await sql`
          SELECT user_id, full_name, email, mobile_no, password_hash,
                 account_status, user_type, member_id, invitation_code
          FROM users
          WHERE RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${loginMobile}`;

    if (!user) {
      const [investor] = loginEmail
        ? await sql`SELECT id, full_name, email, mobile_number, password_hash, status, is_verified FROM investor_users WHERE LOWER(email) = ${loginEmail} AND deleted_at IS NULL LIMIT 1`
        : await sql`SELECT id, full_name, email, mobile_number, password_hash, status, is_verified FROM investor_users WHERE RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${loginMobile} AND deleted_at IS NULL LIMIT 1`;

      if (investor) {
        if (!investor.is_verified || investor.status === "pending_verification") {
          return res.status(403).json({ success: false, message: "Please verify your email address before login." });
        }
        if (investor.status === "inactive" || investor.status === "rejected") {
          return res.status(403).json({ success: false, message: `Account is currently ${investor.status}. Contact support.` });
        }
        const cleanInvestorHash = extractValidHash(investor.password_hash);
        let valid = false;
        if (!cleanInvestorHash) {
          if (String(password).length < 6) {
            return res.status(400).json({ success: false, message: "Password kam se kam 6 characters ka hona chahiye." });
          }
          const newHash = await bcrypt.hash(password, 12);
          await sql`UPDATE investor_users SET password_hash = ${newHash}, updated_at = NOW() WHERE id = ${investor.id}`;
          valid = true;
        } else {
          valid = await bcrypt.compare(password, cleanInvestorHash);
        }
        if (!valid)
          return res.status(401).json({ success: false, message: "Email ya password galat hai" });

        const investorEnrollmentStatus = await resolveEnrollmentStatus(investor, "Investor");

        const payload = {
          id: investor.id,
          user_id: investor.id,
          user_type: "Investor",
          role: "Investor",
          email: investor.email,
          full_name: investor.full_name,
        };

        const secret = process.env.JWT_SECRET;
        if (!secret) throw new Error("JWT_SECRET is not configured");
        const refreshSecret = process.env.JWT_REFRESH_SECRET || secret;
        const token = jwt.sign(payload, secret, { expiresIn: process.env.JWT_EXPIRES_IN || "30d" });
        const refreshToken = jwt.sign(payload, refreshSecret, { expiresIn: "60d" });

        return res.json({
          success: true,
          message: "Investor login successful",
          data: {
            token,
            refresh_token: refreshToken,
            user: {
              id: investor.id,
              user_id: investor.id,
              full_name: investor.full_name,
              user_type: "Investor",
              email: investor.email,
              mobile_no: investor.mobile_number,
              account_status: investor.status,
              email_verified: Boolean(investor.is_verified),
              enrollment_status: investorEnrollmentStatus
            }
          }
        });
      }

      return res.status(401).json({ success: false, message: 'Email ya password galat hai' });
    }

    if (user.account_status === 'Pending')
      return res.status(403).json({ success: false, message: 'Account abhi pending approval mein hai।', code: 'PENDING_APPROVAL' });

    if (!['Active', 'Approved'].includes(String(user.account_status)))
      return res.status(403).json({ success: false, message: 'Account inactive hai। Admin se contact karein।' });

    const cleanHash = extractValidHash(user.password_hash);
    let valid = false;
    if (!cleanHash) {
      if (String(password).length < 6) {
        return res.status(400).json({ success: false, message: 'Password kam se kam 6 characters ka hona chahiye.' });
      }
      const newHash = await bcrypt.hash(password, 12);
      await sql`UPDATE users SET password_hash = ${newHash}, updated_at = NOW() WHERE user_id = ${user.user_id}`;
      valid = true;
    } else {
      valid = await bcrypt.compare(password, cleanHash);
    }
    if (!valid)
      return res.status(401).json({ success: false, message: 'Email ya password galat hai' });

    // Role Resolution & Role Conflict Check (Read-Only; ZERO writes to users or team_members)
    // C1: Strict match only on user_id AND status in ('approved', 'active'). Zero mobile_no / member_id matching.
    const [tm] = await sql`
      SELECT id, team_member_uid, status, associate_id FROM team_members 
      WHERE user_id = ${user.user_id} 
        AND LOWER(status) IN ('approved', 'active')
      LIMIT 1
    `;
    const isTmMembership = Boolean(tm);
    const dbRole = user.user_type || 'Customer';
    const isRoleConflict = isTmMembership && (dbRole === 'Associate' || dbRole === 'Customer');

    if (isRoleConflict) {
      console.log(`[AuthLogin] Role conflict detected for user_id=${user.user_id}: DB user_type='${dbRole}', but user is enrolled in team_members as '${tm?.team_member_uid}'.`);
    }

    // Role resolution mode: default is 'db'.
    const roleResolutionMode = (process.env.ROLE_RESOLUTION_MODE || 'db').toLowerCase().trim();
    let effectiveRole = dbRole;
    if (roleResolutionMode === 'team_membership_wins' && isTmMembership) {
      console.warn(`[AuthLogin] ROLE_RESOLUTION_MODE=team_membership_wins active: overriding token role to 'Team Member'.`);
      effectiveRole = 'Team Member';
    } else if (roleResolutionMode === 'team_membership_if_no_associate_business' && isTmMembership) {
      // (a) Tight membership is already verified via isTmMembership (user_id match AND status approved/active)
      // (b) User's own Associate enrollment is NOT completed
      const rawEnroll = String(user.enrollment_status || '').toLowerCase().trim();
      let hasCompletedAssocEnrollment = ['completed', 'approved', 'verified'].includes(rawEnroll);
      if (!hasCompletedAssocEnrollment) {
        const [assocSub] = await sql`
          SELECT id, status FROM associate_enrollment 
          WHERE (user_id = ${user.user_id} OR id = ${user.member_id || ''})
            AND LOWER(status) IN ('completed', 'approved')
          LIMIT 1
        `.catch(() => [null]);
        if (assocSub) hasCompletedAssocEnrollment = true;
      }

      // (c) User has NO own downline / team / customers (sponsor_user_id, referred_by_user_id, or team_members.associate_id)
      let hasAssociateBusiness = false;
      const [hasDownline] = await sql`
        SELECT 1 FROM users 
        WHERE (sponsor_user_id = ${user.user_id} OR referred_by_user_id = ${user.user_id})
        LIMIT 1
      `.catch(() => [null]);
      if (hasDownline) {
        hasAssociateBusiness = true;
      } else {
        const [hasTeam] = await sql`
          SELECT 1 FROM team_members 
          WHERE associate_id = ${user.user_id}
          LIMIT 1
        `.catch(() => [null]);
        if (hasTeam) hasAssociateBusiness = true;
      }

      if (!hasCompletedAssocEnrollment && !hasAssociateBusiness) {
        console.warn(`[AuthLogin] ROLE_RESOLUTION_MODE=team_membership_if_no_associate_business: user ${user.user_id} has active team membership and no associate business/enrollment. Elevating effective role to 'Team Member'.`);
        effectiveRole = 'Team Member';
      } else {
        console.log(`[AuthLogin] ROLE_RESOLUTION_MODE=team_membership_if_no_associate_business: user ${user.user_id} has associate business or completed enrollment (enrollment=${hasCompletedAssocEnrollment}, business=${hasAssociateBusiness}). Retaining DB role '${dbRole}'.`);
      }
    }

    const isTmEffective = String(effectiveRole).toLowerCase().includes('team member') || String(effectiveRole).toLowerCase().trim() === 'teammember';
    const userEnrollmentStatus = isTmEffective ? 'completed' : await resolveEnrollmentStatus(user, effectiveRole);

    const payload = {
      user_id: user.user_id,
      user_type: effectiveRole,
      role: effectiveRole,
      member_id: user.member_id,
      mobile_no: user.mobile_no,
      email: user.email,
      full_name: user.full_name,
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '30d',
    });
    const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET, {
      expiresIn: '60d',
    });

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        refresh_token: refreshToken,
        role_conflict: isRoleConflict,
        user: {
          user_id: user.user_id,
          full_name: user.full_name,
          email: user.email,
          mobile_no: user.mobile_no,
          user_type: effectiveRole,
          role: effectiveRole,
          member_id: user.member_id,
          invitation_code: user.invitation_code,
          account_status: user.account_status,
          role_conflict: isRoleConflict,
          enrollment_status: userEnrollmentStatus
        },
      },
    });
  } catch (e) {
    console.error('[login]', e);
    res.status(500).json({ success: false, message: e.message || 'Login failed' });
  }
});

// ─────────────────────────────────────────────────────────────
//  6. ADMIN — CHANGE PASSWORD
//  POST /api/admin/change-password
// ─────────────────────────────────────────────────────────────
router.post('/admin/change-password', authAdmin, async (req, res) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    const adminId = req.admin?.admin_id || req.admin?.id;

    if (!adminId)
      return res.status(401).json({ success: false, message: 'Unauthorized admin session' });

    if (!current_password || !new_password || !confirm_password)
      return res.status(400).json({ success: false, message: 'All password fields are required.' });

    if (new_password.length < 6)
      return res.status(400).json({ success: false, message: 'New password must be at least 6 characters long.' });

    if (new_password !== confirm_password)
      return res.status(400).json({ success: false, message: 'New password and confirm password do not match.' });

    const [admin] = await sql`
      SELECT admin_id, full_name, email, password_hash FROM admin_users WHERE admin_id = ${adminId}`;

    if (!admin)
      return res.status(404).json({ success: false, message: 'Admin account not found.' });

    const valid = await bcrypt.compare(current_password, admin.password_hash);
    if (!valid)
      return res.status(400).json({ success: false, message: 'Incorrect current password.' });

    const isSame = await bcrypt.compare(new_password, admin.password_hash);
    if (isSame)
      return res.status(400).json({ success: false, message: 'New password must be different from current password.' });

    const newHash = await bcrypt.hash(new_password, 10);
    await sql`
      UPDATE admin_users
      SET password_hash = ${newHash}, failed_login_attempts = 0, is_locked = false, updated_at = NOW()
      WHERE admin_id = ${admin.admin_id}`;

    // Confirmation email
    try {
      if (admin.email) {
        await sendEmail(admin.email, 'MMR Admin — Password Changed', passwordChangedEmailHtml(admin.full_name || 'Admin'));
      }
    } catch (e) { console.warn('Password change email send failed:', e.message); }

    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (e) {
    console.error('[change-password]', e);
    res.status(500).json({ success: false, message: 'Failed to change password.' });
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
