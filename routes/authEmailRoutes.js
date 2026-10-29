import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import sql from '../db.js';
import { sendEmail, otpEmailHtml } from '../emailService.js';
import twoFactorService from '../services/twoFactor.service.js';
import { bookingApprovalConfig } from '../config/bookingApproval.js';
import { resolveReferralCode } from '../services/referralResolver.service.js';
import { generateTeamMemberId } from '../services/teamMemberService.js';

const router = express.Router();

const ok = (res, data, msg = 'Success', status = 200) =>
  res.status(status).json({ success: true, message: msg, data });

const err = (res, msg = 'Server error', status = 500) =>
  res.status(status).json({ success: false, message: msg });

const genOTP = () => String(Math.floor(100000 + Math.random() * 900000));
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isMobile = (v) => /^[6-9]\d{9}$/.test(v);
const normalizeEmail = (email) => String(email || '').toLowerCase().trim();
const normalizeMobileNo = (mobile) => String(mobile || '').replace(/\D/g, '').slice(-10);
const normalizeSponsorCode = (code) => String(code || '').replace(/\*/g, '').trim().toUpperCase();

const sanitizeBody = (body = {}) => {
  const sanitized = { ...body };
  for (const key of Object.keys(sanitized)) {
    if (/password|token|secret|key/i.test(key)) {
      sanitized[key] = '[REDACTED]';
    }
  }
  return sanitized;
};

const describeFiles = (files) => {
  if (!files) return { files_present: false };

  return Object.entries(files).reduce((acc, [field, value]) => {
    const list = Array.isArray(value) ? value : [value];
    acc[field] = list.map((file) => ({
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    }));
    return acc;
  }, {});
};

const logRegistrationError = (label, error) => {
  console.error(label, {
    message: error?.message,
    code: error?.code,
    detail: error?.detail,
    constraint: error?.constraint,
    table: error?.table,
    column: error?.column,
    stack: error?.stack,
    details: error,
  });
};

const registrationConflictMessage = (error) => {
  const constraint = String(error?.constraint || '').toLowerCase();

  if (constraint.includes('users_email')) return 'Email already registered';
  if (constraint.includes('users_mobile')) return 'Mobile number already registered';
  if (constraint.includes('users_member_id')) {
    return 'Member ID conflict detected. Please try verification again.';
  }
  if (constraint.includes('invitation')) {
    return 'Invitation code conflict detected. Please try verification again.';
  }
  if (constraint.includes('pan')) {
    return 'PAN details can be added after login. Please start registration again.';
  }
  if (constraint.includes('aadhar') || constraint.includes('aadhaar')) {
    return 'Aadhaar details can be added after login. Please start registration again.';
  }
  if (constraint.includes('passport')) {
    return 'Passport details can be added after login. Please start registration again.';
  }
  if (constraint.includes('referral')) {
    return 'Referral registration already exists for this account.';
  }

  return `Registration conflict detected (${error?.constraint || error?.table || 'Unknown'}). Please start registration again.`;
};

let pendingTableReady = false;
let appAuthSettingsReady = false;

async function ensureAppAuthSettingsSchema() {
  if (appAuthSettingsReady) return;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS app_auth_settings (
        id SERIAL PRIMARY KEY,
        email_otp_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        sms_otp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`;
    await sql`ALTER TABLE app_auth_settings ADD COLUMN IF NOT EXISTS sms_otp_enabled BOOLEAN DEFAULT FALSE`;
    await sql`ALTER TABLE app_auth_settings ADD COLUMN IF NOT EXISTS email_otp_enabled BOOLEAN DEFAULT TRUE`;
    const [existing] = await sql`SELECT id FROM app_auth_settings LIMIT 1`;
    if (!existing) {
      await sql`INSERT INTO app_auth_settings (email_otp_enabled, sms_otp_enabled) VALUES (TRUE, FALSE)`;
    }
    appAuthSettingsReady = true;
  } catch (err) {
    console.error('[authEmailRoutes] ensureAppAuthSettingsSchema error:', err.message);
  }
}

async function getAppAuthSettingsRow() {
  try {
    await ensureAppAuthSettingsSchema();
    const [row] = await sql`SELECT * FROM app_auth_settings LIMIT 1`;
    return row || { email_otp_enabled: true, sms_otp_enabled: false };
  } catch (e) {
    console.error('[authEmailRoutes] getAppAuthSettingsRow error:', e);
    return { email_otp_enabled: true, sms_otp_enabled: false };
  }
}

async function ensurePendingRegistrationTable() {
  if (pendingTableReady) return;

  console.log('[Associate Registration] Checking pending_registrations table...');
  await sql`
    CREATE TABLE IF NOT EXISTS pending_registrations (
      email TEXT PRIMARY KEY,
      mobile_no TEXT NOT NULL,
      user_type TEXT NOT NULL,
      full_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      sponsor_user_id INTEGER,
      sponsor_invite_code TEXT,
      optional_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      otp_code TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS optional_data JSONB NOT NULL DEFAULT '{}'::jsonb`;
  await sql`ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS referred_by_user_id INTEGER`;
  await sql`ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS referred_by_source TEXT`;
  await sql`ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS referred_by_set_at TIMESTAMPTZ`;
  await sql`ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS email_otp_code TEXT`;
  await sql`ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS sms_otp_code TEXT`;
  await sql`ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS mobile_verified BOOLEAN DEFAULT FALSE`;
  await sql`ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS email_otp_expires_at TIMESTAMPTZ`;
  await sql`ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS sms_otp_expires_at TIMESTAMPTZ`;
  await sql`ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS email_otp_attempts INTEGER DEFAULT 0`;
  await sql`ALTER TABLE pending_registrations ADD COLUMN IF NOT EXISTS sms_otp_attempts INTEGER DEFAULT 0`;
  ensureRegistrationUniqueIndexes().catch((error) => {
    console.warn('[Associate Registration] Unique index check skipped; existing duplicates may need cleanup.', {
      message: error?.message,
      code: error?.code,
      detail: error?.detail,
      constraint: error?.constraint,
    });
  });

  pendingTableReady = true;
  console.log('[Associate Registration] pending_registrations table ready');
}

async function ensureRegistrationUniqueIndexes() {
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_pending_registrations_mobile_no
    ON pending_registrations (mobile_no)`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_normalized
    ON users (LOWER(email))
    WHERE email IS NOT NULL`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_users_mobile_no_digits
    ON users ((RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10)))
    WHERE mobile_no IS NOT NULL`;
}

async function ensureReferralLinkTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS associate_referral_links (
      id SERIAL PRIMARY KEY,
      associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
      invite_code VARCHAR(80) NOT NULL UNIQUE,
      referral_url TEXT,
      total_clicks INTEGER NOT NULL DEFAULT 0,
      total_registrations INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
}

async function findSponsorByCode(code) {
  const sponsorCode = normalizeSponsorCode(code);
  if (!sponsorCode) return null;

  // Use shared referral resolver
  const resolved = await resolveReferralCode(sql, sponsorCode, { allowDefaultFallback: true });
  if (resolved.valid && resolved.referrer) {
    return {
      user_id: resolved.userId,
      full_name: resolved.fullName,
      member_id: resolved.memberId,
      invitation_code: resolved.invitationCode || resolved.memberId,
      user_type: resolved.userType || resolved.referrer.user_type || 'Associate'
    };
  }

  // Investor fallback for legacy investor sponsor codes
  let numericId = null;
  if (/^\d+$/.test(sponsorCode)) {
    numericId = parseInt(sponsorCode, 10);
  } else if (/^INV-?\d+$/i.test(sponsorCode)) {
    numericId = parseInt(sponsorCode.replace(/^INV-?/i, ''), 10);
  }

  const [invSponsor] = await sql`
    SELECT id as user_id, full_name, mobile_number as member_id, mobile_number as invitation_code, 'Investor' as user_type
    FROM investor_users
    WHERE deleted_at IS NULL
      AND (
        UPPER(mobile_number) = ${sponsorCode}
        OR UPPER(email) = ${sponsorCode}
        ${numericId ? sql`OR id = ${numericId}` : sql`OR FALSE`}
      )
    LIMIT 1
  `.catch(() => []);
  if (invSponsor) {
    return invSponsor;
  }

  // Fallback for default corporate sponsor MMR0001 / MMR-ASC-0001 (Suraj Kumar Verma)
  if (sponsorCode === 'MMR0001' || sponsorCode === 'MMR00001' || sponsorCode === 'MMR3001' || sponsorCode === 'MMR-A-3001' || sponsorCode === 'MMR-C-3001' || sponsorCode === 'MMR-ASC-0001' || sponsorCode === 'MMR-ASC-00001') {
    const [suraj] = await sql`
      SELECT user_id, full_name, member_id, invitation_code, 'Associate' as user_type
      FROM users
      WHERE full_name ILIKE '%Suraj%'
         OR LOWER(email) = 'mmrconstructions@hotmail.com'
         OR user_id = 1
      ORDER BY user_id ASC
      LIMIT 1`.catch(() => []);
    
    if (suraj) {
      return {
        user_id: suraj.user_id,
        full_name: suraj.full_name || 'Suraj Kumar Verma',
        member_id: suraj.invitation_code || suraj.member_id || 'MMR-ASC-0001',
        invitation_code: suraj.invitation_code || 'MMR-ASC-0001',
        user_type: 'Associate'
      };
    }
  }

  return null;
}

router.get('/verify-sponsor/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const targetRole = req.query.role || req.query.user_type || null;
    const sponsor = await findSponsorByCode(code);
    if (!sponsor) {
      return res.status(404).json({
        success: false,
        message: 'Invalid sponsor code. No active associate or team member found with this code.',
      });
    }

    if (targetRole) {
      const sType = String(sponsor.user_type || '').toLowerCase();
      const tRole = String(targetRole).toLowerCase();
      if (sType.includes('team member') && tRole !== 'customer') {
        return res.status(400).json({
          success: false,
          valid: false,
          message: `Team Members can only refer Customers. This referral code cannot be used to register as ${targetRole}.`,
          sponsor_user_type: sponsor.user_type,
          allowed_roles: ['Customer']
        });
      }
    }

    return ok(res, {
      valid: true,
      user_id: sponsor.user_id,
      full_name: sponsor.full_name,
      member_id: sponsor.member_id,
      invitation_code: sponsor.invitation_code || sponsor.member_id,
      user_type: sponsor.user_type || 'Associate',
    }, 'Sponsor found');
  } catch (e) {
    console.error('[verify-sponsor]', e);
    return err(res, e.message || 'Failed to verify sponsor code');
  }
});

router.get('/referral/validate/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const sponsor = await findSponsorByCode(code);
    if (!sponsor) {
      return res.status(404).json({
        success: false,
        message: 'Invalid referral/sponsor code.',
      });
    }
    return ok(res, {
      valid: true,
      user_id: sponsor.user_id,
      full_name: sponsor.full_name,
      member_id: sponsor.member_id,
      invitation_code: sponsor.invitation_code || sponsor.member_id,
      user_type: sponsor.user_type || 'Associate',
    }, 'Referral code valid');
  } catch (e) {
    console.error('[referral/validate]', e);
    return err(res, e.message || 'Failed to validate referral code');
  }
});

async function canResend(email) {
  await ensurePendingRegistrationTable();

  const [last] = await sql`
    SELECT updated_at FROM pending_registrations
    WHERE email = ${normalizeEmail(email)}`;

  if (!last) return true;
  return (Date.now() - new Date(last.updated_at).getTime()) > 180_000; // 3 minutes cooldown
}

async function createUserWithUniqueMemberId(db, pending) {
  await db`SELECT pg_advisory_xact_lock(hashtext('users_member_id_registration'))`;
  const normType = String(pending.user_type || '').toLowerCase();
  let memberId;
  if (normType.includes('team')) {
    memberId = await generateTeamMemberId(db);
  } else {
    const isAssociate = normType === 'associate';
    const prefix = isAssociate ? 'MMR-ASC-' : 'MMR-CUS-';
    const [sequence] = isAssociate ? await db`
      SELECT COALESCE(MAX(
        CASE
          WHEN member_id ~* '^MMR-ASC-[0-9]+$' THEN SUBSTRING(member_id FROM 9)::integer
          WHEN member_id ~* '^MMR-A-[0-9]+$' THEN SUBSTRING(member_id FROM 7)::integer
          WHEN member_id ~* '^MMR[0-9]+$' AND LOWER(user_type::TEXT) = 'associate' THEN SUBSTRING(member_id FROM 4)::integer
          ELSE 0 END
      ), 0) + 1 AS next_value
      FROM users` : await db`
      SELECT COALESCE(MAX(
        CASE
          WHEN member_id ~* '^MMR-CUS-[0-9]+$' THEN SUBSTRING(member_id FROM 9)::integer
          WHEN member_id ~* '^MMR-C-[0-9]+$' THEN SUBSTRING(member_id FROM 7)::integer
          WHEN member_id ~* '^MMR[0-9]+$' AND LOWER(user_type::TEXT) = 'customer' THEN SUBSTRING(member_id FROM 4)::integer
          ELSE 0 END
      ), 0) + 1 AS next_value
      FROM users`;
    memberId = `${prefix}${String(Number(sequence?.next_value || 1)).padStart(5, '0')}`;
  }
  let created;
  const referredByUserId = pending.referred_by_user_id !== undefined ? pending.referred_by_user_id : (pending.sponsor_user_id || null);
  const referredBySource = pending.referred_by_source !== undefined ? pending.referred_by_source : (referredByUserId ? 'REGISTRATION_CODE' : 'DIRECT_SIGNUP');
  const referredBySetAt = pending.referred_by_set_at || (referredByUserId ? new Date() : null);

  const initialAccountStatus = pending.user_type === 'Customer' ? 'Active' : (normType.includes('team') ? 'Active' : 'Pending');

  try {
    [created] = await db`
      INSERT INTO users (
        user_type, full_name, mobile_no, email,
        password_hash, sponsor_user_id, member_id,
        account_status, email_verified, email_verified_at, is_otp_verified,
        referred_by_user_id, referred_by_source, referred_by_set_at,
        enrollment_status, is_verified
      ) VALUES (
        ${pending.user_type}, ${pending.full_name}, ${pending.mobile_no}, ${pending.email},
        ${pending.password_hash}, ${pending.sponsor_user_id || null}, ${memberId},
        ${initialAccountStatus}, TRUE, NOW(), TRUE,
        ${referredByUserId}, ${referredBySource}, ${referredBySetAt},
        '0', FALSE
      )
      RETURNING user_id, full_name, email, mobile_no, user_type, member_id, invitation_code, referred_by_user_id, referred_by_source`;
  } catch (err) {
    if (String(err?.message || '').includes('invitation_code') || String(err?.message || '').includes('referred_by')) {
      [created] = await db`
        INSERT INTO users (
          user_type, full_name, mobile_no, email,
          password_hash, sponsor_user_id, member_id,
          account_status, email_verified, email_verified_at, is_otp_verified,
          referred_by_user_id, referred_by_source, referred_by_set_at,
          enrollment_status, is_verified
        ) VALUES (
          ${pending.user_type}, ${pending.full_name}, ${pending.mobile_no}, ${pending.email},
          ${pending.password_hash}, ${pending.sponsor_user_id || null}, ${memberId},
          ${initialAccountStatus}, TRUE, NOW(), TRUE,
          ${referredByUserId}, ${referredBySource}, ${referredBySetAt},
          '0', FALSE
        )
        RETURNING user_id, full_name, email, mobile_no, user_type, member_id, referred_by_user_id, referred_by_source`;
    } else {
      throw err;
    }
  }

  // Link Team Member to team_members table under sponsoring Associate
  if (normType.includes('team') && pending.sponsor_user_id && created?.user_id) {
    try {
      const associateId = Number(pending.sponsor_user_id);
      const existingMembers = await db`
        SELECT slot_number FROM team_members
        WHERE associate_id = ${associateId} AND status <> 'rejected'
      `;
      const occupiedSlots = new Set(existingMembers.map((m) => Number(m.slot_number)).filter(Boolean));
      let assignedSlot = null;
      for (let s = 1; s <= 10; s++) {
        if (!occupiedSlots.has(s)) {
          assignedSlot = s;
          break;
        }
      }
      const [assoc] = await db`SELECT full_name FROM users WHERE user_id = ${associateId} LIMIT 1`;
      const assocName = assoc?.full_name || 'Associate';
      await db`
        INSERT INTO team_members (
          team_member_uid, associate_id, associate_name, user_id, slot_number,
          full_name, mobile_no, email_id, status, created_at, updated_at
        ) VALUES (
          ${created.member_id}, ${associateId}, ${assocName}, ${created.user_id}, ${assignedSlot},
          ${created.full_name}, ${created.mobile_no}, ${created.email}, 'approved', NOW(), NOW()
        )
        ON CONFLICT (team_member_uid) DO UPDATE
        SET user_id = EXCLUDED.user_id, status = EXCLUDED.status, updated_at = NOW()
      `;
    } catch (tmErr) {
      console.warn('[createUserWithUniqueMemberId] team_members link warning:', tmErr.message);
    }
  }

  return created;
}

async function validateSignupInput(body) {
  const userType = body.user_type || 'Customer';
  const email = normalizeEmail(body.email);
  const mobileNo = normalizeMobileNo(body.mobile_no);
  const rawSponsorCode = body.sponsor_invite_code ? String(body.sponsor_invite_code).trim() : '';
  const fullName = body.full_name?.trim();
  const validationErrors = [];

  console.log('[Registration] Validating signup input...', {
    user_type: userType,
    email,
    mobile_no: mobileNo,
    full_name_present: Boolean(fullName),
    sponsor_invite_code: rawSponsorCode,
  });

  if (!fullName) {
    validationErrors.push('Full name is required');
  } else if (!/^[a-zA-Z]+(\s[a-zA-Z]+)*$/.test(fullName)) {
    validationErrors.push('Full name can only contain letters and spaces (no numbers or special characters)');
  }
  if (!email || !isEmail(email) || !/^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)*@[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)+$/.test(email)) {
    validationErrors.push('Valid email address is required (only letters, numbers, @ and dot allowed; no dash or special characters)');
  }
  if (!mobileNo || !isMobile(mobileNo)) {
    validationErrors.push('Valid 10-digit mobile number is required');
  }
  if (!body.password || body.password.length < 6) {
    validationErrors.push('Password must be at least 6 characters');
  }
  if (!['Customer', 'Associate', 'Investor', 'Team Member'].includes(userType)) {
    validationErrors.push('user_type must be Customer, Associate, Investor, or Team Member');
  }

  if (userType === 'Team Member' && !rawSponsorCode) {
    validationErrors.push('Sponsor Associate ID is required for Team Member registration.');
  }

  if (validationErrors.length) {
    console.error('[Registration] Validation Failed:', validationErrors);
    return { error: validationErrors[0], status: 400, validationErrors };
  }

  console.log('[Registration] Checking duplicate email...');
  const [dupEmail] = await sql`SELECT user_id FROM users WHERE LOWER(email) = ${email}`;
  const [dupInvestorEmail] = await sql`SELECT id FROM investor_users WHERE LOWER(email) = ${email} AND (deleted_at IS NULL) LIMIT 1`;
  if (dupEmail || dupInvestorEmail) {
    console.error('[Registration] Duplicate email found:', { email });
    return { error: 'Email already registered', status: 409 };
  }

  console.log('[Registration] Checking duplicate mobile...');
  const [dupMobile] = await sql`
    SELECT user_id FROM users
    WHERE RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${mobileNo}`;
  const [dupInvestorMobile] = await sql`
    SELECT id FROM investor_users
    WHERE RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${mobileNo} AND (deleted_at IS NULL) LIMIT 1`;
  if (dupMobile || dupInvestorMobile) {
    console.error('[Registration] Duplicate mobile found:', { mobile_no: mobileNo });
    return { error: 'Mobile number already registered', status: 409 };
  }

  let sponsorUserId = null;
  let sponsorInviteCode = null;
  let referredByUserId = null;
  let referredBySource = null;
  let referredBySetAt = null;

  if (rawSponsorCode) {
    const sponsorCode = normalizeSponsorCode(rawSponsorCode);
    console.log('[Registration] Resolving referral code with shared resolver...', { sponsorCode });
    const res = await resolveReferralCode(sql, sponsorCode, { userType, allowDefaultFallback: false });

    if (!res.valid) {
      return { error: res.error || 'Invalid referral code', status: res.status || 400 };
    }

    if (userType === 'Team Member') {
      let targetAssociateId = null;
      if (res.referrer?.user_type === 'Associate') {
        targetAssociateId = res.userId;
      } else if (res.referrer?.user_type === 'Team Member' || res.userType === 'Team Member') {
        targetAssociateId = res.associateId || res.referrer?.associate_id || res.referrer?.sponsor_user_id || res.userId;
      }

      if (targetAssociateId) {
        const existingMembers = await sql`
          SELECT slot_number FROM team_members
          WHERE associate_id = ${targetAssociateId} AND status <> 'rejected'
        `;
        const occupiedSlots = new Set(existingMembers.map((m) => Number(m.slot_number)).filter(Boolean));
        if (occupiedSlots.size >= 10) {
          return { error: 'This Associate has reached the maximum limit of 10 direct Team Members. No available slots.', status: 400 };
        }
      }
    }

    if (res.referrer) {
      sponsorUserId = (userType === 'Team Member' && (res.referrer.user_type === 'Team Member' || res.userType === 'Team Member'))
        ? (res.associateId || res.referrer.associate_id || res.referrer.sponsor_user_id || res.userId)
        : res.userId;
      sponsorInviteCode = res.invitationCode || res.memberId || sponsorCode;
      referredByUserId = res.userId;
      referredBySource = res.source || 'REGISTRATION_CODE';
      referredBySetAt = new Date();
    } else {
      referredByUserId = null;
      referredBySource = 'DIRECT_SIGNUP';
      referredBySetAt = new Date();
    }
  } else {
    // If user is Associate or Team Member and no sponsor code given, fall back to default corporate sponsor MMR-ASC-0001
    if (userType === 'Associate' || userType === 'Team Member') {
      const defaultSponsor = await findSponsorByCode('MMR-ASC-0001');
      if (defaultSponsor) {
        sponsorUserId = defaultSponsor.user_id;
        sponsorInviteCode = 'MMR-ASC-0001';
      }
    }
    referredByUserId = null;
    referredBySource = 'DIRECT_SIGNUP';
    referredBySetAt = new Date();
  }

  return {
    value: {
      userType,
      email,
      mobileNo,
      fullName,
      password: body.password,
      sponsorUserId,
      sponsorInviteCode,
      referredByUserId,
      referredBySource,
      referredBySetAt,
      optionalData: {},
    },
  };
}

router.post('/register-quick', async (req, res) => {
  const requestId = `reg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    console.log(`[Registration:${requestId}] Request received`);
    console.log(`[Registration:${requestId}] Request Body:`, sanitizeBody(req.body));
    console.log(`[Registration:${requestId}] Authenticated User:`, req.user || null);
    console.log(`[Registration:${requestId}] Files Received:`, describeFiles(req.files));
    console.log(`[Registration:${requestId}] Database connection check...`);
    await sql`SELECT 1`;
    console.log(`[Registration:${requestId}] Database connection OK`);

    const validation = await validateSignupInput(req.body);
    if (validation.error) {
      console.error(`[Registration:${requestId}] Validation Failed:`, {
        message: validation.error,
        validationErrors: validation.validationErrors,
        status: validation.status || 400,
      });
      return err(res, validation.error, validation.status || 400);
    }

    const {
      userType,
      email,
      mobileNo,
      fullName,
      password,
      sponsorUserId,
      sponsorInviteCode,
      referredByUserId,
      referredBySource,
      referredBySetAt,
      optionalData,
    } = validation.value;

    const authSettings = await getAppAuthSettingsRow();
    const isEmailOtpEnabled = authSettings?.email_otp_enabled !== false;
    const isSmsOtpEnabled = Boolean(authSettings?.sms_otp_enabled);
    const isOtpRequired = isEmailOtpEnabled || isSmsOtpEnabled;

    // ─────────────────────────────────────────────────────────────
    // IF BOTH EMAIL & SMS OTP ARE DISABLED (BYPASS OTP & DIRECT REGISTRATION)
    // ─────────────────────────────────────────────────────────────
    if (!isOtpRequired) {
      console.log(`[Registration:${requestId}] Email OTP is disabled. Creating ${userType} directly without OTP.`);
      const passwordHash = await bcrypt.hash(password, 12);

      if (userType === 'Investor') {
        const [invSeq] = await sql`
          SELECT COALESCE(MAX(
            CASE
              WHEN member_id ~* '^MMR-INV-[0-9]+$' THEN SUBSTRING(member_id FROM 9)::integer
              ELSE id END
          ), 0) + 1 AS next_value
          FROM investor_users`;
        const memberId = `MMR-INV-${String(Number(invSeq?.next_value || 1)).padStart(5, '0')}`;

        const [createdInvestor] = await sql`
          INSERT INTO investor_users (
            member_id, full_name, mobile_number, email, password_hash, status, is_verified, created_at, updated_at
          ) VALUES (
            ${memberId}, ${fullName}, ${mobileNo}, ${email}, ${passwordHash},
            'active', true, NOW(), NOW()
          )
          RETURNING id, member_id, full_name, email, mobile_number, status, is_verified`;

        const payload = {
          id: createdInvestor.id,
          user_id: createdInvestor.id,
          member_id: createdInvestor.member_id,
          user_type: 'Investor',
          role: 'Investor',
          email: createdInvestor.email,
          full_name: createdInvestor.full_name,
        };
        const jwtSecret = process.env.JWT_SECRET;
        if (!jwtSecret) throw new Error("JWT_SECRET is not configured");
        const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || jwtSecret;
        const token = jwt.sign(payload, jwtSecret, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });
        const refreshToken = jwt.sign(payload, jwtRefreshSecret, { expiresIn: '60d' });

        return ok(res, {
          otpBypassed: true,
          token,
          refresh_token: refreshToken,
          user: {
            id: createdInvestor.id,
            user_id: createdInvestor.id,
            full_name: createdInvestor.full_name,
            email: createdInvestor.email,
            mobile_no: createdInvestor.mobile_number,
            mobile_number: createdInvestor.mobile_number,
            user_type: 'Investor',
            role: 'Investor',
            status: 'active',
            account_status: 'active',
            is_verified: true,
            email_verified: true,
          },
          redirect: '/investor/dashboard'
        }, 'Registration successful. Investor account is active.', 201);
      }

      // Associate or Customer
      const pendingObj = {
        user_type: userType,
        full_name: fullName,
        mobile_no: mobileNo,
        email: email,
        password_hash: passwordHash,
        sponsor_user_id: sponsorUserId,
        sponsor_invite_code: sponsorInviteCode,
        referred_by_user_id: referredByUserId,
        referred_by_source: referredBySource,
        referred_by_set_at: referredBySetAt,
        optional_data: optionalData || {},
      };

      const newUser = await sql.begin(async (tx) => {
        const createdUser = await createUserWithUniqueMemberId(tx, pendingObj);

        if (pendingObj.optional_data?.address || pendingObj.optional_data?.city || pendingObj.optional_data?.state) {
          try {
            await tx`
              CREATE TABLE IF NOT EXISTS user_addresses (
                address_id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
                address_type VARCHAR(50) DEFAULT 'Permanent',
                address_line1 TEXT,
                city VARCHAR(100),
                state VARCHAR(100),
                pin_code VARCHAR(20),
                created_at TIMESTAMPTZ DEFAULT NOW()
              )`;
            await tx`
              INSERT INTO user_addresses (user_id, address_type, address_line1, city, state)
              VALUES (
                ${createdUser.user_id}, 'Permanent', ${pendingObj.optional_data.address || null},
                ${pendingObj.optional_data.city || null}, ${pendingObj.optional_data.state || null}
              )`;
          } catch (addrErr) {
            console.warn('[register-quick direct] user_addresses warning:', addrErr.message);
          }
        }

        if (pendingObj.sponsor_user_id) {
          try {
            await tx`
              CREATE TABLE IF NOT EXISTS referral_registrations (
                id SERIAL PRIMARY KEY,
                sponsor_user_id INTEGER REFERENCES users(user_id),
                referred_user_id INTEGER UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
                sponsor_invite_code VARCHAR(80),
                registration_source VARCHAR(80) DEFAULT 'ReferralLink',
                referral_level INTEGER NOT NULL DEFAULT 1,
                status VARCHAR(30) NOT NULL DEFAULT 'Pending',
                approved_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
              )`;
            await tx`
              INSERT INTO referral_registrations (sponsor_user_id, referred_user_id, sponsor_invite_code, registration_source, status, approved_at)
              VALUES (${pendingObj.sponsor_user_id}, ${createdUser.user_id}, ${pendingObj.sponsor_invite_code}, 'Signup', 'Approved', NOW())`;
          } catch (refErr) {
            console.warn('[register-quick direct] referral_registrations warning:', refErr.message);
          }

          try {
            await tx`
              CREATE TABLE IF NOT EXISTS associate_referral_links (
                id SERIAL PRIMARY KEY,
                associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                invite_code VARCHAR(80) NOT NULL UNIQUE,
                referral_url TEXT,
                total_clicks INTEGER NOT NULL DEFAULT 0,
                total_registrations INTEGER NOT NULL DEFAULT 0,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
              )`;
            await tx`
              UPDATE associate_referral_links
              SET total_registrations = total_registrations + 1, updated_at = NOW()
              WHERE associate_user_id = ${pendingObj.sponsor_user_id}`;
          } catch (linkErr) {
            console.warn('[register-quick direct] associate_referral_links warning:', linkErr.message);
          }

          try {
            await tx`
              CREATE TABLE IF NOT EXISTS mlm_network (
                id SERIAL PRIMARY KEY,
                associate_user_id INTEGER UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
                sponsor_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
                level INTEGER NOT NULL DEFAULT 1,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
              )`;
            await tx`
              INSERT INTO mlm_network (associate_user_id, sponsor_user_id, level)
              VALUES (${createdUser.user_id}, ${pendingObj.sponsor_user_id},
                COALESCE((SELECT level FROM mlm_network WHERE associate_user_id = ${pendingObj.sponsor_user_id}), 0) + 1)`;
          } catch (mlmErr) {
            console.warn('[register-quick direct] mlm_network warning:', mlmErr.message);
          }

          try {
            await tx`
              CREATE TABLE IF NOT EXISTS mlm_tree_closure (
                ancestor_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                descendant_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                depth INTEGER NOT NULL,
                PRIMARY KEY (ancestor_user_id, descendant_user_id)
              )`;
            await tx`
              INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
              VALUES (${createdUser.user_id}, ${createdUser.user_id}, 0)
              ON CONFLICT DO NOTHING`;
            await tx`
              INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
              SELECT ancestor_user_id, ${createdUser.user_id}, depth + 1
              FROM mlm_tree_closure
              WHERE descendant_user_id = ${pendingObj.sponsor_user_id}
              ON CONFLICT DO NOTHING`;
            await tx`
              INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
              VALUES (${pendingObj.sponsor_user_id}, ${createdUser.user_id}, 1)
              ON CONFLICT DO NOTHING`;
          } catch (treeErr) {
            console.warn('[register-quick direct] mlm_tree_closure warning:', treeErr.message);
          }
        } else {
          try {
            await tx`
              CREATE TABLE IF NOT EXISTS mlm_tree_closure (
                ancestor_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                descendant_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                depth INTEGER NOT NULL,
                PRIMARY KEY (ancestor_user_id, descendant_user_id)
              )`;
            await tx`
              INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
              VALUES (${createdUser.user_id}, ${createdUser.user_id}, 0)
              ON CONFLICT DO NOTHING`;
          } catch (treeErr) {
            console.warn('[register-quick direct] mlm_tree_closure self warning:', treeErr.message);
          }
        }

        try {
          await tx`
            CREATE TABLE IF NOT EXISTS user_wallets (
              id SERIAL PRIMARY KEY,
              user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
              user_role VARCHAR(50),
              available_balance NUMERIC(12,2) DEFAULT 0,
              pending_withdrawal_balance NUMERIC(12,2) DEFAULT 0,
              total_added_fund NUMERIC(12,2) DEFAULT 0,
              total_withdrawn NUMERIC(12,2) DEFAULT 0,
              total_commission NUMERIC(12,2) DEFAULT 0,
              created_at TIMESTAMPTZ DEFAULT NOW(),
              updated_at TIMESTAMPTZ DEFAULT NOW()
            )`;
          await tx`
            INSERT INTO user_wallets (user_id, user_role, available_balance, pending_withdrawal_balance, total_added_fund, total_withdrawn, total_commission)
            VALUES (${createdUser.user_id}, ${userType}, 0, 0, 0, 0, 0)
            ON CONFLICT DO NOTHING`;
        } catch (wErr) {
          console.warn('[register-quick direct] user_wallets warning:', wErr.message);
        }

        try {
          await tx`
            CREATE TABLE IF NOT EXISTS audit_log (
              id SERIAL PRIMARY KEY,
              actor_type VARCHAR(50),
              actor_id INTEGER,
              actor_name VARCHAR(150),
              module VARCHAR(50),
              action VARCHAR(100),
              target_table VARCHAR(50),
              target_record_id INTEGER,
              created_at TIMESTAMPTZ DEFAULT NOW()
            )`;
          await tx`
            INSERT INTO audit_log
              (actor_type, actor_id, actor_name, module, action, target_table, target_record_id)
            VALUES
              ('User', ${createdUser.user_id}, ${createdUser.full_name},
               'Auth', 'RegisteredDirectNoOtp', 'users', ${createdUser.user_id})`;
        } catch (auditErr) {
          console.warn('[register-quick direct] audit_log warning:', auditErr.message);
        }

        return createdUser;
      });

      const payload = {
        user_id: newUser.user_id,
        user_type: newUser.user_type,
        member_id: newUser.member_id,
        email: newUser.email,
        mobile_no: newUser.mobile_no,
      };
      const jwtSecret = process.env.JWT_SECRET;
      if (!jwtSecret) throw new Error("JWT_SECRET is not configured");
      const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || jwtSecret;
      const token = jwt.sign(payload, jwtSecret, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });
      const refreshToken = jwt.sign(payload, jwtRefreshSecret, { expiresIn: '60d' });

      return ok(res, {
        otpBypassed: true,
        token,
        refresh_token: refreshToken,
        user: {
          user_id: newUser.user_id,
          full_name: newUser.full_name,
          user_type: newUser.user_type,
          member_id: newUser.member_id,
          invitation_code: newUser.invitation_code || null,
          account_status: userType === 'Customer' ? 'Active' : 'Pending',
          email_verified: true,
          mobile_no: newUser.mobile_no,
          email: newUser.email,
        },
        redirect: userType === 'Associate' ? '/login' : '/customer/dashboard',
      }, userType === 'Customer'
        ? 'Registration successful. Customer account is active.'
        : 'Registration successful. Registration completed and is pending admin approval.', 201);
    }

    // ─────────────────────────────────────────────────────────────
    // IF EMAIL OR SMS OTP IS ENABLED (NORMAL OTP DISPATCH FLOW)
    // ─────────────────────────────────────────────────────────────
    await ensurePendingRegistrationTable();
    console.log(`[Registration:${requestId}] Pending registration table ensured`);

    // Separate OTPs for Email and Contact Number verification
    const emailOtp = genOTP();
    const smsOtp = genOTP(); // Distinct SMS OTP
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    console.log(`[Registration:${requestId}] Hashing password...`);
    const passwordHash = await bcrypt.hash(password, 12);
    console.log(`[Registration:${requestId}] Password hashed`);

    console.log(`[Registration:${requestId}] Removing old pending registration records...`);
    await sql`
      DELETE FROM pending_registrations
      WHERE email = ${email} OR mobile_no = ${mobileNo}`;
    console.log(`[Registration:${requestId}] Old pending registration cleanup complete`);

    console.log(`[Registration:${requestId}] Creating pending record with separate OTPs...`, {
      user_type: userType,
      email,
      mobile_no: mobileNo,
      sponsor_user_id: sponsorUserId,
      expires_at: expires,
      emailOtp,
      smsOtp
    });
    await sql`
      INSERT INTO pending_registrations (
        email, mobile_no, user_type, full_name, password_hash,
        sponsor_user_id, sponsor_invite_code, referred_by_user_id, referred_by_source, optional_data,
        otp_code, email_otp_code, sms_otp_code,
        email_verified, mobile_verified,
        email_otp_expires_at, sms_otp_expires_at, expires_at
      ) VALUES (
        ${email}, ${mobileNo}, ${userType}, ${fullName}, ${passwordHash},
        ${sponsorUserId}, ${sponsorInviteCode}, ${referredByUserId}, ${referredBySource}, ${sql.json(optionalData || {})},
        ${emailOtp}, ${emailOtp}, ${smsOtp},
        ${!isEmailOtpEnabled}, ${!isSmsOtpEnabled},
        ${expires}, ${expires}, ${expires}
      )`;
    console.log(`[Registration:${requestId}] Pending record created`);

    // Dispatch Email OTP if enabled
    if (isEmailOtpEnabled) {
      try {
        console.log(`[Registration:${requestId}] Sending Email OTP to ${email}...`);
        await sendEmail(email, 'Verify your MMR account (Email OTP)', otpEmailHtml(emailOtp, 'Email Verification'));
        console.log(`[Registration:${requestId}] Email OTP sent`);
      } catch (mailErr) {
        console.warn(`[Registration:${requestId}] OTP email failed:`, mailErr.message);
      }
    }

    // Dispatch SMS OTP to contact / mobile if enabled
    if (isSmsOtpEnabled && mobileNo) {
      try {
        console.log(`[Registration:${requestId}] Sending SMS OTP to contact ${mobileNo}...`);
        await twoFactorService.sendCustomOtp({
          mobile: mobileNo,
          otp: smsOtp,
          template: 'OTP Verification',
          purpose: 'Registration'
        });
        console.log(`[Registration:${requestId}] SMS OTP sent to contact number`);
      } catch (smsErr) {
        console.warn(`[Registration:${requestId}] OTP SMS failed:`, smsErr.message);
      }
    }

    const responseData = {
      email,
      mobile: mobileNo,
      user_type: userType,
      email_otp_required: isEmailOtpEnabled,
      sms_otp_required: isSmsOtpEnabled,
      email_otp_sent: isEmailOtpEnabled,
      sms_otp_sent: isSmsOtpEnabled,
      email_verified: !isEmailOtpEnabled,
      mobile_verified: !isSmsOtpEnabled
    };
    console.log(`[Registration:${requestId}] Registration initiated`, responseData);
    return ok(
      res,
      responseData,
      isEmailOtpEnabled && isSmsOtpEnabled
        ? 'Registration initiated. Separate OTPs have been sent to your email and contact number.'
        : isEmailOtpEnabled
          ? 'Registration initiated. OTP sent to your email address.'
          : 'Registration initiated. OTP sent via SMS to your mobile / contact number.',
      200
    );
  } catch (e) {
    logRegistrationError(`[Registration:${requestId}] Registration Error`, e);

    if (e?.code === '23505') {
      if (String(e?.constraint || '').includes('pending_registrations_mobile')) {
        return err(res, 'Mobile number already has a pending registration. Please verify OTP or try again.', 409);
      }
      return err(res, 'Duplicate registration record found', 409);
    }
    if (/cloudinary/i.test(e?.message || '')) {
      return err(res, 'Cloudinary upload failed', 500);
    }
    if (/send|smtp|email|mail/i.test(e?.message || '')) {
      return err(res, `Email delivery failed: ${e.message}`, 500);
    }
    if (e?.code || e?.constraint || e?.table) {
      return err(res, `Database insert failed: ${e.message}`, 500);
    }

    return err(res, e.message || 'Registration failed');
  }
});

router.post('/send-email-otp', async (req, res) => {
  try {
    const authSettings = await getAppAuthSettingsRow();
    if (authSettings.email_otp_enabled === false) {
      return ok(res, { otpBypassed: true }, 'OTP verification is disabled.');
    }

    const email = normalizeEmail(req.body.email);
    if (!email || !isEmail(email)) return err(res, 'Valid email required', 400);

    await ensurePendingRegistrationTable();

    const [pending] = await sql`
      SELECT email FROM pending_registrations
      WHERE email = ${email}`;
    if (!pending) return err(res, 'Start registration before requesting OTP', 404);

    if (!(await canResend(email))) {
      return err(res, 'Please wait 3 minutes before requesting a new OTP', 429);
    }

    const otp = genOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await sql`
      UPDATE pending_registrations
      SET otp_code = ${otp}, attempts = 0, expires_at = ${expires}, updated_at = NOW()
      WHERE email = ${email}`;

    await sendEmail(email, 'Verify your MMR account', otpEmailHtml(otp, 'Verification'));

    return ok(res, { email }, 'OTP sent to email');
  } catch (e) {
    console.error('[send-email-otp]', e);
    return err(res, e.message);
  }
});

async function findPendingRegistration(email, cleanMobile) {
  let pending = null;
  if (email && cleanMobile) {
    const [row] = await sql`
      SELECT * FROM pending_registrations
      WHERE email = ${email} OR RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanMobile}
      LIMIT 1`;
    pending = row;
  } else if (email) {
    const [row] = await sql`
      SELECT * FROM pending_registrations
      WHERE email = ${email}
      LIMIT 1`;
    pending = row;
  } else if (cleanMobile) {
    const [row] = await sql`
      SELECT * FROM pending_registrations
      WHERE RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanMobile}
      LIMIT 1`;
    pending = row;
  }
  return pending;
}

async function completeUserRegistration(pending, res) {
  const email = pending.email;

  if (pending.user_type === 'Investor') {
    const [dupInvestorEmail] = await sql`SELECT id FROM investor_users WHERE LOWER(email) = ${email} AND deleted_at IS NULL LIMIT 1`;
    if (dupInvestorEmail) {
      await sql`DELETE FROM pending_registrations WHERE email = ${email}`;
      return err(res, 'Email already registered', 409);
    }
    const [dupInvestorMobile] = await sql`
      SELECT id FROM investor_users
      WHERE RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${pending.mobile_no} AND deleted_at IS NULL LIMIT 1`;
    if (dupInvestorMobile) {
      await sql`DELETE FROM pending_registrations WHERE email = ${email}`;
      return err(res, 'Mobile number already registered', 409);
    }

    const [invSeq] = await sql`
      SELECT COALESCE(MAX(
        CASE
          WHEN member_id ~* '^MMR-INV-[0-9]+$' THEN SUBSTRING(member_id FROM 9)::integer
          ELSE id END
      ), 0) + 1 AS next_value
      FROM investor_users`;
    const memberId = `MMR-INV-${String(Number(invSeq?.next_value || 1)).padStart(5, '0')}`;

    const [createdInvestor] = await sql`
      INSERT INTO investor_users (
        member_id, full_name, mobile_number, email, password_hash, status, is_verified, created_at, updated_at
      ) VALUES (
        ${memberId}, ${pending.full_name}, ${pending.mobile_no}, ${pending.email}, ${pending.password_hash},
        'active', true, NOW(), NOW()
      )
      RETURNING id, member_id, full_name, email, mobile_number, status, is_verified`;

    await sql`DELETE FROM pending_registrations WHERE email = ${email}`;

    const payload = {
      id: createdInvestor.id,
      user_id: createdInvestor.id,
      member_id: createdInvestor.member_id,
      user_type: 'Investor',
      role: 'Investor',
      email: createdInvestor.email,
      full_name: createdInvestor.full_name,
    };
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) throw new Error("JWT_SECRET is not configured");
    const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || jwtSecret;
    const token = jwt.sign(payload, jwtSecret, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });
    const refreshToken = jwt.sign(payload, jwtRefreshSecret, { expiresIn: '60d' });

    return ok(res, {
      completed: true,
      token,
      refresh_token: refreshToken,
      user: {
        id: createdInvestor.id,
        user_id: createdInvestor.id,
        full_name: createdInvestor.full_name,
        email: createdInvestor.email,
        mobile_no: createdInvestor.mobile_number,
        mobile_number: createdInvestor.mobile_number,
        user_type: 'Investor',
        role: 'Investor',
        status: 'active',
        account_status: 'active',
        is_verified: true,
        email_verified: true,
      },
      redirect: '/investor/dashboard'
    }, 'Investor registration verified and completed successfully.');
  }

  const [dupEmail] = await sql`SELECT user_id FROM users WHERE LOWER(email) = ${email}`;
  const [dupInvestorEmail] = await sql`SELECT id FROM investor_users WHERE LOWER(email) = ${email} AND deleted_at IS NULL LIMIT 1`;
  if (dupEmail || dupInvestorEmail) {
    await sql`DELETE FROM pending_registrations WHERE email = ${email}`;
    return err(res, 'Email already registered', 409);
  }

  const cleanPendingMobile10 = String(pending.mobile_no).replace(/\D/g, "").slice(-10);
  const [dupMobile] = await sql`
    SELECT user_id FROM users
    WHERE RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanPendingMobile10}`;
  const [dupInvestorMobile] = await sql`
    SELECT id FROM investor_users
    WHERE RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${cleanPendingMobile10} AND deleted_at IS NULL LIMIT 1`;
  if (dupMobile || dupInvestorMobile) {
    await sql`DELETE FROM pending_registrations WHERE email = ${email}`;
    return err(res, 'Mobile number already registered', 409);
  }

  const newUser = await sql.begin(async (tx) => {
    const createdUser = await createUserWithUniqueMemberId(tx, pending);

    if (pending.optional_data?.address || pending.optional_data?.city || pending.optional_data?.state) {
      try {
        await tx`
          CREATE TABLE IF NOT EXISTS user_addresses (
            address_id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
            address_type VARCHAR(50) DEFAULT 'Permanent',
            address_line1 TEXT,
            city VARCHAR(100),
            state VARCHAR(100),
            pin_code VARCHAR(20),
            created_at TIMESTAMPTZ DEFAULT NOW()
          )`;
        await tx`
          INSERT INTO user_addresses (user_id, address_type, address_line1, city, state)
          VALUES (
            ${createdUser.user_id}, 'Permanent', ${pending.optional_data.address || null},
            ${pending.optional_data.city || null}, ${pending.optional_data.state || null}
          )`;
      } catch (addrErr) {
        console.warn('[completeUserRegistration] user_addresses warning:', addrErr.message);
      }
    }

    if (pending.sponsor_user_id) {
      try {
        await tx`
          CREATE TABLE IF NOT EXISTS referral_registrations (
            id SERIAL PRIMARY KEY,
            sponsor_user_id INTEGER REFERENCES users(user_id),
            referred_user_id INTEGER UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
            sponsor_invite_code VARCHAR(80),
            registration_source VARCHAR(80) DEFAULT 'ReferralLink',
            referral_level INTEGER NOT NULL DEFAULT 1,
            status VARCHAR(30) NOT NULL DEFAULT 'Pending',
            approved_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await tx`
          INSERT INTO referral_registrations (sponsor_user_id, referred_user_id, sponsor_invite_code, registration_source, status, approved_at)
          VALUES (${pending.sponsor_user_id}, ${createdUser.user_id}, ${pending.sponsor_invite_code}, 'Signup', 'Approved', NOW())`;
      } catch (refErr) {
        console.warn('[completeUserRegistration] referral_registrations warning:', refErr.message);
      }

      try {
        await tx`
          CREATE TABLE IF NOT EXISTS associate_referral_links (
            id SERIAL PRIMARY KEY,
            associate_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            invite_code VARCHAR(80) NOT NULL UNIQUE,
            referral_url TEXT,
            total_clicks INTEGER NOT NULL DEFAULT 0,
            total_registrations INTEGER NOT NULL DEFAULT 0,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await tx`
          UPDATE associate_referral_links
          SET total_registrations = total_registrations + 1, updated_at = NOW()
          WHERE associate_user_id = ${pending.sponsor_user_id}`;
      } catch (linkErr) {
        console.warn('[completeUserRegistration] associate_referral_links warning:', linkErr.message);
      }

      try {
        await tx`
          CREATE TABLE IF NOT EXISTS mlm_network (
            id SERIAL PRIMARY KEY,
            associate_user_id INTEGER UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
            sponsor_user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
            level INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )`;
        await tx`
          INSERT INTO mlm_network (associate_user_id, sponsor_user_id, level)
          VALUES (${createdUser.user_id}, ${pending.sponsor_user_id},
            COALESCE((SELECT level FROM mlm_network WHERE associate_user_id = ${pending.sponsor_user_id}), 0) + 1)`;
      } catch (mlmErr) {
        console.warn('[completeUserRegistration] mlm_network warning:', mlmErr.message);
      }

      try {
        await tx`
          CREATE TABLE IF NOT EXISTS mlm_tree_closure (
            ancestor_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            descendant_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            depth INTEGER NOT NULL,
            PRIMARY KEY (ancestor_user_id, descendant_user_id)
          )`;
        await tx`
          INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
          VALUES (${createdUser.user_id}, ${createdUser.user_id}, 0)
          ON CONFLICT DO NOTHING`;
        await tx`
          INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
          SELECT ancestor_user_id, ${createdUser.user_id}, depth + 1
          FROM mlm_tree_closure
          WHERE descendant_user_id = ${pending.sponsor_user_id}
          ON CONFLICT DO NOTHING`;
        await tx`
          INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
          VALUES (${pending.sponsor_user_id}, ${createdUser.user_id}, 1)
          ON CONFLICT DO NOTHING`;
      } catch (treeErr) {
        console.warn('[completeUserRegistration] mlm_tree_closure warning:', treeErr.message);
      }
    } else {
      try {
        await tx`
          CREATE TABLE IF NOT EXISTS mlm_tree_closure (
            ancestor_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            descendant_user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            depth INTEGER NOT NULL,
            PRIMARY KEY (ancestor_user_id, descendant_user_id)
          )`;
        await tx`
          INSERT INTO mlm_tree_closure (ancestor_user_id, descendant_user_id, depth)
          VALUES (${createdUser.user_id}, ${createdUser.user_id}, 0)
          ON CONFLICT DO NOTHING`;
      } catch (treeErr) {
        console.warn('[completeUserRegistration] mlm_tree_closure self warning:', treeErr.message);
      }
    }

    try {
      await tx`
        CREATE TABLE IF NOT EXISTS user_wallets (
          id SERIAL PRIMARY KEY,
          user_id INTEGER REFERENCES users(user_id) ON DELETE CASCADE,
          user_role VARCHAR(50),
          available_balance NUMERIC(12,2) DEFAULT 0,
          pending_withdrawal_balance NUMERIC(12,2) DEFAULT 0,
          total_added_fund NUMERIC(12,2) DEFAULT 0,
          total_withdrawn NUMERIC(12,2) DEFAULT 0,
          total_commission NUMERIC(12,2) DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )`;
      await tx`
        INSERT INTO user_wallets (user_id, user_role, available_balance, pending_withdrawal_balance, total_added_fund, total_withdrawn, total_commission)
        VALUES (${createdUser.user_id}, ${pending.user_type}, 0, 0, 0, 0, 0)
        ON CONFLICT DO NOTHING`;
    } catch (wErr) {
      console.warn('[completeUserRegistration] user_wallets warning:', wErr.message);
    }

    await tx`DELETE FROM pending_registrations WHERE email = ${email}`;

    try {
      await tx`
        CREATE TABLE IF NOT EXISTS audit_log (
          id SERIAL PRIMARY KEY,
          actor_type VARCHAR(50),
          actor_id INTEGER,
          actor_name VARCHAR(150),
          module VARCHAR(50),
          action VARCHAR(100),
          target_table VARCHAR(50),
          target_record_id INTEGER,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )`;
      await tx`
        INSERT INTO audit_log
          (actor_type, actor_id, actor_name, module, action, target_table, target_record_id)
        VALUES
          ('User', ${createdUser.user_id}, ${createdUser.full_name},
           'Auth', 'RegisteredAfterOtp', 'users', ${createdUser.user_id})`;
    } catch (auditErr) {
      console.warn('[completeUserRegistration] audit_log warning:', auditErr.message);
    }

    return createdUser;
  });

  const payload = {
    user_id: newUser.user_id,
    user_type: newUser.user_type,
    member_id: newUser.member_id,
    email: newUser.email,
  };
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error("JWT_SECRET is not configured");
  const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || jwtSecret;
  const token = jwt.sign(payload, jwtSecret, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });
  const refreshToken = jwt.sign(payload, jwtRefreshSecret, { expiresIn: '60d' });

  return ok(res, {
    completed: true,
    token,
    refresh_token: refreshToken,
    user: {
      user_id: newUser.user_id,
      full_name: newUser.full_name,
      user_type: newUser.user_type,
      member_id: newUser.member_id,
      invitation_code: newUser.invitation_code || null,
      account_status: pending.user_type === 'Customer' ? 'Active' : 'Pending',
      email_verified: true,
      is_verified: true,
    },
    redirect: newUser.user_type === 'Associate' ? '/associate/dashboard' : '/user/dashboard',
  }, pending.user_type === 'Customer'
    ? 'Verification successful. Your customer account is active.'
    : 'Verification successful. Registration completed and is pending admin approval.');
}

router.get('/otp-status', async (req, res) => {
  try {
    await ensurePendingRegistrationTable();
    const email = req.query.email ? normalizeEmail(req.query.email) : '';
    const rawMobile = req.query.mobile || req.query.mobile_no || '';
    const cleanMobile = rawMobile ? String(rawMobile).replace(/\D/g, '').slice(-10) : '';

    const authSettings = await getAppAuthSettingsRow();
    const isEmailRequired = authSettings?.email_otp_enabled !== false;
    const isSmsRequired = Boolean(authSettings?.sms_otp_enabled);

    let pending = null;
    if (email || cleanMobile) {
      pending = await findPendingRegistration(email, cleanMobile);
    }

    return ok(res, {
      email: pending?.email || email,
      mobile: pending?.mobile_no || cleanMobile,
      user_type: pending?.user_type || 'Customer',
      email_otp_required: isEmailRequired,
      sms_otp_required: isSmsRequired,
      email_verified: Boolean(pending?.email_verified),
      mobile_verified: Boolean(pending?.mobile_verified),
      is_pending: Boolean(pending),
    });
  } catch (e) {
    return err(res, e.message);
  }
});

router.post('/verify-email-otp', async (req, res) => {
  try {
    await ensurePendingRegistrationTable();

    const email = req.body.email ? normalizeEmail(req.body.email) : '';
    const rawMobile = req.body.mobile || req.body.mobile_no || '';
    const cleanMobile = rawMobile ? String(rawMobile).replace(/\D/g, '').slice(-10) : '';
    const otp = String(req.body.otp || req.body.otp_code || req.body.email_otp || '').trim();

    if ((!email && !cleanMobile) || !otp) {
      return err(res, 'Email and OTP are required', 400);
    }

    const pending = await findPendingRegistration(email, cleanMobile);
    if (!pending) return err(res, 'No pending registration found. Please sign up again.', 404);

    if (pending.email_otp_attempts >= 5) {
      return err(res, 'Too many invalid attempts on Email OTP. Please resend a new OTP.', 429);
    }
    const expires = pending.email_otp_expires_at || pending.expires_at;
    if (new Date() > new Date(expires)) {
      return err(res, 'Email OTP has expired. Please request a new OTP.', 400);
    }

    const validEmailOtp = pending.email_otp_code || pending.otp_code;
    if (validEmailOtp !== otp) {
      await sql`
        UPDATE pending_registrations
        SET email_otp_attempts = COALESCE(email_otp_attempts, 0) + 1, updated_at = NOW()
        WHERE email = ${pending.email}`;
      return err(res, 'Invalid Email OTP. Please check the code sent to your email.', 400);
    }

    // Mark email verified
    await sql`
      UPDATE pending_registrations
      SET email_verified = TRUE, updated_at = NOW()
      WHERE email = ${pending.email}`;
    pending.email_verified = true;

    const authSettings = await getAppAuthSettingsRow();
    const isSmsOtpRequired = Boolean(authSettings?.sms_otp_enabled);

    // If SMS OTP is also required and not yet verified:
    if (isSmsOtpRequired && !pending.mobile_verified) {
      return ok(res, {
        email_verified: true,
        mobile_verified: false,
        completed: false
      }, 'Email verified successfully! Now please enter the OTP sent to your contact number.');
    }

    // If both (or all required) are verified, complete registration!
    return await completeUserRegistration(pending, res);
  } catch (e) {
    logRegistrationError('[verify-email-otp]', e);
    return err(res, e.message || 'Verification failed');
  }
});

router.post(['/verify-sms-otp', '/verify-contact-otp', '/verify-mobile-otp'], async (req, res) => {
  try {
    await ensurePendingRegistrationTable();

    const email = req.body.email ? normalizeEmail(req.body.email) : '';
    const rawMobile = req.body.mobile || req.body.mobile_no || '';
    const cleanMobile = rawMobile ? String(rawMobile).replace(/\D/g, '').slice(-10) : '';
    const otp = String(req.body.otp || req.body.otp_code || req.body.sms_otp || req.body.mobile_otp || '').trim();

    if ((!email && !cleanMobile) || !otp) {
      return err(res, 'Contact Number and OTP are required', 400);
    }

    const pending = await findPendingRegistration(email, cleanMobile);
    if (!pending) return err(res, 'No pending registration found. Please sign up again.', 404);

    if (pending.sms_otp_attempts >= 5) {
      return err(res, 'Too many invalid attempts on Contact Number OTP. Please resend a new OTP.', 429);
    }
    const expires = pending.sms_otp_expires_at || pending.expires_at;
    if (new Date() > new Date(expires)) {
      return err(res, 'Contact Number OTP has expired. Please request a new OTP.', 400);
    }

    const validSmsOtp = pending.sms_otp_code;
    if (validSmsOtp !== otp) {
      await sql`
        UPDATE pending_registrations
        SET sms_otp_attempts = COALESCE(sms_otp_attempts, 0) + 1, updated_at = NOW()
        WHERE email = ${pending.email}`;
      return err(res, 'Invalid Contact Number OTP. Please check the SMS code sent to your mobile.', 400);
    }

    // Mark mobile verified
    await sql`
      UPDATE pending_registrations
      SET mobile_verified = TRUE, updated_at = NOW()
      WHERE email = ${pending.email}`;
    pending.mobile_verified = true;

    const authSettings = await getAppAuthSettingsRow();
    const isEmailOtpRequired = authSettings?.email_otp_enabled !== false;

    // If Email OTP is also required and not yet verified:
    if (isEmailOtpRequired && !pending.email_verified) {
      return ok(res, {
        email_verified: false,
        mobile_verified: true,
        completed: false
      }, 'Contact number verified successfully! Now please enter the OTP sent to your email.');
    }

    // If both (or all required) are verified, complete registration!
    return await completeUserRegistration(pending, res);
  } catch (e) {
    logRegistrationError('[verify-sms-otp]', e);
    return err(res, e.message || 'Verification failed');
  }
});

router.post(['/verify-both-otp', '/verify-all-otp'], async (req, res) => {
  try {
    await ensurePendingRegistrationTable();

    const email = req.body.email ? normalizeEmail(req.body.email) : '';
    const rawMobile = req.body.mobile || req.body.mobile_no || '';
    const cleanMobile = rawMobile ? String(rawMobile).replace(/\D/g, '').slice(-10) : '';
    const emailOtp = String(req.body.email_otp || '').trim();
    const smsOtp = String(req.body.sms_otp || req.body.mobile_otp || '').trim();

    const pending = await findPendingRegistration(email, cleanMobile);
    if (!pending) return err(res, 'No pending registration found. Please sign up again.', 404);

    const authSettings = await getAppAuthSettingsRow();
    const isEmailRequired = authSettings?.email_otp_enabled !== false;
    const isSmsRequired = Boolean(authSettings?.sms_otp_enabled);

    if (isEmailRequired && !pending.email_verified) {
      if (!emailOtp || emailOtp !== (pending.email_otp_code || pending.otp_code)) {
        return err(res, 'Invalid Email OTP. Please check the code sent to your email.', 400);
      }
      pending.email_verified = true;
    }

    if (isSmsRequired && !pending.mobile_verified) {
      if (!smsOtp || smsOtp !== pending.sms_otp_code) {
        return err(res, 'Invalid Contact Number OTP. Please check the SMS code sent to your mobile.', 400);
      }
      pending.mobile_verified = true;
    }

    await sql`
      UPDATE pending_registrations
      SET email_verified = TRUE, mobile_verified = TRUE, updated_at = NOW()
      WHERE email = ${pending.email}`;

    return await completeUserRegistration(pending, res);
  } catch (e) {
    logRegistrationError('[verify-both-otp]', e);
    return err(res, e.message || 'Verification failed');
  }
});

router.get('/verify-email-otp', (_req, res) => {
  return ok(res, null, 'Email verification endpoint requires HTTP POST with email and OTP');
});

router.get('/sync-sequences', async (req, res) => {
  try {
    await sql`SELECT setval(pg_get_serial_sequence('users', 'user_id'), COALESCE(MAX(user_id), 1) + 1, false) FROM users`;
    await sql`SELECT setval(pg_get_serial_sequence('referral_registrations', 'id'), COALESCE(MAX(id), 1) + 1, false) FROM referral_registrations`;
    await sql`SELECT setval(pg_get_serial_sequence('mlm_network', 'id'), COALESCE(MAX(id), 1) + 1, false) FROM mlm_network`;
    await sql`SELECT setval(pg_get_serial_sequence('user_addresses', 'address_id'), COALESCE(MAX(address_id), 1) + 1, false) FROM user_addresses`;
    await sql`SELECT setval(pg_get_serial_sequence('otp_log', 'otp_id'), COALESCE(MAX(otp_id), 1) + 1, false) FROM otp_log`;
    await sql`SELECT setval(pg_get_serial_sequence('associate_referral_links', 'id'), COALESCE(MAX(id), 1) + 1, false) FROM associate_referral_links`;
    return res.json({ success: true, message: 'Sequences synced successfully' });
  } catch (err) {
    return res.json({ success: false, error: err.message, stack: err.stack });
  }
});

router.post(['/resend-email-otp'], async (req, res) => {
  try {
    const email = req.body.email ? normalizeEmail(req.body.email) : '';
    const rawMobile = req.body.mobile || req.body.mobile_no || '';
    const cleanMobile = rawMobile ? String(rawMobile).replace(/\D/g, '').slice(-10) : '';

    const pending = await findPendingRegistration(email, cleanMobile);
    if (!pending) return err(res, 'No pending registration found.', 404);

    const lookupKey = pending.email || cleanMobile;
    if (!(await canResend(lookupKey))) {
      return err(res, 'Please wait 3 minutes before requesting a new OTP', 429);
    }

    const emailOtp = genOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await sql`
      UPDATE pending_registrations
      SET email_otp_code = ${emailOtp}, otp_code = ${emailOtp}, email_otp_attempts = 0, email_otp_expires_at = ${expires}, updated_at = NOW()
      WHERE email = ${pending.email}`;

    await sendEmail(pending.email, 'Your MMR verification OTP', otpEmailHtml(emailOtp, 'Verification'));

    return ok(res, { email: pending.email }, 'New OTP sent to your email address.');
  } catch (e) {
    console.error('[resend-email-otp error]:', e);
    return err(res, e.message);
  }
});

router.post(['/resend-sms-otp', '/resend-contact-otp', '/resend-mobile-otp'], async (req, res) => {
  try {
    const email = req.body.email ? normalizeEmail(req.body.email) : '';
    const rawMobile = req.body.mobile || req.body.mobile_no || '';
    const cleanMobile = rawMobile ? String(rawMobile).replace(/\D/g, '').slice(-10) : '';

    const pending = await findPendingRegistration(email, cleanMobile);
    if (!pending) return err(res, 'No pending registration found.', 404);

    const lookupKey = `${pending.email || cleanMobile}-sms`;
    if (!(await canResend(lookupKey))) {
      return err(res, 'Please wait 3 minutes before requesting a new SMS OTP', 429);
    }

    const smsOtp = genOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await sql`
      UPDATE pending_registrations
      SET sms_otp_code = ${smsOtp}, sms_otp_attempts = 0, sms_otp_expires_at = ${expires}, updated_at = NOW()
      WHERE email = ${pending.email}`;

    if (pending.mobile_no) {
      await twoFactorService.sendCustomOtp({
        mobile: pending.mobile_no,
        otp: smsOtp,
        template: 'OTP Verification',
        purpose: 'Registration'
      });
    }

    return ok(res, { mobile: pending.mobile_no }, 'New OTP sent via SMS to your contact number.');
  } catch (e) {
    console.error('[resend-sms-otp error]:', e);
    return err(res, e.message);
  }
});

router.post(['/resend-otp'], async (req, res) => {
  try {
    const authSettings = await getAppAuthSettingsRow();
    const isEmailOtpEnabled = authSettings?.email_otp_enabled !== false;
    const isSmsOtpEnabled = Boolean(authSettings?.sms_otp_enabled);

    if (!isEmailOtpEnabled && !isSmsOtpEnabled) {
      return ok(res, { otpBypassed: true }, 'OTP verification is disabled.');
    }

    const email = req.body.email ? normalizeEmail(req.body.email) : '';
    const rawMobile = req.body.mobile || req.body.mobile_no || '';
    const cleanMobile = rawMobile ? String(rawMobile).replace(/\D/g, '').slice(-10) : '';

    const pending = await findPendingRegistration(email, cleanMobile);
    if (!pending) return err(res, 'No pending registration found.', 404);

    const lookupKey = pending.email || cleanMobile;
    if (!(await canResend(lookupKey))) {
      return err(res, 'Please wait 3 minutes before requesting a new OTP', 429);
    }

    const emailOtp = genOTP();
    const smsOtp = genOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await sql`
      UPDATE pending_registrations
      SET otp_code = ${emailOtp}, email_otp_code = ${emailOtp}, sms_otp_code = ${smsOtp},
          attempts = 0, email_otp_attempts = 0, sms_otp_attempts = 0,
          expires_at = ${expires}, email_otp_expires_at = ${expires}, sms_otp_expires_at = ${expires},
          updated_at = NOW()
      WHERE email = ${pending.email}`;

    if (isEmailOtpEnabled && pending.email && !pending.email_verified) {
      try {
        await sendEmail(pending.email, 'Your MMR verification OTP', otpEmailHtml(emailOtp, 'Verification'));
      } catch (mailErr) {
        console.warn('[Resend OTP Email Error]:', mailErr.message);
      }
    }

    if (isSmsOtpEnabled && pending.mobile_no && !pending.mobile_verified) {
      try {
        await twoFactorService.sendCustomOtp({
          mobile: pending.mobile_no,
          otp: smsOtp,
          template: 'OTP Verification',
          purpose: 'Registration'
        });
      } catch (smsErr) {
        console.warn('[Resend OTP SMS Error]:', smsErr.message);
      }
    }

    return ok(res, { email: pending.email, mobile: pending.mobile_no }, 'New OTPs have been sent.');
  } catch (e) {
    console.error('[resend-otp error]:', e);
    return err(res, e.message);
  }
});

// Safe insert helper in authEmailRoutes
const safeInsertOtpLogRoute = async (userType, refId, mobile, otpCode, purpose, expiresAt) => {
  try {
    const [maxRow] = await sql`SELECT COALESCE(MAX(otp_id), 0) + 1 AS next_id FROM otp_log`;
    const nextId = Number(maxRow?.next_id || 1);
    await sql`
      INSERT INTO otp_log (otp_id, user_type, reference_id, mobile, otp_code, purpose, expires_at)
      VALUES (${nextId}, ${userType}, ${refId}, ${mobile}, ${otpCode}, ${purpose}, ${expiresAt})`;
  } catch (e) {
    if (e.message && (e.message.includes("otp_log_pkey") || e.message.includes("unique constraint") || e.message.includes("duplicate key"))) {
      const [maxRow2] = await sql`SELECT COALESCE(MAX(otp_id), 0) + 10 AS next_id FROM otp_log`;
      const nextId2 = Number(maxRow2?.next_id || 100);
      await sql`
        INSERT INTO otp_log (otp_id, user_type, reference_id, mobile, otp_code, purpose, expires_at)
        VALUES (${nextId2}, ${userType}, ${refId}, ${mobile}, ${otpCode}, ${purpose}, ${expiresAt})`;
    } else {
      await sql`
        INSERT INTO otp_log (user_type, reference_id, mobile, otp_code, purpose, expires_at)
        VALUES (${userType}, ${refId}, ${mobile}, ${otpCode}, ${purpose}, ${expiresAt})`;
    }
  }
};

// Forgot Password - Send OTP via approved 2Factor SMS Template & Email
router.post('/forgot-password', async (req, res) => {
  try {
    const rawInput = String(req.body.email || req.body.mobile_no || req.body.identifier || '').trim();
    if (!rawInput) return err(res, 'Email or Mobile number required', 400);

    const isEmailInput = rawInput.includes('@');
    const emailInput = isEmailInput ? rawInput.toLowerCase() : '';
    const cleanDigits = !isEmailInput ? rawInput.replace(/\D/g, '') : '';
    const cleanMobile = cleanDigits.length >= 10 ? cleanDigits.slice(-10) : '';

    const [user] = isEmailInput
      ? await sql`SELECT user_id, full_name, email, mobile_no FROM users WHERE LOWER(email) = ${emailInput} LIMIT 1`
      : await sql`SELECT user_id, full_name, email, mobile_no FROM users WHERE RIGHT(regexp_replace(mobile_no, '\\D', '', 'g'), 10) = ${cleanMobile} OR LOWER(email) = ${rawInput.toLowerCase()} LIMIT 1`;

    if (!user) {
      const [investor] = isEmailInput
        ? await sql`SELECT id, full_name, email, mobile_number FROM investor_users WHERE LOWER(email) = ${emailInput} AND deleted_at IS NULL LIMIT 1`
        : await sql`SELECT id, full_name, email, mobile_number FROM investor_users WHERE RIGHT(regexp_replace(mobile_number, '\\D', '', 'g'), 10) = ${cleanMobile} AND deleted_at IS NULL LIMIT 1`;

      if (investor) {
        const resetEmail = String(investor.email || '').toLowerCase().trim();
        const investorPhone = investor.mobile_number;
        const otp = genOTP();
        const expires = new Date(Date.now() + 15 * 60 * 1000);
        await sql`UPDATE investor_users SET reset_otp = ${otp}, reset_otp_expires = ${expires} WHERE id = ${investor.id}`;

        if (investorPhone) {
          try {
            await twoFactorService.sendForgotPasswordOtp({
              mobile: investorPhone,
              otp,
            });
          } catch (smsErr) {
            console.warn('[Investor Forgot-Password SMS Note]:', smsErr.message);
          }
        }

        if (resetEmail) {
          try {
            await sendEmail(resetEmail, 'MMR Investor Password Reset OTP', otpEmailHtml(otp, 'Password Reset'));
          } catch (mailErr) {}
        }

        return ok(res, { email: resetEmail || investorPhone, user_type: 'Investor' }, 'Password reset OTP sent successfully via SMS text message.');
      }

      return err(res, 'Account not found with this email / phone', 404);
    }

    const userPhone = user.mobile_no;
    const userEmail = user.email ? String(user.email).toLowerCase().trim() : null;
    const resetIdentifier = userEmail || userPhone || cleanMobile;
    const otp = genOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await sql`UPDATE otp_log SET is_used = TRUE WHERE (mobile = ${resetIdentifier} OR mobile = ${userEmail || ''} OR mobile = ${userPhone || ''}) AND purpose = 'ResetPassword' AND is_used = FALSE`;
    
    if (userPhone) {
      await safeInsertOtpLogRoute('User', user.user_id, userPhone, otp, 'ResetPassword', expiresAt);
    }
    if (userEmail && userEmail !== userPhone) {
      await safeInsertOtpLogRoute('User', user.user_id, userEmail, otp, 'ResetPassword', expiresAt);
    }

    // Send SMS OTP via 2Factor approved template: /SMS/{phone}/{otp}/Forgot+Password+OTP
    if (userPhone) {
      try {
        await twoFactorService.sendForgotPasswordOtp({
          mobile: userPhone,
          otp,
        });
      } catch (smsErr) {
        console.warn('[User Forgot-Password SMS Note]:', smsErr.message);
      }
    }

    if (userEmail) {
      try {
        await sendEmail(userEmail, 'MMR Password Reset OTP', otpEmailHtml(otp, 'Password Reset'));
      } catch (mailErr) {}
    }

    return ok(res, { email: userEmail || userPhone, mobile_no: userPhone }, 'Password reset OTP sent successfully via SMS text message.');
  } catch (e) {
    return err(res, e.message);
  }
});

// Reset Password
router.post('/reset-password', async (req, res) => {
  try {
    const email = String(req.body.email || req.body.identifier || '').toLowerCase().trim();
    const { otp_code, otp, new_password } = req.body;
    const rawOtp = String(otp_code || otp || '').trim();

    if (!email || !rawOtp || !new_password) {
      return err(res, 'email, otp, and new_password required', 400);
    }
    if (String(new_password).length < 8) {
      return err(res, 'New password minimum 8 characters required', 400);
    }

    const [investor] = await sql`
      SELECT id, reset_otp, reset_otp_expires FROM investor_users
      WHERE LOWER(email) = ${email} AND deleted_at IS NULL LIMIT 1`;

    if (investor && investor.reset_otp === rawOtp && new Date() <= new Date(investor.reset_otp_expires)) {
      const salt = await bcrypt.genSalt(10);
      const password_hash = await bcrypt.hash(new_password, salt);
      await sql`
        UPDATE investor_users
        SET password_hash = ${password_hash}, reset_otp = NULL, reset_otp_expires = NULL, updated_at = NOW()
        WHERE id = ${investor.id}`;
      return ok(res, {}, 'Password reset successfully');
    }

    const [otpRow] = await sql`
      SELECT * FROM otp_log
      WHERE mobile = ${email} AND otp_code = ${rawOtp} AND purpose = 'ResetPassword'
        AND is_used = FALSE AND expires_at > NOW()
      ORDER BY otp_id DESC LIMIT 1`;

    if (!otpRow) {
      return err(res, 'Invalid or expired OTP. Please request a new OTP.', 400);
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(new_password, salt);

    await sql`
      UPDATE users
      SET password_hash = ${password_hash}, updated_at = NOW()
      WHERE LOWER(email) = ${email}`;

    await sql`UPDATE otp_log SET is_used = TRUE WHERE otp_id = ${otpRow.otp_id}`;

    return ok(res, {}, 'Password reset successfully');
  } catch (e) {
    return err(res, e.message);
  }
});

// Clear OTP Logs
router.post('/clear-otp-logs', async (_req, res) => {
  try {
    try {
      await sql`TRUNCATE TABLE otp_log RESTART IDENTITY CASCADE`;
    } catch (e1) {
      await sql`DELETE FROM otp_log`;
      try {
        await sql`SELECT setval(pg_get_serial_sequence('otp_log', 'otp_id'), 1, false)`;
      } catch (seqErr) {}
    }
    return ok(res, {}, 'All OTP logs deleted successfully from database.');
  } catch (e) {
    return err(res, e.message);
  }
});

export default router;
