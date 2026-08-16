import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import sql from '../db.js';
import { sendEmail, otpEmailHtml } from '../emailService.js';

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

  return 'Registration conflict detected. Please start registration again.';
};

let pendingTableReady = false;

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

  await ensureReferralLinkTable();

  const [sponsor] = await sql`
    SELECT DISTINCT u.user_id, u.full_name, u.member_id, u.invitation_code
    FROM users u
    LEFT JOIN associate_referral_links l
      ON l.associate_user_id = u.user_id
      AND l.is_active = TRUE
    WHERE u.account_status = 'Active'
      AND u.user_type = 'Associate'
      AND (
        UPPER(COALESCE(u.invitation_code, '')) = ${sponsorCode}
        OR UPPER(COALESCE(u.member_id, '')) = ${sponsorCode}
        OR UPPER(regexp_replace(COALESCE(u.member_id, ''), '^MMR-[AC]-', 'MMR')) = ${sponsorCode}
        OR UPPER(COALESCE(l.invite_code, '')) = ${sponsorCode}
      )
    LIMIT 1`;

  return sponsor || null;
}

router.get('/verify-sponsor/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const sponsor = await findSponsorByCode(code);
    if (!sponsor) {
      return res.status(404).json({
        success: false,
        message: 'Invalid sponsor code. No active associate found with this code.',
      });
    }
    return ok(res, {
      valid: true,
      user_id: sponsor.user_id,
      full_name: sponsor.full_name,
      member_id: sponsor.member_id,
      invitation_code: sponsor.invitation_code || sponsor.member_id,
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
  return (Date.now() - new Date(last.updated_at).getTime()) > 60_000;
}

async function createUserWithUniqueMemberId(db, pending) {
  await db`SELECT pg_advisory_xact_lock(hashtext('users_member_id_registration'))`;
  const [sequence] = await db`
    SELECT COALESCE(MAX(
      CASE
        WHEN member_id ~ '^MMR[0-9]+$'
          THEN SUBSTRING(member_id FROM 4)::integer
        WHEN member_id ~ '^MMR-[AC]-[0-9]+$'
          THEN SUBSTRING(member_id FROM 7)::integer
        ELSE 0 END
    ), 0) + 1 AS next_value
    FROM users`;
  const memberId = `MMR${String(Number(sequence?.next_value || 1)).padStart(5, '0')}`;
  let created;
  try {
    [created] = await db`
      INSERT INTO users (
        user_type, full_name, mobile_no, email,
        password_hash, sponsor_user_id, member_id,
        account_status, email_verified, email_verified_at, is_otp_verified
      ) VALUES (
        ${pending.user_type}, ${pending.full_name}, ${pending.mobile_no}, ${pending.email},
        ${pending.password_hash}, ${pending.sponsor_user_id}, ${memberId},
        ${pending.user_type === 'Customer' ? 'Active' : 'Pending'}, TRUE, NOW(), TRUE
      )
      RETURNING user_id, full_name, email, user_type, member_id, invitation_code`;
  } catch (err) {
    if (String(err?.message || '').includes('invitation_code')) {
      [created] = await db`
        INSERT INTO users (
          user_type, full_name, mobile_no, email,
          password_hash, sponsor_user_id, member_id,
          account_status, email_verified, email_verified_at, is_otp_verified
        ) VALUES (
          ${pending.user_type}, ${pending.full_name}, ${pending.mobile_no}, ${pending.email},
          ${pending.password_hash}, ${pending.sponsor_user_id}, ${memberId},
          ${pending.user_type === 'Customer' ? 'Active' : 'Pending'}, TRUE, NOW(), TRUE
        )
        RETURNING user_id, full_name, email, user_type, member_id`;
    } else {
      throw err;
    }
  }
  return created;
}

async function validateSignupInput(body) {
  const userType = body.user_type || 'Customer';
  const email = normalizeEmail(body.email);
  const mobileNo = normalizeMobileNo(body.mobile_no);
  const DEFAULT_SPONSOR_CODE = 'MMR0001';
  const effectiveSponsorCode = normalizeSponsorCode(body.sponsor_invite_code) || DEFAULT_SPONSOR_CODE;
  const fullName = body.full_name?.trim();
  const validationErrors = [];

  console.log('[Associate Registration] Validating signup input...', {
    user_type: userType,
    email,
    mobile_no: mobileNo,
    full_name_present: Boolean(fullName),
    sponsor_invite_code: effectiveSponsorCode,
  });

  if (!fullName) validationErrors.push('Full name is required');
  if (!email || !isEmail(email)) validationErrors.push('Valid email address is required');
  if (!mobileNo || !isMobile(mobileNo)) {
    validationErrors.push('Valid 10-digit mobile number is required');
  }
  if (!body.password || body.password.length < 6) {
    validationErrors.push('Password must be at least 6 characters');
  }
  if (!['Customer', 'Associate', 'Investor'].includes(userType)) {
    validationErrors.push('user_type must be Customer, Associate, or Investor');
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

  console.log('[Associate Registration] Validating sponsor invite code...', { effectiveSponsorCode });
  const sponsor = await findSponsorByCode(effectiveSponsorCode);
  if (!sponsor) {
    console.error('[Associate Registration] Invalid sponsor invitation code:', {
      sponsor_invite_code: effectiveSponsorCode,
    });
    return { error: 'Invalid sponsor code. Associate sponsor not found or inactive.', status: 400 };
  }
  const sponsorUserId = sponsor.user_id;
  console.log('[Associate Registration] Sponsor found:', { sponsor_user_id: sponsorUserId, full_name: sponsor.full_name });

  console.log('[Associate Registration] Validation Passed');

  return {
    value: {
      userType,
      email,
      mobileNo,
      fullName,
      password: body.password,
      sponsorUserId,
      sponsorInviteCode: effectiveSponsorCode,
      optionalData: {},
    },
  };
}

router.post('/register-quick', async (req, res) => {
  const requestId = `reg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    console.log(`[Associate Registration:${requestId}] Request received`);
    console.log(`[Associate Registration:${requestId}] Request Body:`, sanitizeBody(req.body));
    console.log(`[Associate Registration:${requestId}] Authenticated User:`, req.user || null);
    console.log(`[Associate Registration:${requestId}] Files Received:`, describeFiles(req.files));
    console.log(`[Associate Registration:${requestId}] Database connection check...`);
    await sql`SELECT 1`;
    console.log(`[Associate Registration:${requestId}] Database connection OK`);

    const validation = await validateSignupInput(req.body);
    if (validation.error) {
      console.error(`[Associate Registration:${requestId}] Validation Failed:`, {
        message: validation.error,
        validationErrors: validation.validationErrors,
        status: validation.status || 400,
      });
      return err(res, validation.error, validation.status || 400);
    }

    await ensurePendingRegistrationTable();
    console.log(`[Associate Registration:${requestId}] Pending registration table ensured`);

    const {
      userType,
      email,
      mobileNo,
      fullName,
      password,
      sponsorUserId,
      sponsorInviteCode,
      optionalData,
    } = validation.value;

    const otp = genOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    console.log(`[Associate Registration:${requestId}] Hashing password...`);
    const passwordHash = await bcrypt.hash(password, 12);
    console.log(`[Associate Registration:${requestId}] Password hashed`);

    console.log(`[Associate Registration:${requestId}] Removing old pending registration records...`);
    await sql`
      DELETE FROM pending_registrations
      WHERE email = ${email} OR mobile_no = ${mobileNo}`;
    console.log(`[Associate Registration:${requestId}] Old pending registration cleanup complete`);

    console.log(`[Associate Registration:${requestId}] Creating Associate Record...`, {
      user_type: userType,
      email,
      mobile_no: mobileNo,
      sponsor_user_id: sponsorUserId,
      expires_at: expires,
    });
    await sql`
      INSERT INTO pending_registrations (
        email, mobile_no, user_type, full_name, password_hash,
        sponsor_user_id, sponsor_invite_code, optional_data, otp_code, expires_at
      ) VALUES (
        ${email}, ${mobileNo}, ${userType}, ${fullName}, ${passwordHash},
        ${sponsorUserId}, ${sponsorInviteCode}, ${sql.json(optionalData)}, ${otp}, ${expires}
      )`;
    console.log(`[Associate Registration:${requestId}] Associate pending record created`);

    console.log(`[Associate Registration:${requestId}] Sending OTP email...`, { email });
    await sendEmail(email, 'Verify your MMR account', otpEmailHtml(otp, 'Verification'));
    console.log(`[Associate Registration:${requestId}] OTP email sent`);

    const responseData = { email, user_type: userType };
    console.log(`[Associate Registration:${requestId}] Registration Successful`, responseData);
    return ok(
      res,
      responseData,
      'OTP sent to your email. Verify OTP to complete registration.',
    );
  } catch (e) {
    logRegistrationError(`[Associate Registration:${requestId}] Associate Registration Error`, e);

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

    return err(res, e.message || 'Associate registration failed');
  }
});

router.post('/send-email-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email || !isEmail(email)) return err(res, 'Valid email required', 400);

    await ensurePendingRegistrationTable();

    const [pending] = await sql`
      SELECT email FROM pending_registrations
      WHERE email = ${email}`;
    if (!pending) return err(res, 'Start registration before requesting OTP', 404);

    if (!(await canResend(email))) {
      return err(res, 'Please wait 60 seconds before requesting a new OTP', 429);
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

router.post('/verify-email-otp', async (req, res) => {
  try {
    await ensurePendingRegistrationTable();

    const email = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || '').trim();
    if (!email || !otp) return err(res, 'email and otp are required', 400);

    const [pending] = await sql`
      SELECT * FROM pending_registrations
      WHERE email = ${email}`;

    if (!pending) return err(res, 'No pending registration found. Please sign up again.', 400);
    if (pending.attempts >= 5) {
      await sql`DELETE FROM pending_registrations WHERE email = ${email}`;
      return err(res, 'Too many OTP attempts. Please sign up again.', 429);
    }
    if (new Date() > new Date(pending.expires_at)) {
      await sql`DELETE FROM pending_registrations WHERE email = ${email}`;
      return err(res, 'OTP expired. Please sign up again.', 400);
    }
    if (pending.otp_code !== otp) {
      await sql`
        UPDATE pending_registrations
        SET attempts = attempts + 1, updated_at = NOW()
        WHERE email = ${email}`;
      return err(res, 'Invalid OTP. Please check and try again.', 400);
    }

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

      const [createdInvestor] = await sql`
        INSERT INTO investor_users (
          full_name, mobile_number, email, password_hash, status, is_verified, created_at, updated_at
        ) VALUES (
          ${pending.full_name}, ${pending.mobile_no}, ${pending.email}, ${pending.password_hash},
          'active', true, NOW(), NOW()
        )
        RETURNING id, full_name, email, mobile_number, status, is_verified`;

      await sql`DELETE FROM pending_registrations WHERE email = ${email}`;

      return ok(res, {
        user: {
          id: createdInvestor.id,
          full_name: createdInvestor.full_name,
          email: createdInvestor.email,
          mobile_number: createdInvestor.mobile_number,
          user_type: 'Investor',
        }
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
          console.warn('[verify-email-otp] optional user_addresses insert warning:', addrErr.message);
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
            VALUES (${pending.sponsor_user_id}, ${createdUser.user_id}, ${pending.sponsor_invite_code}, 'Signup', 'Approved', NOW())
            ON CONFLICT (referred_user_id) DO UPDATE SET status = 'Approved', approved_at = NOW()`;
        } catch (refErr) {
          console.warn('[verify-email-otp] referral_registrations warning:', refErr.message);
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
          console.warn('[verify-email-otp] associate_referral_links warning:', linkErr.message);
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
              COALESCE((SELECT level FROM mlm_network WHERE associate_user_id = ${pending.sponsor_user_id}), 0) + 1)
            ON CONFLICT (associate_user_id) DO NOTHING`;
        } catch (mlmErr) {
          console.warn('[verify-email-otp] mlm_network warning:', mlmErr.message);
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
          console.warn('[verify-email-otp] mlm_tree_closure warning:', treeErr.message);
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
          console.warn('[verify-email-otp] mlm_tree_closure self warning:', treeErr.message);
        }
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
             'Auth', 'RegisteredAfterEmailOtp', 'users', ${createdUser.user_id})`;
      } catch (auditErr) {
        console.warn('[verify-email-otp] audit_log warning:', auditErr.message);
      }

      return createdUser;
    });

    const payload = {
      user_id: newUser.user_id,
      user_type: newUser.user_type,
      member_id: newUser.member_id,
      email: newUser.email,
    };
    const jwtSecret = process.env.JWT_SECRET || 'mmr_constructions_jwt_secret_2026_key';
    const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || jwtSecret;
    const token = jwt.sign(payload, jwtSecret, {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    });
    const refreshToken = jwt.sign(payload, jwtRefreshSecret, {
      expiresIn: '30d',
    });

    return ok(res, {
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
      },
      redirect: newUser.user_type === 'Associate' ? '/associate/dashboard' : '/user/dashboard',
    }, pending.user_type === 'Customer'
      ? 'Email verified. Your customer account is active.'
      : 'Email verified. Registration completed and is pending admin approval.');
  } catch (e) {
    logRegistrationError('[verify-email-otp]', e);
    if (e?.status) return err(res, e.message, e.status);
    if (e?.code === '23505') {
      return err(res, registrationConflictMessage(e), 409);
    }
    const cleanMsg = e?.message ? String(e.message).slice(0, 200) : 'Unable to complete registration right now. Please try again.';
    return err(res, cleanMsg, 500);
  }
});

router.get('/verify-email-otp', (_req, res) => {
  return ok(res, null, 'Email verification endpoint requires HTTP POST with email and OTP');
});

router.post('/resend-email-otp', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!email || !isEmail(email)) return err(res, 'Valid email required', 400);

    await ensurePendingRegistrationTable();

    const [pending] = await sql`
      SELECT email FROM pending_registrations
      WHERE email = ${email}`;
    if (!pending) return err(res, 'No pending registration found. Please sign up again.', 404);

    if (!(await canResend(email))) {
      return err(res, 'Please wait 60 seconds before requesting a new OTP', 429);
    }

    const otp = genOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await sql`
      UPDATE pending_registrations
      SET otp_code = ${otp}, attempts = 0, expires_at = ${expires}, updated_at = NOW()
      WHERE email = ${email}`;

    await sendEmail(email, 'Your MMR verification OTP', otpEmailHtml(otp, 'Verification'));

    return ok(res, { email }, 'OTP resent to email');
  } catch (e) {
    console.error('[resend-email-otp]', e);
    return err(res, e.message);
  }
});

export default router;
